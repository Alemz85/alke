#!/usr/bin/env python3
"""Push `workouts.manual_end_at` down into the ingested rows it corrects.

WHY THIS EXISTS. `manual_end_at` (migration 20260910140000) is an OVERLAY: the
metrics job truncates at it on every run, so training load is already correct
without touching anything. But nothing else reads it — the desktop app renders
`duration_s`/`distance_m` and the swim-set table straight from the DB, so a
corrected session still displays the device's inflated figures and its phantom
laps. This script applies the correction to the stored rows so every reader
agrees:

  * `workouts.duration_s` / `end_at` / `distance_m` — rewritten to the cutoff.
  * `swim_sets` starting at/after the cutoff — DELETED. These are the fabricated
    laps a watch logs while you climb out of the pool (one such swim had a lap
    clocked at 25 m in 11 seconds, faster than the world record).
  * `workout_swim_samples` at/after the cutoff — DELETED, same reasoning.

`workout_hr_samples` are deliberately NEVER touched. models.hrr60 reads the
stream PAST the workout end to find a recovery sample in [end+45s, end+90s], so
a mis-ended session's tail is exactly what finally makes a real HRR60 reading
possible. Deleting it would destroy a signal
the correction just created. The metrics overlay filters those samples out of
zone time on its own, so nothing needs deleting for load to be right.

Deletions are recoverable: scripts/backfill_swim_sets.ts rebuilds both swim
tables from raw_payloads, which is never pruned of these sessions.

WHY IT NEEDS RE-RUNNING. Ingest upserts on `external_id` and rewrites exactly
these columns; it also DELETE-then-INSERTs the whole swim_sets and
workout_swim_samples set for a re-delivered swim. So a Health Auto Export
re-delivery reverts everything this wrote. That window is bounded and short:
across 12 consecutive sessions sampled, the LAST delivery of any
workout landed 23.7-33.1 h after it started, never beyond ~34 h. HAE re-sends a
rolling date range, and a session that ages out of it is never sent again. So
one run after that ceiling makes the correction permanent; it never needs to
run forever.

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

    verb = "" if apply else "would "
    pending = []
    for workout in corrected:
        cutoff = (
            parse_ts(workout["manual_end_at"]) - parse_ts(workout["start_at"])
        ).total_seconds()
        if cutoff <= 0:
            print(f"! {workout['id']}: manual_end_at is not after start_at; skipped")
            continue

        wid = workout["id"]
        label = f"{workout['type']} {workout['start_at'][:10]}"
        actions = []

        # Swim sets carry sub-workout distance blocks, so a corrected distance is
        # exactly the kept sets' sum. Without them the distance at the cutoff is
        # unknowable and is cleared rather than guessed, exactly as the metrics
        # overlay does.
        sets = request(
            url, key, f"swim_sets?workout_id=eq.{wid}&select=start_offset_s,distance_m"
        )
        kept = [s for s in sets if s["start_offset_s"] < cutoff] if sets else []
        distance = sum(s["distance_m"] for s in kept) if sets else None

        current = workout["duration_s"]
        # Only ever shortens — matches models.truncate_workout_at_manual_end.
        if current is None or cutoff < float(current):
            # A null duration_s is possible (parse.ts emits it when HAE omits the
            # figure); still correctable, it just has nothing to shorten FROM.
            was = f"{float(current) / 60:.1f} min" if current is not None else "unknown"
            actions.append(
                (
                    "PATCH",
                    f"{was} -> {cutoff / 60:.1f} min"
                    + (
                        f", {workout['distance_m']:.0f} m -> {distance:.0f} m"
                        if distance is not None
                        else ""
                    ),
                    ("PATCH", f"workouts?id=eq.{wid}", {
                        "duration_s": int(cutoff),
                        "end_at": workout["manual_end_at"],
                        "distance_m": distance,
                    }),
                )
            )

        phantom_sets = len(sets) - len(kept) if sets else 0
        if phantom_sets:
            actions.append(
                (
                    "DROP",
                    f"{phantom_sets} phantom swim set(s) at/after {cutoff / 60:.1f} min",
                    ("DELETE", f"swim_sets?workout_id=eq.{wid}&start_offset_s=gte.{int(cutoff)}", None),
                )
            )

        # Same treatment for the per-second swim series. hr samples are NEVER
        # touched — hrr60 needs the post-end tail (see the module docstring).
        stale_samples = request(
            url, key,
            f"workout_swim_samples?workout_id=eq.{wid}"
            f"&offset_s=gte.{int(cutoff)}&select=offset_s&limit=1",
        )
        if stale_samples:
            actions.append(
                (
                    "DROP",
                    f"swim samples at/after {cutoff / 60:.1f} min",
                    ("DELETE", f"workout_swim_samples?workout_id=eq.{wid}&offset_s=gte.{int(cutoff)}", None),
                )
            )

        for kind, summary, op in actions:
            print(f"{verb}{kind.lower()} {label}: {summary}")
            pending.append(op)

    if not pending:
        print(f"{len(corrected)} corrected workout(s) checked; everything already matches")
        return
    if not apply:
        print(f"\ndry run — {len(pending)} change(s). Re-run with --apply to execute.")
        return
    for method, path, body in pending:
        request(url, key, path, method=method, body=body)
    print(f"\napplied {len(pending)} change(s)")


if __name__ == "__main__":
    main()
