#!/usr/bin/env python3
"""Mirror raw_payloads to local gzipped JSONL — the second copy that must
exist before any DB-side pruning is allowed (TODO #5).

The DB is currently the ONLY copy of the raw HAE payload log, which is the
source every other table derives from. This script makes a local mirror under
backups/raw_payloads/ (gitignored), one multi-member .jsonl.gz per calendar
month of `received_at`, one JSON object per row. It is strictly additive:

  - reads the remote table, appends new rows locally, never writes to the DB;
  - incremental and idempotent — state.json records the highest archived id,
    reruns fetch only rows above it (appending to gzip files is valid: gzip
    concatenation produces a readable multi-member stream);
  - ends every run by comparing local vs remote row counts, because a backup
    nobody has verified is a hope, not a copy.

Pruning itself stays deliberately OUT of this script. When retention is one
day decided, it gets its own reviewed change; this tool only guarantees the
precondition.

Usage:
  python3 scripts/archive_raw_payloads.py              # archive new rows, then verify
  python3 scripts/archive_raw_payloads.py --verify-only

Credentials resolve like the other helpers: ./.env when present, else the
process environment. Stdlib only.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
PAGE_ROWS = 200  # rows average ~27 kB; ~5 MB per page keeps requests tame
BACKUP_DIR = pathlib.Path(__file__).parent.parent / "backups" / "raw_payloads"
STATE_PATH = BACKUP_DIR / "state.json"


def load_env() -> dict:
    env = {}
    for candidate in (pathlib.Path.cwd() / ".env", pathlib.Path(__file__).parent.parent / ".env"):
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env.setdefault(key.strip(), value.strip())
            break
    for key in REQUIRED_KEYS:
        if not env.get(key) and os.environ.get(key):
            env[key] = os.environ[key]
    if not all(env.get(k) for k in REQUIRED_KEYS):
        sys.exit("missing SUPABASE_URL/SUPABASE_SERVICE_KEY — set ./.env or export them")
    return env


def _headers(env: dict) -> dict:
    return {
        "apikey": env["SUPABASE_SERVICE_KEY"],
        "Authorization": f"Bearer {env['SUPABASE_SERVICE_KEY']}",
    }


def fetch_rows(env: dict, params: dict) -> list[dict]:
    url = f"{env['SUPABASE_URL']}/rest/v1/raw_payloads?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_headers(env))
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def remote_count(env: dict) -> int:
    url = f"{env['SUPABASE_URL']}/rest/v1/raw_payloads?select=id"
    headers = {**_headers(env), "Prefer": "count=exact", "Range": "0-0"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        # content-range: "0-0/859" — the total after the slash.
        content_range = resp.headers.get("content-range") or "/0"
        return int(content_range.rsplit("/", 1)[1])


def read_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {"last_id": 0, "rows_archived": 0}


def local_row_count() -> int:
    total = 0
    for path in sorted(BACKUP_DIR.glob("*.jsonl.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            total += sum(1 for _ in handle)
    return total


def archive(env: dict) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    state = read_state()
    fetched = 0
    page_rows = PAGE_ROWS
    while True:
        try:
            rows = fetch_rows(env, {
                "select": "id,received_at,payload",
                "id": f"gt.{state['last_id']}",
                "order": "id.asc",
                "limit": str(page_rows),
            })
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            # The initial-backfill weeks contain jumbo rows; a page of them can
            # exceed what the API serves in one response (observed: a
            # deterministic 500 at 200 rows). Shrink until the page fits —
            # correctness first, throughput second.
            code = error.code if isinstance(error, urllib.error.HTTPError) else None
            if page_rows > 1 and (code is None or code >= 500):
                page_rows = max(1, page_rows // 2)
                print(f"page too large or timed out, retrying at {page_rows} rows")
                continue
            raise
        if not rows:
            break
        by_month: dict[str, list[dict]] = {}
        for row in rows:
            by_month.setdefault(str(row["received_at"])[:7], []).append(row)
        for month, month_rows in sorted(by_month.items()):
            path = BACKUP_DIR / f"{month}.jsonl.gz"
            with gzip.open(path, "at", encoding="utf-8") as handle:
                for row in month_rows:
                    handle.write(json.dumps(row, separators=(",", ":")) + "\n")
        state["last_id"] = rows[-1]["id"]
        state["rows_archived"] += len(rows)
        # Persist state after every page so an interrupted run never re-appends
        # rows it already wrote.
        STATE_PATH.write_text(json.dumps(state))
        fetched += len(rows)
        print(f"archived {len(rows)} rows (through id {state['last_id']})")
    print(f"run archived {fetched} new rows into {BACKUP_DIR}")


def verify(env: dict) -> None:
    remote = remote_count(env)
    local = local_row_count()
    print(f"remote rows: {remote} · local rows: {local}")
    if local == remote:
        print("verified: local mirror is complete")
    else:
        sys.exit(f"MISMATCH: local mirror is missing {remote - local} row(s) — rerun the archive")


def main() -> None:
    parser = argparse.ArgumentParser(description="Mirror raw_payloads to local gzipped JSONL")
    parser.add_argument("--verify-only", action="store_true",
                        help="compare local vs remote row counts without archiving")
    args = parser.parse_args()
    env = load_env()
    if not args.verify_only:
        archive(env)
    verify(env)


if __name__ == "__main__":
    main()
