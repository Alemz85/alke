#!/usr/bin/env python3
"""Write helper for the injury log — the chat agent maintains injuries with this.

`db.py` is read-only (SELECT via RPC); this is the write path, hitting the
PostgREST REST API directly with the service key. Table names are hardcoded
(injuries, injury_notes, recovery_plan_items, plan_item_checks). Stdlib only;
credentials come from ./.env when present, else the process environment (same
resolution as db.py).

Subcommands:
  list                                     list all injuries as a markdown table
  add        --name ... [options]          create an injury, prints its id
  update     <id> [options]                patch an injury (only given fields)
  note       <injury_id> --note ... [opts] append a dated progress note
  notes      <injury_id>                   list an injury's notes, newest first
  plan-list  <injury_id>                   list an injury's recovery plan items
  plan-add   <injury_id> --name ... [opts] create a recovery plan item, prints its id
  plan-update <item_id> [options]          patch a recovery plan item (only given fields)
  plan-remove <item_id>                    hard-delete a recovery plan item (cascades checks)
  check      <item_id> [--date ..]         mark a plan item done for a day (source=chat)
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
VALID_CONTEXTS = ("during_workout", "post_workout", "at_rest", "on_waking")


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
             prefer: str | None = None, on_conflict: str | None = None) -> list[dict]:
    env = load_env()
    url = f"{env['SUPABASE_URL']}/rest/v1/{path}"
    all_params = dict(params or {})
    if on_conflict:
        all_params["on_conflict"] = on_conflict
    if all_params:
        url += "?" + urllib.parse.urlencode(all_params)
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
    if args.context is not None:
        tags = [t.strip() for t in args.context.split(",") if t.strip()]
        invalid = [t for t in tags if t not in VALID_CONTEXTS]
        if invalid:
            sys.exit(f"invalid --context value(s): {', '.join(invalid)} — valid: {', '.join(VALID_CONTEXTS)}")
        body["context"] = tags
    if args.workout is not None:
        body["workout_id"] = args.workout
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


def cmd_plan_list(args) -> None:
    rows = _request("GET", "recovery_plan_items", params={
        "injury_id": f"eq.{args.injury_id}",
        "select": "id,name,kind,weekly_target,note,active",
        "order": "active.desc,kind,name",
    })
    if not rows:
        print("_no recovery plan items_")
        return
    print("| id | name | kind | weekly_target | note | active |")
    print("| --- | --- | --- | --- | --- | --- |")
    for r in rows:
        target = "" if r.get("weekly_target") is None else r["weekly_target"]
        note = (r.get("note") or "").replace("|", "\\|").replace("\n", " ")
        print(f"| {r['id']} | {r.get('name') or ''} | {r.get('kind') or ''} | {target} | "
              f"{note} | {r.get('active')} |")


def cmd_plan_add(args) -> None:
    body = {"injury_id": args.injury_id, "name": args.name}
    for field, value in (("kind", args.kind), ("weekly_target", args.target), ("note", args.note)):
        if value is not None:
            body[field] = value
    rows = _request("POST", "recovery_plan_items", body=body, prefer="return=representation")
    print(f"created plan item {rows[0]['id']}")


def cmd_plan_update(args) -> None:
    body = {"updated_at": "now()"}
    for field, value in (("name", args.name), ("kind", args.kind), ("note", args.note)):
        if value is not None:
            body[field] = value
    if args.target is not None:
        if args.target == "none":
            body["weekly_target"] = None
        else:
            try:
                target = int(args.target)
            except ValueError:
                target = -1
            if not 1 <= target <= 14:
                sys.exit(f"invalid --target {args.target!r} — must be 1-14 or 'none'")
            body["weekly_target"] = target
    if args.active is not None:
        body["active"] = args.active == "true"
    _request("PATCH", "recovery_plan_items", params={"id": f"eq.{args.id}"}, body=body, prefer="return=minimal")
    print(f"updated plan item {args.id}")


def cmd_plan_remove(args) -> None:
    _request("DELETE", "recovery_plan_items", params={"id": f"eq.{args.id}"}, prefer="return=minimal")
    print(f"removed plan item {args.id}")


def cmd_check(args) -> None:
    body = {"item_id": args.item_id, "source": "chat"}
    if args.date is not None:
        body["done_date"] = args.date
    rows = _request("POST", "plan_item_checks", body=body,
                     prefer="return=representation,resolution=ignore-duplicates",
                     on_conflict="item_id,done_date")
    if rows:
        print(f"checked item {args.item_id}")
    else:
        print(f"already checked item {args.item_id}")


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
    p_note.add_argument("--context", help="comma-separated: " + ",".join(VALID_CONTEXTS))
    p_note.add_argument("--workout", help="workout id this note relates to")
    p_note.set_defaults(func=cmd_note)

    p_notes = sub.add_parser("notes", help="List an injury's notes")
    p_notes.add_argument("injury_id")
    p_notes.set_defaults(func=cmd_notes)

    p_plan_list = sub.add_parser("plan-list", help="List an injury's recovery plan items")
    p_plan_list.add_argument("injury_id")
    p_plan_list.set_defaults(func=cmd_plan_list)

    p_plan_add = sub.add_parser("plan-add", help="Create a recovery plan item")
    p_plan_add.add_argument("injury_id")
    p_plan_add.add_argument("--name", required=True)
    p_plan_add.add_argument("--kind", choices=["exercise", "habit", "constraint", "activity"])
    p_plan_add.add_argument("--target", type=int, choices=range(1, 15), metavar="1-14")
    p_plan_add.add_argument("--note")
    p_plan_add.set_defaults(func=cmd_plan_add)

    p_plan_upd = sub.add_parser("plan-update", help="Update an existing recovery plan item")
    p_plan_upd.add_argument("id")
    p_plan_upd.add_argument("--name")
    p_plan_upd.add_argument("--kind", choices=["exercise", "habit", "constraint", "activity"])
    p_plan_upd.add_argument("--target", help="1-14, or 'none' to clear")
    p_plan_upd.add_argument("--note")
    p_plan_upd.add_argument("--active", choices=["true", "false"])
    p_plan_upd.set_defaults(func=cmd_plan_update)

    p_plan_rm = sub.add_parser("plan-remove", help="Hard-delete a recovery plan item")
    p_plan_rm.add_argument("id")
    p_plan_rm.set_defaults(func=cmd_plan_remove)

    p_check = sub.add_parser("check", help="Mark a plan item done for a day")
    p_check.add_argument("item_id")
    p_check.add_argument("--date", help="YYYY-MM-DD (defaults to today)")
    p_check.set_defaults(func=cmd_check)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
