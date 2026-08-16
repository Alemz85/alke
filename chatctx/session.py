#!/usr/bin/env python3
"""Session handoff helper — the chat agent's memory of the CONVERSATION.

Every durable fact has its own table (injuries, injury_notes, goals, gym
sessions, agent_log). This is the one surface for the thing none of them hold:
what was being worked through, what was left hanging, what the user asked to
return to. Without it each session restarted cold (agent_log #24).

SCOPE — conversational thread, not domain facts. An agreed rehab taper goes to
`injuries.py note` (agent_log #28), a goal change to `goals.py`, a tooling
defect to `agent_log.py`. A domain fact copied in here becomes a duplicate that
drifts, and the domain table is the one a later session trusts.

`db.py` is read-only (SELECT via RPC); this is the write path, hitting the
PostgREST REST API directly with the service key. Stdlib only; credentials come
from ./.env when present, else the process environment (same resolution as
db.py / injuries.py / agent_log.py).

Subcommands:
  read   [--limit N] [--mode ..]              most recent handoffs, newest first
  write  --summary .. [--open .. --next ..]   record this session's handoff
  show   <id>                                 one handoff in full, untruncated
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
MODES = ("analysis", "injuries", "goals")
# Default read depth. One handoff is the common case; three is enough to see a
# thread that has survived a couple of sessions without flooding the context.
DEFAULT_LIMIT = 3

# See gym.py for the full rationale (agent_log #25): PostgREST chunked responses
# abort mid-read as http.client.IncompleteRead, which is a dead connection
# rather than a server error, so the HTTPError path never catches it.
#
# Retries are GET-only on purpose: a POST whose response truncated may already
# have been applied server-side, and replaying it would file the same handoff
# twice. Writes surface the error instead.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_S = 0.5
TRANSIENT_ERRORS = (http.client.HTTPException, urllib.error.URLError, OSError,
                    json.JSONDecodeError)


def load_env() -> dict:
    env = {}
    env_path = pathlib.Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    if not all(env.get(k) for k in REQUIRED_KEYS):
        for key in REQUIRED_KEYS:
            if os.environ.get(key):
                env[key] = os.environ[key]
    if not all(env.get(k) for k in REQUIRED_KEYS):
        sys.exit(
            "missing SUPABASE_URL/SUPABASE_SERVICE_KEY — set chatctx/.env "
            "(copy .env.example and fill in credentials) or export them in the environment"
        )
    return env


def _request(method: str, path: str, *, params: dict | None = None, body: dict | None = None,
             prefer: str | None = None) -> list[dict]:
    env = load_env()
    url = f"{env['SUPABASE_URL']}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    key = env["SUPABASE_SERVICE_KEY"]
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    attempts = RETRY_ATTEMPTS if method == "GET" else 1
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            # A real HTTP status: deterministic, so report it rather than retry.
            detail = e.read().decode()
            try:
                detail = json.loads(detail).get("message", detail)
            except json.JSONDecodeError:
                pass
            sys.exit(f"request failed ({e.code}): {detail}")
        except TRANSIENT_ERRORS as e:
            if attempt == attempts:
                sys.exit(f"request failed after {attempt} attempt(s): {type(e).__name__}: {e}")
            time.sleep(RETRY_BACKOFF_S * 2 ** (attempt - 1))
    raise AssertionError("unreachable")  # the loop returns or sys.exits


def _print_handoff(row: dict) -> None:
    """Full prose, unwrapped and untruncated — this is meant to be READ, not
    scanned as a table. A handoff clipped to a column width is a handoff whose
    open threads got cut off, which is the whole point of the record."""
    header = f"## Handoff {row['id']} · {row['created_at'][:16].replace('T', ' ')}"
    if row.get("mode"):
        header += f" · {row['mode']} mode"
    print(header)
    print(f"\n**Where things stand**\n{row['summary'].strip()}")
    if row.get("open_threads"):
        print(f"\n**Open threads**\n{row['open_threads'].strip()}")
    if row.get("next_steps"):
        print(f"\n**Agreed next steps**\n{row['next_steps'].strip()}")
    print()


def cmd_read(args) -> None:
    params = {
        "select": "id,created_at,mode,summary,open_threads,next_steps",
        "order": "created_at.desc",
        "limit": str(args.limit),
    }
    if args.mode:
        params["mode"] = f"eq.{args.mode}"
    rows = _request("GET", "session_handoffs", params=params)
    if not rows:
        print("_no session handoffs recorded yet_")
        return
    # Oldest first so the newest reads last and lands closest to the reply.
    for row in reversed(rows):
        _print_handoff(row)


def cmd_show(args) -> None:
    rows = _request("GET", "session_handoffs", params={
        "select": "id,created_at,mode,summary,open_threads,next_steps",
        "id": f"eq.{args.id}",
        "limit": "1",
    })
    if not rows:
        sys.exit(f"no session_handoffs entry with id {args.id}")
    _print_handoff(rows[0])


def cmd_write(args) -> None:
    summary = args.summary.strip()
    if not summary:
        sys.exit("--summary cannot be empty: a handoff with no state is noise")
    body: dict = {"summary": summary}
    if args.mode:
        body["mode"] = args.mode
    for field, value in (("open_threads", args.open), ("next_steps", args.next)):
        if value is not None and value.strip():
            body[field] = value.strip()
    rows = _request("POST", "session_handoffs", body=body, prefer="return=representation")
    print(f"recorded session handoff {rows[0]['id']}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Session handoff helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_read = sub.add_parser("read", help="Most recent handoffs, newest last")
    p_read.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    p_read.add_argument("--mode", choices=MODES)
    p_read.set_defaults(func=cmd_read)

    p_show = sub.add_parser("show", help="One handoff in full")
    p_show.add_argument("id")
    p_show.set_defaults(func=cmd_show)

    p_write = sub.add_parser("write", help="Record this session's handoff")
    p_write.add_argument("--summary", required=True,
                         help="where things stand at the end of the session")
    p_write.add_argument("--open", help="questions raised and left unsettled")
    p_write.add_argument("--next", help="what was agreed to happen next")
    p_write.add_argument("--mode", choices=MODES)
    p_write.set_defaults(func=cmd_write)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
