#!/usr/bin/env python3
"""Write helper for gym session logs — the chat agent logs lifting on request.

`db.py` is read-only (SELECT via RPC); this is the write path for gym_sessions
/ gym_sets (and the derived plan_item_checks), hitting the PostgREST REST API
directly with the service key. Stdlib only; credentials come from ./.env when
present, else the process environment (same resolution as db.py / injuries.py).

Subcommands:
  list    [--days 30]         recent gym sessions with set summaries
  log     --json '<payload>'  create a session (sets expand from schemes), prints its id
  delete  <session_id>        remove a mis-logged session (cascades its sets)

`log` payload (JSON object):
  {
    "date": "2026-07-12T18:30",        // optional; local time, defaults to now.
    "workout_id": "<uuid>",            // optional; link the synced workout — date then derives from it
    "title": "Legs",                   // optional
    "notes": "...",                    // optional
    "body_parts": ["legs", "core"],    // optional; the lazy tier — valid with empty sets
    "sets": [                          // optional; [] + body_parts = quick log
      {"exercise": "back squat", "sets": 3, "reps": 8, "kg": 80},
      {"exercise": "lat machine", "reps": 12},              // one set; kg omitted = bodyweight
      {"exercise": "heel walk", "warmup": true, "create": true}  // create allows a new custom exercise
    ]
  }
Exercise names resolve case-insensitively against the catalog (aliases work).
An unknown name aborts with near-matches unless that entry says "create": true.
Sets of an exercise linked to an active recovery-plan item auto-check the item
for that day (source='gym') — same behavior as the app's Gym tab.
"""

import argparse
import datetime
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
import zoneinfo

REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
BODY_PARTS = ("chest", "back", "shoulders", "arms", "legs", "core", "full body")


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


