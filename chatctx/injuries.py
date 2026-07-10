#!/usr/bin/env python3
"""Write helper for the injury log — the chat agent maintains injuries with this.

`db.py` is read-only (SELECT via RPC); this is the write path, hitting the
PostgREST REST API directly with the service key. Table names are hardcoded
(injuries, injury_notes). Stdlib only; credentials come from ./.env when
present, else the process environment (same resolution as db.py).

Subcommands:
  list                                 list all injuries as a markdown table
  add    --name ... [options]          create an injury, prints its id
  update <id> [options]                patch an injury (only given fields)
  note   <injury_id> --note ... [opts] append a dated progress note
  notes  <injury_id>                   list an injury's notes, newest first
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")


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


def cmd_list(_args) -> None:
    rows = _request("GET", "injuries", params={
        "select": "id,name,body_area,status,severity,started_at",
        "order": "status,updated_at.desc",
    })
    if not rows:
        print("_no injuries logged_")
        return
    print("| id | name | area | status | severity | started |")
    print("| --- | --- | --- | --- | --- | --- |")
    for r in rows:
        print(f"| {r['id']} | {r.get('name') or ''} | {r.get('body_area') or ''} | "
              f"{r.get('status') or ''} | {r.get('severity') or ''} | {r.get('started_at') or ''} |")


def cmd_add(args) -> None:
    body = {"name": args.name}
    for field, value in (
        ("body_area", args.body_area), ("status", args.status), ("severity", args.severity),
        ("started_at", args.started), ("summary", args.summary), ("recovery_plan", args.recovery_plan),
    ):
        if value is not None:
            body[field] = value
    rows = _request("POST", "injuries", body=body, prefer="return=representation")
    print(f"created injury {rows[0]['id']}")


def cmd_update(args) -> None:
    body = {"updated_at": "now()"}
    for field, value in (
        ("name", args.name), ("body_area", args.body_area), ("status", args.status),
        ("severity", args.severity), ("started_at", args.started), ("resolved_at", args.resolved),
        ("summary", args.summary), ("recovery_plan", args.recovery_plan),
    ):
        if value is not None:
            body[field] = value
    _request("PATCH", "injuries", params={"id": f"eq.{args.id}"}, body=body, prefer="return=minimal")
    print(f"updated injury {args.id}")


def cmd_note(args) -> None:
    body = {"injury_id": args.injury_id, "note": args.note, "source": args.source}
    if args.pain is not None:
        body["pain_level"] = args.pain
    if args.date is not None:
        body["entry_date"] = args.date
    _request("POST", "injury_notes", body=body, prefer="return=minimal")
    print(f"logged note on injury {args.injury_id}")


def cmd_notes(args) -> None:
    rows = _request("GET", "injury_notes", params={
        "injury_id": f"eq.{args.injury_id}",
        "select": "entry_date,source,pain_level,note",
        "order": "entry_date.desc,noted_at.desc",
    })
    if not rows:
        print("_no notes_")
        return
    print("| date | source | pain | note |")
    print("| --- | --- | --- | --- |")
    for r in rows:
        pain = "" if r.get("pain_level") is None else r["pain_level"]
        note = (r.get("note") or "").replace("|", "\\|").replace("\n", " ")
        print(f"| {r.get('entry_date') or ''} | {r.get('source') or ''} | {pain} | {note} |")


def main() -> None:
    parser = argparse.ArgumentParser(description="Injury log write helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="List all injuries").set_defaults(func=cmd_list)

    p_add = sub.add_parser("add", help="Create a new injury")
    p_add.add_argument("--name", required=True)
    p_add.add_argument("--body-area", dest="body_area")
    p_add.add_argument("--status", choices=["active", "recovering", "resolved"])
    p_add.add_argument("--severity", choices=["mild", "moderate", "severe"])
    p_add.add_argument("--started", help="YYYY-MM-DD")
    p_add.add_argument("--summary")
    p_add.add_argument("--recovery-plan", dest="recovery_plan")
    p_add.set_defaults(func=cmd_add)

    p_upd = sub.add_parser("update", help="Update an existing injury")
    p_upd.add_argument("id")
    p_upd.add_argument("--name")
    p_upd.add_argument("--body-area", dest="body_area")
    p_upd.add_argument("--status", choices=["active", "recovering", "resolved"])
    p_upd.add_argument("--severity", choices=["mild", "moderate", "severe"])
    p_upd.add_argument("--started", help="YYYY-MM-DD")
    p_upd.add_argument("--resolved", help="YYYY-MM-DD")
    p_upd.add_argument("--summary")
    p_upd.add_argument("--recovery-plan", dest="recovery_plan")
    p_upd.set_defaults(func=cmd_update)

    p_note = sub.add_parser("note", help="Append a progress note")
    p_note.add_argument("injury_id")
    p_note.add_argument("--note", required=True)
    p_note.add_argument("--pain", type=int, choices=range(0, 11), metavar="0-10")
    p_note.add_argument("--date", help="YYYY-MM-DD (defaults to today)")
    p_note.add_argument("--source", default="chat", choices=["chat", "user"])
    p_note.set_defaults(func=cmd_note)

    p_notes = sub.add_parser("notes", help="List an injury's notes")
    p_notes.add_argument("injury_id")
    p_notes.set_defaults(func=cmd_notes)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
