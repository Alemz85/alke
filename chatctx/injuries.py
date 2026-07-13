#!/usr/bin/env python3
"""Write helper for the injury log — the chat agent maintains injuries with this.

`db.py` is read-only (SELECT via RPC); this is the write path, hitting the
PostgREST REST API directly with the service key. Table names are hardcoded
(injuries, injury_notes, recovery_plan_items, plan_item_checks). Stdlib only;
credentials come from ./.env when present, else the process environment (same
resolution as db.py).

Subcommands:
  list                                     list all injuries as a markdown table
  show       <injury_id>                   show one injury, notes, and phase-aware plan
  add        --name ... [options]          create an injury, prints its id
  update     <id> [options]                patch an injury (only given fields)
  note       <injury_id> --note ... [opts] append a dated progress note
  notes      <injury_id>                   list an injury's notes, newest first
  plan-list  <injury_id>                   list an injury's recovery plan items
  plan-apply <injury_id> --file plan.json  validate and idempotently apply a complete plan
  plan-add   <injury_id> --name ... [opts] create a recovery plan item, prints its id
  plan-update <item_id> [options]          patch a recovery plan item (only given fields)
  plan-remove <item_id>                    hard-delete a recovery plan item (cascades checks)
  check      <item_id> [--date ..]         mark a plan item done for a day (source=chat)
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
VALID_CONTEXTS = ("during_workout", "post_workout", "at_rest", "on_waking")
VALID_PLAN_KINDS = ("exercise", "activity", "habit", "constraint")


def current_plan_week(plan_started_at: str | None, today: str) -> int | None:
    """Return the 1-based cumulative plan week, 0 before start, or None for legacy plans."""
    if not plan_started_at:
        return None
    start = datetime.date.fromisoformat(plan_started_at[:10])
    current = datetime.date.fromisoformat(today[:10])
    elapsed = (current - start).days
    return 0 if elapsed < 0 else elapsed // 7 + 1


def user_today() -> str:
    rows = _request("GET", "user_config", params={"id": "eq.1", "select": "timezone"})
    timezone_name = rows[0].get("timezone") if rows else None
    timezone = zoneinfo.ZoneInfo(timezone_name) if timezone_name else datetime.timezone.utc
    return datetime.datetime.now(timezone).date().isoformat()


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
    today = user_today()
    rows = _request("GET", "injuries", params={
        "select": "id,name,body_area,status,severity,started_at,plan_started_at",
        "order": "status,updated_at.desc",
    })
    if not rows:
        print("_no injuries logged_")
        return
    print("| id | name | area | status | severity | started | plan start | current plan week |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        plan_week = current_plan_week(r.get("plan_started_at"), today)
        print(f"| {r['id']} | {r.get('name') or ''} | {r.get('body_area') or ''} | "
              f"{r.get('status') or ''} | {r.get('severity') or ''} | {r.get('started_at') or ''} | "
              f"{r.get('plan_started_at') or ''} | {'' if plan_week is None else plan_week} |")


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
        ("plan_started_at", args.plan_started), ("summary", args.summary),
        ("recovery_plan", args.recovery_plan),
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


def cmd_show(args) -> None:
    """Print the complete context for one injury in a single agent-friendly call."""
    injury_rows = _request("GET", "injuries", params={
        "id": f"eq.{args.injury_id}",
        "select": "id,name,body_area,status,severity,started_at,plan_started_at,summary,recovery_plan",
        "limit": "1",
    })
    if not injury_rows:
        sys.exit(f"injury {args.injury_id} not found")
    injury = injury_rows[0]
    plan_week = current_plan_week(injury.get("plan_started_at"), user_today())
    notes = _request("GET", "injury_notes", params={
        "injury_id": f"eq.{args.injury_id}",
        "select": "entry_date,source,pain_level,note",
        "order": "entry_date.desc,noted_at.desc",
    })
    items = _request("GET", "recovery_plan_items", params={
        "injury_id": f"eq.{args.injury_id}",
        "select": "id,name,kind,start_week,weekly_target,green_min,yellow_min,target_sets,target_reps,steps,note,active,exercise:exercises(name)",
        "order": "active.desc,start_week,kind,name",
    })

    print(f"# {injury.get('name') or 'Unnamed injury'}")
    print(f"id: {injury['id']}")
    print(f"area: {injury.get('body_area') or 'not set'} · status: {injury.get('status') or 'not set'} "
          f"· severity: {injury.get('severity') or 'not set'}")
    print(f"injury start: {injury.get('started_at') or 'not set'} · plan start: "
          f"{injury.get('plan_started_at') or 'not set'} · current plan week: "
          f"{plan_week if plan_week is not None else 'legacy'}")
    print(f"\n## Summary\n{injury.get('summary') or '_not set_'}")
    print(f"\n## Plan approach\n{injury.get('recovery_plan') or '_not set_'}")

    print("\n## Notes")
    if not notes:
        print("_no notes_")
    else:
        print("| date | source | pain | note |")
        print("| --- | --- | --- | --- |")
        for row in notes:
            pain = "" if row.get("pain_level") is None else row["pain_level"]
            note = (row.get("note") or "").replace("|", "\\|").replace("\n", " ")
            print(f"| {row.get('entry_date') or ''} | {row.get('source') or ''} | {pain} | {note} |")

    print("\n## Recovery plan items")
    if not items:
        print("_no recovery plan items_")
        return
    print("| id | name | kind | starts | phase | weekly target | thresholds | dose / steps | note | active |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for row in items:
        starts = row.get("start_week") or 1
        phase = "future" if plan_week is not None and starts > plan_week else "accountable"
        target = "" if row.get("weekly_target") is None else row["weekly_target"]
        yellow = "" if row.get("yellow_min") is None else row["yellow_min"]
        green = "" if row.get("green_min") is None else row["green_min"]
        exercise = (row.get("exercise") or {}).get("name")
        if exercise:
            dose = f"{exercise}: {row.get('target_sets') or '?'}x{row.get('target_reps') or '?'}"
        elif row.get("steps"):
            dose = json.dumps(row["steps"], separators=(",", ":"))
        else:
            dose = ""
        dose = dose.replace("|", "\\|")
        note = (row.get("note") or "").replace("|", "\\|").replace("\n", " ")
        print(f"| {row['id']} | {row.get('name') or ''} | {row.get('kind') or ''} | week {starts} | "
              f"{phase} | {target} | {yellow}-{green} | {dose} | {note} | {row.get('active')} |")


def resolve_exercise(name: str) -> str:
    """Resolve an exercise name (case-insensitive, matches aliases too) to its
    exercises.id. Exits with candidates on no/ambiguous match — linking must be
    exact, a wrong link would auto-check the wrong rehab item."""
    key = name.strip().lower()
    rows = _request("GET", "exercises", params={
        "name_key": f"eq.{key}", "select": "id,name", "limit": "1",
    })
    if not rows:
        rows = _request("GET", "exercises", params={
            "aliases": f"cs.{{{key}}}", "select": "id,name", "limit": "2",
        })
    if len(rows) == 1:
        return rows[0]["id"]
    near = _request("GET", "exercises", params={
        "name": f"ilike.*{name.strip()}*", "select": "name", "limit": "6",
    })
    hint = ", ".join(r["name"] for r in near) if near else "none"
    sys.exit(
        f"no exact exercise match for {name!r} (near matches: {hint}) — "
        "use the exact catalog name, or have the user create it in the Gym tab first"
    )


def parse_threshold(value: str, label: str) -> int | None:
    """--green-min/--yellow-min value: 1-14, or 'none' to clear."""
    if value == "none":
        return None
    try:
        n = int(value)
    except ValueError:
        n = -1
    if not 1 <= n <= 14:
        sys.exit(f"invalid --{label} {value!r} — must be 1-14 or 'none'")
    return n


def parse_optional_count(value: str, label: str, maximum: int) -> int | None:
    if value == "none":
        return None
    try:
        number = int(value)
    except ValueError:
        number = -1
    if not 1 <= number <= maximum:
        sys.exit(f"invalid --{label} {value!r} — must be 1-{maximum} or 'none'")
    return number


def validate_plan_document(plan: object) -> list[dict]:
    """Validate the complete canonical plan before any network mutation."""
    if not isinstance(plan, dict) or not isinstance(plan.get("approach"), str) or not plan["approach"].strip():
        sys.exit("invalid plan: approach must be a non-empty string")
    if len(plan["approach"].strip()) > 500:
        sys.exit("invalid plan: approach must be 500 characters or fewer")
    items = plan.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 16:
        sys.exit("invalid plan: items must contain 1-16 entries")
    names = set()
    normalized = []
    for i, raw in enumerate(items):
        if not isinstance(raw, dict):
            sys.exit(f"invalid plan: items[{i}] must be an object")
        item = {key: raw.get(key) for key in (
            "name", "kind", "weekly_target", "green_min", "yellow_min", "note",
            "start_week", "exercise", "target_sets", "target_reps", "steps")}
        name = item["name"].strip() if isinstance(item["name"], str) else ""
        if not name or name.lower() in names:
            sys.exit(f"invalid plan: items[{i}] name is empty or duplicated")
        names.add(name.lower())
        item["name"] = name
        if item["kind"] not in VALID_PLAN_KINDS:
            sys.exit(f"invalid plan: items[{i}] kind is invalid")
        if isinstance(item["start_week"], bool) or not isinstance(item["start_week"], int) or not 1 <= item["start_week"] <= 52:
            sys.exit(f"invalid plan: items[{i}].start_week must be 1-52")
        for field, maximum in (("weekly_target", 14), ("green_min", 14), ("yellow_min", 14),
                               ("target_sets", 20), ("target_reps", 100)):
            value = item[field]
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum):
                sys.exit(f"invalid plan: items[{i}].{field} must be null or 1-{maximum}")
        steps = item["steps"]
        if steps is not None and not isinstance(steps, list):
            sys.exit(f"invalid plan: items[{i}].steps must be an array or null")
        for j, step in enumerate(steps or []):
            if not isinstance(step, dict) or not isinstance(step.get("name"), str) or not step["name"].strip():
                sys.exit(f"invalid plan: items[{i}].steps[{j}] requires a name")
            normalized_step = {key: step.get(key) for key in (
                "name", "sets", "reps", "duration_seconds", "distance_m", "per_side", "note")}
            for field, maximum in (("sets", 20), ("reps", 1000), ("duration_seconds", 3600), ("distance_m", 10000)):
                value = normalized_step[field]
                if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0 or value > maximum):
                    sys.exit(f"invalid plan: items[{i}].steps[{j}].{field} is out of range")
            if normalized_step["per_side"] not in (True, False, None):
                sys.exit(f"invalid plan: items[{i}].steps[{j}].per_side must be boolean or null")
            if sum(normalized_step[field] is not None for field in ("reps", "duration_seconds", "distance_m")) != 1:
                sys.exit(f"invalid plan: items[{i}].steps[{j}] requires exactly one dose measure")
            if normalized_step["note"] is not None and not isinstance(normalized_step["note"], str):
                sys.exit(f"invalid plan: items[{i}].steps[{j}].note must be a string or null")
            normalized_step["name"] = normalized_step["name"].strip()
            steps[j] = normalized_step
        if item["kind"] == "constraint":
            if any(item[field] is not None for field in ("weekly_target", "green_min", "yellow_min", "exercise", "target_sets", "target_reps", "steps")):
                sys.exit(f"invalid plan: items[{i}] constraint carries targets or Gym fields")
        elif item["kind"] == "exercise":
            if any(item[field] is None for field in ("weekly_target", "green_min", "yellow_min")):
                sys.exit(f"invalid plan: items[{i}] exercise lacks weekly efficacy thresholds")
            if not item["yellow_min"] <= item["green_min"] <= item["weekly_target"]:
                sys.exit(f"invalid plan: items[{i}] requires yellow_min <= green_min <= weekly_target")
            if item["exercise"] is not None and (item["target_sets"] is None or item["target_reps"] is None):
                sys.exit(f"invalid plan: items[{i}] linked exercise lacks target_sets/target_reps")
            if item["exercise"] is None and (item["target_sets"] is not None or item["target_reps"] is not None):
                sys.exit(f"invalid plan: items[{i}] Gym dose lacks exercise link")
            if item["exercise"] is None and not item["steps"]:
                sys.exit(f"invalid plan: items[{i}] off-catalog exercise requires structured steps")
            if item["exercise"] is not None and item["steps"] is not None:
                sys.exit(f"invalid plan: items[{i}] linked exercise cannot also carry steps")
        elif any(item[field] is not None for field in ("exercise", "target_sets", "target_reps", "steps")):
            sys.exit(f"invalid plan: items[{i}] only exercises may carry Gym fields")
        normalized.append(item)
    return normalized


def cmd_plan_apply(args) -> None:
    try:
        plan = json.loads(pathlib.Path(args.file).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"cannot read plan JSON: {exc}")
    items = validate_plan_document(plan)
    # Resolve every catalog reference before the first write: application is all-or-nothing
    # with respect to validation and ambiguous exercise names.
    for item in items:
        exercise_name = item.pop("exercise")
        item["exercise_id"] = resolve_exercise(exercise_name) if exercise_name else None
    injury_rows = _request("GET", "injuries", params={
        "id": f"eq.{args.injury_id}", "select": "id,plan_started_at", "limit": "1"
    })
    if not injury_rows:
        sys.exit(f"injury {args.injury_id} not found")
    existing = _request("GET", "recovery_plan_items", params={
        "injury_id": f"eq.{args.injury_id}", "select": "id,name,active"
    })
    by_name = {row["name"].strip().lower(): row for row in existing}
    injury_patch = {"recovery_plan": plan["approach"].strip(), "updated_at": "now()"}
    if not injury_rows[0].get("plan_started_at"):
        injury_patch["plan_started_at"] = user_today()
    _request("PATCH", "injuries", params={"id": f"eq.{args.injury_id}"},
             body=injury_patch, prefer="return=minimal")
    kept = set()
    for item in items:
        key = item["name"].lower()
        body = {**item, "injury_id": args.injury_id, "active": True, "updated_at": "now()"}
        if key in by_name:
            kept.add(by_name[key]["id"])
            body.pop("injury_id")
            _request("PATCH", "recovery_plan_items", params={"id": f"eq.{by_name[key]['id']}"}, body=body, prefer="return=minimal")
        else:
            rows = _request("POST", "recovery_plan_items", body=body, prefer="return=representation")
            kept.add(rows[0]["id"])
    for row in existing:
        if row["id"] not in kept and row.get("active"):
            _request("PATCH", "recovery_plan_items", params={"id": f"eq.{row['id']}"},
                     body={"active": False, "updated_at": "now()"}, prefer="return=minimal")
    print(f"applied {len(items)} plan items to injury {args.injury_id}")


def cmd_plan_list(args) -> None:
    injury_rows = _request("GET", "injuries", params={
        "id": f"eq.{args.injury_id}", "select": "plan_started_at", "limit": "1"
    })
    plan_started_at = injury_rows[0].get("plan_started_at") if injury_rows else None
    plan_week = current_plan_week(plan_started_at, user_today())
    rows = _request("GET", "recovery_plan_items", params={
        "injury_id": f"eq.{args.injury_id}",
        "select": "id,name,kind,start_week,weekly_target,green_min,yellow_min,target_sets,target_reps,steps,note,active,exercise:exercises(name)",
        "order": "active.desc,start_week,kind,name",
    })
    if not rows:
        print("_no recovery plan items_")
        return
    print(f"Plan start: {plan_started_at or 'not set'} · current plan week: {plan_week if plan_week is not None else 'legacy'}")
    print("| id | name | kind | starts | phase | weekly target | thresholds | gym dose | note | active | gym exercise |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        target = "" if r.get("weekly_target") is None else r["weekly_target"]
        green = "" if r.get("green_min") is None else r["green_min"]
        yellow = "" if r.get("yellow_min") is None else r["yellow_min"]
        note = (r.get("note") or "").replace("|", "\\|").replace("\n", " ")
        exercise = (r.get("exercise") or {}).get("name") or ""
        dose = f"{r['target_sets']}x{r['target_reps']}" if r.get("target_sets") and r.get("target_reps") else ""
        starts = r.get("start_week") or 1
        phase = "future" if plan_week is not None and starts > plan_week else "accountable"
        print(f"| {r['id']} | {r.get('name') or ''} | {r.get('kind') or ''} | week {starts} | {phase} | {target} | "
              f"{yellow}-{green} | {dose} | {note} | {r.get('active')} | {exercise} |")


def cmd_plan_add(args) -> None:
    body = {"injury_id": args.injury_id, "name": args.name, "start_week": args.start_week}
    for field, value in (("kind", args.kind), ("weekly_target", args.target), ("note", args.note)):
        if value is not None:
            body[field] = value
    if args.exercise is not None:
        body["exercise_id"] = resolve_exercise(args.exercise)
    if args.green_min is not None:
        body["green_min"] = parse_threshold(args.green_min, "green-min")
    if args.yellow_min is not None:
        body["yellow_min"] = parse_threshold(args.yellow_min, "yellow-min")
    if args.target_sets is not None:
        body["target_sets"] = parse_optional_count(args.target_sets, "target-sets", 20)
    if args.target_reps is not None:
        body["target_reps"] = parse_optional_count(args.target_reps, "target-reps", 100)
    rows = _request("POST", "recovery_plan_items", body=body, prefer="return=representation")
    print(f"created plan item {rows[0]['id']}")


def cmd_plan_update(args) -> None:
    body = {"updated_at": "now()"}
    for field, value in (("name", args.name), ("kind", args.kind), ("note", args.note)):
        if value is not None:
            body[field] = value
    if args.start_week is not None:
        body["start_week"] = args.start_week
    if args.exercise is not None:
        body["exercise_id"] = None if args.exercise == "none" else resolve_exercise(args.exercise)
    if args.green_min is not None:
        body["green_min"] = parse_threshold(args.green_min, "green-min")
    if args.yellow_min is not None:
        body["yellow_min"] = parse_threshold(args.yellow_min, "yellow-min")
    if args.target_sets is not None:
        body["target_sets"] = parse_optional_count(args.target_sets, "target-sets", 20)
    if args.target_reps is not None:
        body["target_reps"] = parse_optional_count(args.target_reps, "target-reps", 100)
    if args.steps_file is not None:
        if args.steps_file == "none":
            body["steps"] = None
        else:
            try:
                raw_steps = json.loads(pathlib.Path(args.steps_file).read_text())
            except (OSError, json.JSONDecodeError) as exc:
                sys.exit(f"cannot read steps JSON: {exc}")
            validated = validate_plan_document({
                "approach": "Validate steps",
                "items": [{"name": "Steps", "kind": "exercise", "weekly_target": 1,
                           "green_min": 1, "yellow_min": 1, "start_week": 1,
                           "note": None, "exercise": None,
                           "target_sets": None, "target_reps": None, "steps": raw_steps}],
            })
            body["steps"] = validated[0]["steps"]
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
    p_upd.add_argument("--plan-started", dest="plan_started", help="YYYY-MM-DD")
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

    p_show = sub.add_parser("show", help="Show one injury with notes and its phase-aware plan")
    p_show.add_argument("injury_id")
    p_show.set_defaults(func=cmd_show)

    p_plan_list = sub.add_parser("plan-list", help="List an injury's recovery plan items")
    p_plan_list.add_argument("injury_id")
    p_plan_list.set_defaults(func=cmd_plan_list)

    p_plan_apply = sub.add_parser("plan-apply", help="Validate and idempotently apply a complete plan JSON document")
    p_plan_apply.add_argument("injury_id")
    p_plan_apply.add_argument("--file", required=True)
    p_plan_apply.set_defaults(func=cmd_plan_apply)

    p_plan_add = sub.add_parser("plan-add", help="Create a recovery plan item")
    p_plan_add.add_argument("injury_id")
    p_plan_add.add_argument("--name", required=True)
    p_plan_add.add_argument("--kind", choices=["exercise", "habit", "constraint", "activity"])
    p_plan_add.add_argument("--start-week", type=int, choices=range(1, 53), default=1)
    p_plan_add.add_argument("--target", type=int, choices=range(1, 15), metavar="1-14")
    p_plan_add.add_argument("--note")
    p_plan_add.add_argument("--exercise",
                            help="gym exercises-catalog name to link (gym logs then auto-check this item)")
    p_plan_add.add_argument("--green-min", dest="green_min",
                            help="weekly count that is an acceptable therapeutic dose (1-14)")
    p_plan_add.add_argument("--yellow-min", dest="yellow_min",
                            help="weekly count that is the minimum-effective dose (1-14)")
    p_plan_add.add_argument("--target-sets", dest="target_sets", help="Gym prescription sets (1-20)")
    p_plan_add.add_argument("--target-reps", dest="target_reps", help="Gym prescription reps (1-100)")
    p_plan_add.set_defaults(func=cmd_plan_add)

    p_plan_upd = sub.add_parser("plan-update", help="Update an existing recovery plan item")
    p_plan_upd.add_argument("id")
    p_plan_upd.add_argument("--name")
    p_plan_upd.add_argument("--kind", choices=["exercise", "habit", "constraint", "activity"])
    p_plan_upd.add_argument("--start-week", type=int, choices=range(1, 53))
    p_plan_upd.add_argument("--target", help="1-14, or 'none' to clear")
    p_plan_upd.add_argument("--note")
    p_plan_upd.add_argument("--active", choices=["true", "false"])
    p_plan_upd.add_argument("--exercise",
                            help="gym exercises-catalog name to link, or 'none' to unlink")
    p_plan_upd.add_argument("--green-min", dest="green_min",
                            help="acceptable therapeutic dose per week (1-14), or 'none' to clear")
    p_plan_upd.add_argument("--yellow-min", dest="yellow_min",
                            help="minimum-effective dose per week (1-14), or 'none' to clear")
    p_plan_upd.add_argument("--target-sets", dest="target_sets", help="Gym prescription sets (1-20), or 'none'")
    p_plan_upd.add_argument("--target-reps", dest="target_reps", help="Gym prescription reps (1-100), or 'none'")
    p_plan_upd.add_argument("--steps-file", dest="steps_file",
                            help="JSON array of structured routine steps, or 'none' to clear")
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