def _request(method: str, path: str, *, params: dict | None = None, body=None,
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


def user_timezone() -> str | None:
    rows = _request("GET", "user_config", params={"id": "eq.1", "select": "timezone"})
    return rows[0].get("timezone") if rows else None


def resolve_exercise(name: str, *, create: bool, body_part: str | None) -> dict:
    """Resolve an exercise name (case-insensitive, aliases too) to its catalog
    row. With create=True an unknown name becomes a new source='user' row;
    otherwise abort with near-matches — a typo must not silently spawn a new
    exercise and pollute the autocomplete."""
    key = name.strip().lower()
    rows = _request("GET", "exercises", params={
        "name_key": f"eq.{key}", "select": "id,name", "limit": "1",
    })
    if not rows:
        rows = _request("GET", "exercises", params={
            "aliases": f"cs.{{{key}}}", "select": "id,name", "limit": "2",
        })
    if len(rows) == 1:
        return rows[0]
    if create:
        if body_part is not None and body_part not in BODY_PARTS:
            sys.exit(f"invalid body_part {body_part!r} — valid: {', '.join(BODY_PARTS)}")
        created = _request("POST", "exercises",
                           body={"name": name.strip(), "body_part": body_part, "source": "user"},
                           prefer="return=representation")
        return created[0]
    near = _request("GET", "exercises", params={
        "name": f"ilike.*{name.strip()}*", "select": "name", "limit": "6",
    })
    hint = ", ".join(r["name"] for r in near) if near else "none"
    sys.exit(
        f"no exact exercise match for {name!r} (near matches: {hint}) — "
        'use the exact catalog name, or add "create": true to that entry to make a new custom exercise'
    )


def sync_plan_checks(exercise_ids: list[str], done_date: str) -> list[str]:
    """The app's gym→rehab bridge, mirrored: active plan items (of non-resolved
    injuries) linked to a logged exercise get their day's check upserted with
    source='gym'. Additive only; an existing manual check wins. Returns the
    names of items checked."""
    if not exercise_ids:
        return []
    ids = ",".join(exercise_ids)
    items = _request("GET", "recovery_plan_items", params={
        "select": "id,name,injuries!inner(status)",
        "active": "is.true",
        "exercise_id": f"in.({ids})",
        "injuries.status": "neq.resolved",
    })
    if not items:
        return []
    _request("POST", "plan_item_checks",
             body=[{"item_id": i["id"], "done_date": done_date, "source": "gym"} for i in items],
             prefer="return=minimal,resolution=ignore-duplicates",
             on_conflict="item_id,done_date")
    return [i["name"] for i in items]


def cmd_list(args) -> None:
    since = (datetime.date.today() - datetime.timedelta(days=args.days)).isoformat()
    rows = _request("GET", "gym_sessions", params={
        "select": "id,performed_at,title,notes,source,body_parts,workout_id,"
                  "gym_sets(exercise_id,reps,weight_kg,is_warmup,exercises(name))",
        "performed_at": f"gte.{since}",
        "order": "performed_at.desc",
    })
    if not rows:
        print(f"_no gym sessions in the last {args.days} days_")
        return
    print("| id | date | title | content | synced |")
    print("| --- | --- | --- | --- | --- |")
    for r in rows:
        sets = r.get("gym_sets") or []
        if sets:
            by_ex: dict[str, list] = {}
            for s in sets:
                if s.get("is_warmup"):
                    continue
                ex_name = (s.get("exercises") or {}).get("name") or "?"
                by_ex.setdefault(ex_name, []).append(s)
            content = "; ".join(
                f"{name} " + " ".join(
                    f"{s.get('reps') if s.get('reps') is not None else '?'}"
                    f"x{s['weight_kg'] if s.get('weight_kg') is not None else 'bw'}"
                    for s in ex_sets
                )
                for name, ex_sets in by_ex.items()
            )
        elif r.get("body_parts"):
            content = "body parts: " + ", ".join(r["body_parts"])
        else:
            content = "quick log"
        content = content.replace("|", "\\|")
        title = (r.get("title") or "").replace("|", "\\|")
        print(f"| {r['id']} | {r['performed_at'][:16]} | {title} | {content} | "
              f"{'yes' if r.get('workout_id') else ''} |")


def cmd_log(args) -> None:
    try:
        payload = json.loads(args.json)
    except json.JSONDecodeError as e:
        sys.exit(f"invalid --json: {e}")
    if not isinstance(payload, dict):
        sys.exit("invalid --json: expected an object")
    unknown = set(payload) - {"date", "workout_id", "title", "notes", "body_parts", "sets"}
    if unknown:
        sys.exit(f"unknown payload key(s): {', '.join(sorted(unknown))}")

    body_parts = payload.get("body_parts")
    if body_parts is not None:
        if not isinstance(body_parts, list) or not all(p in BODY_PARTS for p in body_parts):
            sys.exit(f"invalid body_parts — valid: {', '.join(BODY_PARTS)}")

    tz_name = user_timezone()
    tz = zoneinfo.ZoneInfo(tz_name) if tz_name else None

    session: dict = {"source": "chat"}
    if payload.get("title"):
        session["title"] = str(payload["title"])[:120]
    if payload.get("notes"):
        session["notes"] = str(payload["notes"])[:2000]
    # App invariant: with sets present, body parts DERIVE from the sets'
    # exercises — a stored declaration is only kept for set-less lazy logs.
    if body_parts and not payload.get("sets"):
        session["body_parts"] = body_parts

    if payload.get("workout_id"):
        workouts = _request("GET", "workouts", params={
            "id": f"eq.{payload['workout_id']}", "select": "id,start_at", "limit": "1",
        })
        if not workouts:
            sys.exit(f"workout {payload['workout_id']} not found")
        session["workout_id"] = payload["workout_id"]
        session["performed_at"] = workouts[0]["start_at"]
    else:
        when = payload.get("date")
        if when:
            try:
                dt = datetime.datetime.fromisoformat(str(when))
            except ValueError:
                sys.exit(f"invalid date {when!r} — use YYYY-MM-DD or YYYY-MM-DDTHH:MM")
            if dt.tzinfo is None and tz is not None:
                dt = dt.replace(tzinfo=tz)
            session["performed_at"] = dt.isoformat()
        # else: DB default now()

    # Resolve + expand sets before creating the session, so a bad exercise
    # name aborts with nothing written.
    set_rows: list[dict] = []
    exercise_ids: list[str] = []
    for entry in payload.get("sets") or []:
        if not isinstance(entry, dict) or not entry.get("exercise"):
            sys.exit('each sets[] entry needs an "exercise" name')
        exercise = resolve_exercise(
            str(entry["exercise"]),
            create=bool(entry.get("create")),
            body_part=entry.get("body_part"),
        )
        exercise_ids.append(exercise["id"])
        count = int(entry.get("sets", 1))
        if not 1 <= count <= 50:
            sys.exit(f"invalid sets count {count} for {exercise['name']}")
        for _ in range(count):
            set_rows.append({
                "exercise_id": exercise["id"],
                "reps": entry.get("reps"),
                "weight_kg": entry.get("kg"),
                "rpe": entry.get("rpe"),
                "is_warmup": bool(entry.get("warmup")),
                "note": entry.get("note"),
            })

    created = _request("POST", "gym_sessions", body=session, prefer="return=representation")
    session_id = created[0]["id"]
    performed_at = created[0]["performed_at"]

    if set_rows:
        for i, row in enumerate(set_rows):
            row["session_id"] = session_id
            row["position"] = i
        _request("POST", "gym_sets", body=set_rows, prefer="return=minimal")

    # Local date for the rehab auto-check (mirrors the app's timezone handling).
    dt = datetime.datetime.fromisoformat(performed_at)
    done_date = (dt.astimezone(tz) if tz else dt).date().isoformat()
    checked = sync_plan_checks(sorted(set(exercise_ids)), done_date)

    summary = f"logged session {session_id} ({len(set_rows)} sets)"
    if checked:
        summary += " — auto-checked rehab: " + ", ".join(checked)
    print(summary)


def cmd_delete(args) -> None:
    _request("DELETE", "gym_sessions", params={"id": f"eq.{args.session_id}"},
             prefer="return=minimal")
    print(f"deleted session {args.session_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Gym log write helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="List recent gym sessions")
    p_list.add_argument("--days", type=int, default=30)
    p_list.set_defaults(func=cmd_list)

    p_log = sub.add_parser("log", help="Log a gym session from a JSON payload")
    p_log.add_argument("--json", required=True, help="see module docstring for the payload shape")
    p_log.set_defaults(func=cmd_log)

    p_del = sub.add_parser("delete", help="Delete a mis-logged session (cascades its sets)")
    p_del.add_argument("session_id")
    p_del.set_defaults(func=cmd_delete)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
