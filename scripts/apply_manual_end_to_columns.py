#!/usr/bin/env python3
"""Push `workouts.manual_end_at` down into the ingested columns it corrects.

WHY THIS EXISTS. `manual_end_at` (migration 20260910140000) is an OVERLAY: the
metrics job truncates at it on every run, so training load is already correct
without touching anything. But nothing else reads it — the desktop app renders
`duration_s`/`distance_m` straight from the row, so a corrected session still
displays the device's inflated figures. This script writes the correction into
those columns so every reader agrees.

WHY IT NEEDS RE-RUNNING. Ingest upserts on `external_id` and rewrites exactly
these columns, so a Health Auto Export re-delivery reverts whatever this wrote.
That window is bounded and short: across 12 consecutive sessions sampled on
2026-09-10, the LAST delivery of any workout landed 23.7-33.1 h after it
started, never beyond ~34 h. HAE re-sends a rolling date range, and a session
that ages out of it is never sent again. So re-run this for ~2 days after a
correction, then stop; it never needs to run forever.

`manual_end_at` itself is never at risk — ingest cannot write any `manual_*`
column (asserted by parse_test.ts) — so a revert costs display accuracy, never
the correction itself, and this script restores it from that surviving column.

Idempotent and safe to run any number of times: it writes only workouts whose
columns actually disagree with their `manual_end_at`, and only ever shortens.

Usage:
    python3 scripts/apply_manual_end_to_columns.py            # dry run
    python3 scripts/apply_manual_end_to_columns.py --apply    # execute

Credentials come from ./.env (SUPABASE_URL, SUPABASE_SERVICE_KEY).
"""

import datetime
import json
import pathlib
import sys
import urllib.request


def load_env() -> dict:
    env = {}
    path = pathlib.Path(__file__).resolve().parent.parent / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def request(url: str, key: str, path: str, method: str = "GET", body=None):
    req = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    with urllib.request.urlopen(req) as response:
        return json.load(response)


def parse_ts(value: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def main() -> None:
    apply = "--apply" in sys.argv
    env = load_env()
    try:
        url, key = env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"]
    except KeyError:
        sys.exit("missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env")

    corrected = request(
        url,
        key,
        "workouts?manual_end_at=not.is.null"
        "&select=id,type,start_at,end_at,duration_s,distance_m,manual_end_at"
        "&order=start_at.desc",
    )
    if not corrected:
        print("no workouts carry a manual_end_at correction; nothing to do")
        return

    pending = []
    for workout in corrected:
        cutoff = (
            parse_ts(workout["manual_end_at"]) - parse_ts(workout["start_at"])
        ).total_seconds()
        if cutoff <= 0:
            print(f"! {workout['id']}: manual_end_at is not after start_at; skipped")
            continue
        current = workout["duration_s"]
        # Only ever shortens — matches models.truncate_workout_at_manual_end.
        if current is not None and cutoff >= float(current):
            continue

        # Swim sets carry sub-workout distance blocks, so a corrected distance is
        # exactly the kept sets' sum. Without them the distance at the cutoff is
        # unknowable and is cleared rather than guessed, exactly as the metrics
        # overlay does.
        sets = request(
            url,
            key,
            f"swim_sets?workout_id=eq.{workout['id']}&select=start_offset_s,distance_m",
        )
        distance = (
            sum(s["distance_m"] for s in sets if s["start_offset_s"] < cutoff)
            if sets
            else None
        )
        pending.append(
            (
                workout,
                {
                    "duration_s": int(cutoff),
                    "end_at": workout["manual_end_at"],
                    "distance_m": distance,
                },
            )
        )
        # A null duration_s is possible (parse.ts emits it when HAE omits the
        # figure); it is still correctable, it just has nothing to shorten FROM.
        was = f"{float(current) / 60:.1f} min" if current is not None else "unknown"
        print(
            f"{'PATCH' if apply else 'would patch'} {workout['type']} "
            f"{workout['start_at'][:10]}: "
            f"{was} -> {cutoff / 60:.1f} min"
            + (
                f", {workout['distance_m']} m -> {distance:.0f} m"
                if distance is not None
                else ""
            )
        )

    if not pending:
        print(f"{len(corrected)} corrected workout(s) checked; all columns already match")
        return
    if not apply:
        print(f"\ndry run — {len(pending)} to patch. Re-run with --apply to execute.")
        return
    for workout, patch in pending:
        request(url, key, f"workouts?id=eq.{workout['id']}", method="PATCH", body=patch)
    print(f"\npatched {len(pending)} workout(s)")


if __name__ == "__main__":
    main()
