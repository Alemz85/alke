#!/usr/bin/env python3
"""Collapse workout rows that are the same session ingested under two HealthKit UUIDs.

Apple Health can *replace* a workout object: the original HKWorkout is deleted
and an identical one is re-created under a fresh UUID. Strava's write-back does
this (it rewrites its own Health entry after server-side processing). Our ingest
keys idempotency on `workouts.external_id` = that UUID, so the replacement looks
like a brand-new workout and gets inserted alongside the original — which then
double-counts into the day's TRIMP in metrics/compute.py.

`supabase/functions/ingest` now adopts the replacement onto the existing row, so
new occurrences shouldn't reach the DB. This script cleans up rows that landed
before that fix, and stays around as the remedy if a novel replacement shape
ever slips through.

Which row wins is decided by evidence, never by a guess: for each duplicate
group we look up when each external_id was last seen in a raw_payloads delivery.
The UUID HAE is still sending is the one that still exists in HealthKit; the
others are orphans. A group where the evidence is missing or tied is reported
and skipped.

Losers are dumped to backups/stale_workouts/ before deletion. `injury_notes` and
`gym_sessions` reference workouts with ON DELETE SET NULL, so those are
repointed at the keeper first — everything else cascades.

Usage:
    python3 scripts/dedupe_replaced_workouts.py            # dry run, prints the plan
    python3 scripts/dedupe_replaced_workouts.py --apply    # execute it

Credentials come from ./.env (SUPABASE_URL, SUPABASE_SERVICE_KEY).
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKUP_DIR = REPO_ROOT / "backups" / "stale_workouts"

# Child tables that cascade on delete; backed up so a mistaken collapse is
# recoverable without digging the payload back out of raw_payloads.
CHILD_TABLES = (
    "workout_hr_samples",
    "workout_route_points",
    "workout_geo",
    "computed_workout",
    "workout_swim_samples",
    "swim_sets",
)
# Tables whose FK is ON DELETE SET NULL: repoint at the keeper or the link is
# silently lost (injury_notes carries hand-written clinical context).
REPOINT_TABLES = ("injury_notes", "gym_sessions")

DUPLICATE_GROUPS_SQL = """
SELECT type,
       start_at,
       count(*)                AS n,
       array_agg(id::text)     AS ids,
       array_agg(external_id)  AS external_ids
FROM workouts
GROUP BY type, start_at
HAVING count(*) > 1
ORDER BY start_at
"""

# Last delivery that mentioned each external_id. raw_payloads.payload is jsonb;
# the ::text LIKE is a crude but index-free containment check that is plenty
# fast at this table's size and avoids assuming the payload's nesting shape.
LAST_SEEN_SQL = """
SELECT max(received_at) AS last_seen
FROM raw_payloads
WHERE payload::text LIKE '%{external_id}%'
"""


def load_env() -> dict:
    env = {}
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not env.get(key) and os.environ.get(key):
            env[key] = os.environ[key]
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not env.get(k)]
    if missing:
        sys.exit(f"missing {', '.join(missing)} — set them in .env or the environment")
    return env


ENV = load_env()
HEADERS = {
    "apikey": ENV["SUPABASE_SERVICE_KEY"],
    "Authorization": f"Bearer {ENV['SUPABASE_SERVICE_KEY']}",
    "Content-Type": "application/json",
}


def query(sql: str) -> list[dict]:
    """Run read-only SQL through the same RPC chatctx/db.py uses."""
    req = urllib.request.Request(
        f"{ENV['SUPABASE_URL']}/rest/v1/rpc/exec_readonly_sql",
        data=json.dumps({"query": sql.rstrip().rstrip(";")}).encode(),
        headers=HEADERS,
    )
    return _send(req)


def rest(method: str, path: str, body=None) -> list[dict]:
    req = urllib.request.Request(
        f"{ENV['SUPABASE_URL']}/rest/v1/{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={**HEADERS, "Prefer": "return=representation"},
    )
    return _send(req)


def _send(req) -> list[dict]:
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
        return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        sys.exit(f"{req.get_method()} {req.full_url} failed: {detail}")


def last_seen(external_id: str) -> str | None:
    rows = query(LAST_SEEN_SQL.format(external_id=external_id))
    return rows[0]["last_seen"] if rows else None


def plan_group(group: dict) -> tuple[str, list[str], list[str]]:
    """Return (keeper_id, loser_ids, notes) for one duplicate group."""
    ids = group["ids"]
    external_ids = group["external_ids"]
    seen = {ext: last_seen(ext) for ext in external_ids}

    notes = [f"  {ext}  last delivered: {seen[ext] or 'never'}" for ext in external_ids]

    dated = [(ext, ts) for ext, ts in seen.items() if ts]
    if not dated:
        return "", [], notes + ["  SKIP: no delivery evidence for any row"]
    newest = max(ts for _, ts in dated)
    winners = [ext for ext, ts in dated if ts == newest]
    if len(winners) > 1:
        return "", [], notes + ["  SKIP: tied — all still delivered, not a replacement"]

    keeper_ext = winners[0]
    by_ext = dict(zip(external_ids, ids))
    keeper_id = by_ext[keeper_ext]
    loser_ids = [i for i in ids if i != keeper_id]
    return keeper_id, loser_ids, notes


def backup(workout_id: str) -> pathlib.Path:
    workout = rest("GET", f"workouts?id=eq.{workout_id}")
    dump = {"workout": workout}
    for table in CHILD_TABLES:
        dump[table] = rest("GET", f"{table}?workout_id=eq.{workout_id}")
    for table in REPOINT_TABLES:
        dump[table] = rest("GET", f"{table}?workout_id=eq.{workout_id}")

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = (workout[0]["start_at"][:10] if workout else "unknown")
    ext = (workout[0]["external_id"].split("-")[0] if workout else workout_id[:8])
    path = BACKUP_DIR / f"{stamp}-{workout[0].get('type', 'workout')}-{ext}.json"
    path.write_text(json.dumps(dump, indent=2))
    return path


def collapse(keeper_id: str, loser_ids: list[str]) -> None:
    for loser in loser_ids:
        path = backup(loser)
        print(f"    backed up -> {path.relative_to(REPO_ROOT)}")
        for table in REPOINT_TABLES:
            moved = rest("PATCH", f"{table}?workout_id=eq.{loser}", {"workout_id": keeper_id})
            if moved:
                print(f"    repointed {len(moved)} {table} row(s) -> {keeper_id}")
        rest("DELETE", f"workouts?id=eq.{loser}")
        print(f"    deleted {loser}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="execute (default is a dry run)")
    args = ap.parse_args()

    groups = query(DUPLICATE_GROUPS_SQL)
    if not groups:
        print("no duplicate workouts — nothing to do")
        return

    print(f"{len(groups)} duplicate group(s)\n")
    actionable = 0
    for g in groups:
        print(f"{g['start_at']}  {g['type']}  ({g['n']} rows)")
        keeper_id, loser_ids, notes = plan_group(g)
        for line in notes:
            print(line)
        if not keeper_id:
            print()
            continue
        actionable += 1
        print(f"  KEEP   {keeper_id}")
        for loser in loser_ids:
            print(f"  DELETE {loser}")
        if args.apply:
            collapse(keeper_id, loser_ids)
        print()

    if not args.apply:
        print(f"dry run — {actionable} group(s) would be collapsed. Re-run with --apply.")
    else:
        print(f"collapsed {actionable} group(s).")
        print("Run `python -m metrics.compute` (or wait for the nightly) to rebuild the daily series.")


if __name__ == "__main__":
    main()
