#!/usr/bin/env python3
"""Write helper for the agent issue log — the chat agent self-reports problems.

`db.py` is read-only (SELECT via RPC); this is the write path for the
`agent_log` table, hitting the PostgREST REST API directly with the service
key. Stdlib only; credentials come from ./.env when present, else the process
environment (same resolution as db.py / injuries.py).

Subcommands:
  log      --category .. --subject .. --detail .. [opts]  add an entry, prints its id
  list     [--category ..] [--unresolved]                 list entries, newest first
  counts   [--category ..]                                repeat-flag view: entries per (category, subject)
  resolve  <id>                                           mark an entry resolved (sets resolved_at)
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
CATEGORIES = ("knowledge", "schema", "tool", "data", "instructions", "other")
SEVERITIES = ("info", "issue", "blocker")


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
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        try:
            detail = json.loads(detail).get("message", detail)
        except json.JSONDecodeError:
            pass
        sys.exit(f"request failed ({e.code}): {detail}")


def cmd_log(args) -> None:
    body = {
        "category": args.category,
        "severity": args.severity,
        "subject": args.subject,
        "detail": args.detail,
    }
    if args.session_hint:
        body["session_hint"] = args.session_hint
    rows = _request("POST", "agent_log", body=body, prefer="return=representation")
    print(f"logged agent_log entry {rows[0]['id']}")


def cmd_list(args) -> None:
    params = {
        "select": "id,logged_at,category,severity,subject,detail,resolved_at",
        "order": "logged_at.desc",
        "limit": "100",
    }
    if args.category:
        params["category"] = f"eq.{args.category}"
    if args.unresolved:
        params["resolved_at"] = "is.null"
    rows = _request("GET", "agent_log", params=params)
    if not rows:
        print("_no agent_log entries_")
        return
    print("| id | logged | category | severity | subject | detail | resolved |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        detail = (r["detail"][:80] + "…") if len(r["detail"]) > 80 else r["detail"]
        detail = detail.replace("|", "\\|").replace("\n", " ")
        resolved = (r.get("resolved_at") or "")[:10] or "open"
        print(f"| {r['id']} | {r['logged_at'][:10]} | {r['category']} | {r['severity']} | "
              f"{r['subject']} | {detail} | {resolved} |")


def cmd_counts(args) -> None:
    # Client-side GROUP BY (category, subject): the table stays small and this
    # keeps the helper free of PostgREST aggregate/view dependencies.
    params = {"select": "category,subject,resolved_at", "limit": "10000"}
    if args.category:
        params["category"] = f"eq.{args.category}"
    rows = _request("GET", "agent_log", params=params)
    if not rows:
        print("_no agent_log entries_")
        return
    counts: dict[tuple[str, str], dict[str, int]] = {}
    for r in rows:
        entry = counts.setdefault((r["category"], r["subject"]), {"total": 0, "open": 0})
        entry["total"] += 1
        if r["resolved_at"] is None:
            entry["open"] += 1
    print("| category | subject | total | open |")
    print("| --- | --- | --- | --- |")
    for (category, subject), c in sorted(counts.items(), key=lambda kv: -kv[1]["total"]):
        print(f"| {category} | {subject} | {c['total']} | {c['open']} |")


def cmd_resolve(args) -> None:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    rows = _request("PATCH", "agent_log", params={"id": f"eq.{args.id}"},
                    body={"resolved_at": now}, prefer="return=representation")
    if not rows:
        sys.exit(f"no agent_log entry with id {args.id}")
    print(f"resolved agent_log entry {args.id}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent issue log write helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_log = sub.add_parser("log", help="Add a log entry")
    p_log.add_argument("--category", required=True, choices=CATEGORIES)
    p_log.add_argument("--severity", default="issue", choices=SEVERITIES)
    p_log.add_argument("--subject", required=True,
                       help="join key for repeats: file path, table/column, or tool name")
    p_log.add_argument("--detail", required=True,
                       help="what was attempted, what happened, what was expected")
    p_log.add_argument("--session-hint", dest="session_hint")
    p_log.set_defaults(func=cmd_log)

    p_list = sub.add_parser("list", help="List entries, newest first")
    p_list.add_argument("--category", choices=CATEGORIES)
    p_list.add_argument("--unresolved", action="store_true")
    p_list.set_defaults(func=cmd_list)

    p_counts = sub.add_parser("counts", help="Entries per (category, subject) — the repeat-flag view")
    p_counts.add_argument("--category", choices=CATEGORIES)
    p_counts.set_defaults(func=cmd_counts)

    p_resolve = sub.add_parser("resolve", help="Mark an entry resolved")
    p_resolve.add_argument("id")
    p_resolve.set_defaults(func=cmd_resolve)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
