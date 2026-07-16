#!/usr/bin/env python3
"""Write helper for gym session logs — the chat agent logs lifting on request.

`db.py` is read-only (SELECT via RPC); this is the write path for gym_sessions
/ gym_sets (and the derived plan_item_checks), hitting the PostgREST REST API
directly with the service key. Stdlib only; credentials come from ./.env when
present, else the process environment (same resolution as db.py / injuries.py).

Subcommands:
  list           [--days 30]              recent gym sessions with set summaries
  log            --json '<payload>'       create a session (sets expand from schemes), prints its id
  delete         <session_id>             remove a mis-logged session (cascades its sets; retracts
                                           any source='gym' plan_item_checks it produced — see
                                           remove_gym_plan_checks_for_session)
  template-list                           list reusable Gym templates
  template-apply --file <plan.json>       validate + idempotently apply named templates
  template-archive <template_id>          archive a single template version (runs/other versions untouched)
  template-delete  <template_id>          hard-delete a template version; refuses if referenced by a session/run
  run-start      <template_id>            start/resurrect a run on that template version
  run-complete   <template_id>            close the family's open run
  create-version <base_template_id> --file <plan.json>  save a new version of a template family

Non-atomicity caveat: this hits PostgREST directly, one HTTP request per
statement, with no cross-request transactions. Two multi-step sequences can
leave the DB mid-way through a logical operation if a later step fails:
  - apply_template_document's UPDATE branch (existing template by name):
    PATCH gym_templates, then DELETE gym_template_exercises, then POST the
    new exercise rows. gym_template_exercises has no unique constraint on
    (template_id, position) — nothing stops inserting the new rows before
    deleting the old ones — but doing so would transiently double-count the
    template's exercises for any concurrent read (template-list, the app's
    Gym tab), which is worse than the current window. Kept delete-then-insert
    deliberately; the tradeoff is that a failure after the DELETE and before
    the POST leaves that template with ZERO exercises until re-applied. If a
    template shows an empty exercise list right after a template-apply, that
    failed mid-sequence — re-run template-apply with the same document to
    repair it (the whole document is idempotent).
  - create_template_version's 4-step sequence (POST new gym_templates row,
    POST its gym_template_exercises, PATCH siblings' is_current=false, PATCH
    any open gym_template_runs onto the new template_id): a failure partway
    can leave two is_current=true rows in a family, or an open run still
    pointing at the OLD template_id while a newer version exists. Symptoms:
    template-list showing more than one non-archived current-looking version
    in a family, or run-complete/run-start behaving as if the version bump
    didn't happen. Re-running create-version does not repair this (each run
    mints a new version); a manual PATCH to gym_templates.is_current and/or
    gym_template_runs.template_id is needed to reconcile.

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
Sets of an exercise linked to an active recovery-plan item (of a non-resolved
injury) auto-check the item for that day (source='gym') — mirrors the app's
Gym tab exactly, including the name-fallback match for plan items missing an
exercise_id link (see active_plan_items_for_exercises). Deleting a session
retracts the checks it produced unless another same-local-day session still
logs the same exercise (see remove_gym_plan_checks_for_session).

`template-apply` document (JSON, --file):
  {
    "templates": [{
      "name": "Full body A",
      "notes": "45-60 minutes. Add reps before load.",
      "default_rest_s": 90,             // optional; template-level DEFAULT rest between sets, seconds
      "exercises": [
        {"exercise": "back squat", "sets": 3, "reps": 8, "kg": 80, "note": "Leave 2 in reserve."},
        {"exercise": "leg press", "sets": 3, "reps": 10, "kg": 120, "rest_after_s": 180}
      ]
    }]
  }
`default_rest_s` is the STANDARD for the template: set it once. Only add a
per-exercise "rest_after_s" override when that exercise genuinely needs
different rest than the template default (e.g. a heavy compound needs longer,
an isolation finisher needs less) — do NOT stamp the same rest value onto
every exercise; omit it and let the template default apply.

template-apply matches by name against each family's CURRENT version only
(is_current=true) — every version in a family shares its name by design, so
a template with several versions is edited IN PLACE on its current version,
not duplicated or aborted on its own history. It still hard-aborts if two
DIFFERENT families' current versions collide on the same name.

Template versioning + runs (mirrors the app's db.ts exactly):
  run-start      <template_id>  start/resurrect a run on that template version
  run-complete   <template_id>  close the family's open run (archive/complete)
  create-version <base_template_id> --file <plan.json>
                                 save a new VERSION of an existing template
                                 family (small upgrade/diff), same document
                                 shape as template-apply's single-template entry

A "family" is every version of one template (shared family_id); exactly one
version is_current. A run is "active" for the family if ANY version has an
open run (ended_at null) — at most one open run per family at a time.
run-start is a no-op if the given template already has an open run;
otherwise it closes any open run elsewhere in the family (ended_at=today)
before opening a new one with source='chat'. create-version copies the
current exercise list forward, bumps version, flips is_current, and carries
any open run in the family onto the new version (reassigns template_id) so
an active run survives a plan upgrade.
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
import uuid
import zoneinfo

REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
BODY_PARTS = ("chest", "back", "shoulders", "arms", "legs", "core", "full body")


def validate_template_document(plan: object) -> list[dict]:
    """Validate and normalize a complete reusable-template document before writes."""
    if not isinstance(plan, dict):
        sys.exit("invalid template plan: expected a JSON object")
    templates = plan.get("templates")
    if not isinstance(templates, list) or not 1 <= len(templates) <= 12:
        sys.exit("invalid template plan: templates must contain 1-12 entries")
    names: set[str] = set()
    normalized: list[dict] = []
    for index, raw in enumerate(templates):
        if not isinstance(raw, dict):
            sys.exit(f"invalid template plan: templates[{index}] must be an object")
        name = raw.get("name")
        name = name.strip() if isinstance(name, str) else ""
        if not 1 <= len(name) <= 120:
            sys.exit(f"invalid template plan: templates[{index}].name must contain 1-120 characters")
        if name.lower() in names:
            sys.exit(f"invalid template plan: templates[{index}].name is duplicated")
        names.add(name.lower())
        notes = raw.get("notes")
        if notes is not None and (not isinstance(notes, str) or len(notes) > 2000):
            sys.exit(f"invalid template plan: templates[{index}].notes is too long")
        default_rest_s = raw.get("default_rest_s")
        if default_rest_s is not None and (
            isinstance(default_rest_s, bool) or not isinstance(default_rest_s, int)
            or not 0 <= default_rest_s <= 3600
        ):
            sys.exit(f"invalid template plan: templates[{index}].default_rest_s must be null or 0-3600")
        raw_exercises = raw.get("exercises")
        if not isinstance(raw_exercises, list) or not 1 <= len(raw_exercises) <= 30:
            sys.exit(f"invalid template plan: templates[{index}].exercises must contain 1-30 entries")
        exercises: list[dict] = []
        for exercise_index, raw_exercise in enumerate(raw_exercises):
            at = f"templates[{index}].exercises[{exercise_index}]"
            if not isinstance(raw_exercise, dict):
                sys.exit(f"invalid template plan: {at} must be an object")
            exercise_name = raw_exercise.get("exercise")
            exercise_name = exercise_name.strip() if isinstance(exercise_name, str) else ""
            if not exercise_name:
                sys.exit(f"invalid template plan: {at}.exercise needs an exact catalog name")
            sets = raw_exercise.get("sets")
            reps = raw_exercise.get("reps")
            if isinstance(sets, bool) or not isinstance(sets, int) or not 1 <= sets <= 50:
                sys.exit(f"invalid template plan: {at}.sets must be 1-50")
            if isinstance(reps, bool) or not isinstance(reps, int) or not 1 <= reps <= 500:
                sys.exit(f"invalid template plan: {at}.reps must be 1-500")
            kg = raw_exercise.get("kg")
            if kg is not None and (isinstance(kg, bool) or not isinstance(kg, (int, float)) or not 0 <= kg <= 1500):
                sys.exit(f"invalid template plan: {at}.kg must be null or 0-1500")
            note = raw_exercise.get("note")
            if note is not None and (not isinstance(note, str) or len(note) > 500):
                sys.exit(f"invalid template plan: {at}.note must be null or at most 500 characters")
            rest_after_s = raw_exercise.get("rest_after_s")
            if rest_after_s is not None and (
                isinstance(rest_after_s, bool) or not isinstance(rest_after_s, int)
                or not 0 <= rest_after_s <= 3600
            ):
                sys.exit(f"invalid template plan: {at}.rest_after_s must be null or 0-3600")
            exercises.append({
                "exercise": exercise_name, "sets": sets, "reps": reps, "kg": kg, "note": note,
                "rest_after_s": rest_after_s,
            })
        normalized.append({"name": name, "notes": notes, "default_rest_s": default_rest_s, "exercises": exercises})
    return normalized


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


def local_date_in_tz(iso: str, timezone_name: str | None) -> str:
    """"2026-07-12" for an ISO instant in the user's timezone (falls back to
    the instant's UTC date). Mirrors the app's localDateInTz (db.ts)."""
    try:
        dt = datetime.datetime.fromisoformat(iso)
        tz = zoneinfo.ZoneInfo(timezone_name) if timezone_name else None
        return (dt.astimezone(tz) if tz else dt).date().isoformat()
    except (ValueError, zoneinfo.ZoneInfoNotFoundError):
        return iso[:10]


def exercise_names_by_id(exercise_ids: list[str]) -> dict:
    ids = list(dict.fromkeys(exercise_ids))
    if not ids:
        return {}
    rows = _request("GET", "exercises", params={
        "id": f"in.({','.join(ids)})", "select": "id,name",
    })
    return {row["id"]: row["name"] for row in rows}


def active_plan_items_for_exercises(exercise_ids: list[str]) -> list[dict]:
    """Active plan items (of a non-resolved injury) linked to any of the given
    exercises — the shared match used both to auto-check on save
    (sync_plan_checks) and to know what to un-check on delete
    (remove_gym_plan_checks_for_session). Each result carries
    `matched_exercise_id`: the input exercise that caused the match (for use
    as the "is this exercise still logged elsewhere" key on delete), which is
    the plan item's own exercise_id for a direct match, or the logged
    exercise whose name matched for a fallback match. Mirrors the app's
    activePlanItemsForExercises (db.ts) exactly.

    Primary match is exercise_id. Fallback: a plan item with NO exercise_id
    (the chat agent's injuries.py linking step was skipped or missed) still
    matches when its name is a case-insensitive exact match to one of the
    logged exercises' catalog names — this is a data-linkage gap the fallback
    papers over defensively, not a substitute for fixing the link. It's exact
    (not fuzzy/plural-insensitive): e.g. plan item "Heel walks" vs catalog
    exercise "Heel Walk" is a real near-miss found live in this DB that this
    fallback deliberately does NOT bridge — singular/plural and other fuzzy
    variants risk false-positive matches on a health-tracking check, so that
    case needs the plan item's exercise_id linked (injuries.py) or its name
    corrected to match, not silent fuzzy code matching.
    """
    if not exercise_ids:
        return []
    ids = ",".join(exercise_ids)
    by_id = _request("GET", "recovery_plan_items", params={
        "select": "id,exercise_id,injuries!inner(status)",
        "active": "is.true",
        "exercise_id": f"in.({ids})",
        "injuries.status": "neq.resolved",
    })
    unlinked = _request("GET", "recovery_plan_items", params={
        "select": "id,exercise_id,name,injuries!inner(status)",
        "active": "is.true",
        "kind": "eq.exercise",
        "exercise_id": "is.null",
        "injuries.status": "neq.resolved",
    })

    items = [{"id": item["id"], "matched_exercise_id": item["exercise_id"]} for item in by_id]
    if unlinked:
        names = exercise_names_by_id(exercise_ids)
        lower_to_id = {name.lower(): eid for eid, name in names.items()}
        for item in unlinked:
            name = item.get("name")
            if not isinstance(name, str):
                continue
            matched_id = lower_to_id.get(name.lower())
            if matched_id:
                items.append({"id": item["id"], "matched_exercise_id": matched_id})
    return items


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


def apply_template_document(plan: object) -> list[tuple[str, str, str]]:
    """Validate, resolve, and idempotently apply reusable templates by name."""
    templates = validate_template_document(plan)

    # Resolve every catalog reference before the first mutation. Template
    # creation must not leave a half-written plan because of one typo.
    resolved: list[dict] = []
    for template in templates:
        exercises = []
        for position, prescription in enumerate(template["exercises"]):
            exercise = resolve_exercise(prescription["exercise"], create=False, body_part=None)
            exercises.append({
                "exercise_id": exercise["id"],
                "position": position,
                "target_sets": prescription["sets"],
                "target_reps": prescription["reps"],
                "target_weight_kg": prescription["kg"],
                "note": prescription["note"],
                "rest_after_s": prescription["rest_after_s"],
            })
        resolved.append({**template, "exercises": exercises})

    # Only each family's CURRENT version competes for a name match — every
    # version in a family shares its name by design (versioning), so matching
    # against all rows would hard-abort on a template's own history. A hard
    # abort is still correct if two DIFFERENT families' current versions
    # collide on the same name (genuine ambiguity, not versioning noise).
    existing = _request("GET", "gym_templates", params={
        "is_current": "is.true", "select": "id,name,family_id", "order": "created_at"
    })
    by_name: dict[str, dict] = {}
    for row in existing:
        key = row["name"].strip().lower()
        if key in by_name and by_name[key]["family_id"] != row["family_id"]:
            sys.exit(f"cannot apply templates: duplicate existing template name {row['name']!r}")
        by_name[key] = row

    results: list[tuple[str, str, str]] = []
    for template in resolved:
        key = template["name"].lower()
        current = by_name.get(key)
        if current:
            template_id = current["id"]
            _request("PATCH", "gym_templates", params={"id": f"eq.{template_id}"}, body={
                "name": template["name"],
                "notes": template["notes"],
                "default_rest_s": template["default_rest_s"],
                "archived": False,
                "updated_at": "now()",
            }, prefer="return=minimal")
            _request("DELETE", "gym_template_exercises",
                     params={"template_id": f"eq.{template_id}"}, prefer="return=minimal")
            action = "updated"
        else:
            rows = _request("POST", "gym_templates", body={
                "name": template["name"], "notes": template["notes"],
                "default_rest_s": template["default_rest_s"], "archived": False,
                "family_id": str(uuid.uuid4()), "version": 1, "is_current": True,
            }, prefer="return=representation")
            template_id = rows[0]["id"]
            action = "created"

        item_rows = [{**item, "template_id": template_id} for item in template["exercises"]]
        _request("POST", "gym_template_exercises", body=item_rows, prefer="return=minimal")
        results.append((template_id, template["name"], action))
    return results


def _family_id_of(template_id: str) -> str:
    rows = _request("GET", "gym_templates", params={
        "id": f"eq.{template_id}", "select": "family_id", "limit": "1",
    })
    if not rows:
        sys.exit(f"template {template_id} not found")
    return rows[0]["family_id"]


def _family_template_ids(family_id: str) -> list[str]:
    rows = _request("GET", "gym_templates", params={"family_id": f"eq.{family_id}", "select": "id"})
    return [r["id"] for r in rows]


def start_template_run(template_id: str) -> dict:
    """Start/resurrect a run on template_id. No-op (returns it) if that exact
    version already has an open run; otherwise closes any other open run in
    the family first, then opens a new one — at most one active run per
    family. source='chat' distinguishes agent-initiated runs from the app's."""
    family_id = _family_id_of(template_id)
    open_here = _request("GET", "gym_template_runs", params={
        "template_id": f"eq.{template_id}", "ended_at": "is.null", "limit": "1",
    })
    if open_here:
        return open_here[0]

    today = datetime.date.today().isoformat()
    family_ids = _family_template_ids(family_id)
    _request("PATCH", "gym_template_runs", params={
        "template_id": f"in.({','.join(family_ids)})", "ended_at": "is.null",
    }, body={"ended_at": today}, prefer="return=minimal")

    created = _request("POST", "gym_template_runs", body={
        "template_id": template_id, "started_at": today, "source": "chat",
    }, prefer="return=representation")
    return created[0]


def complete_template_run(template_id: str) -> dict | None:
    """Close the family's open run (archive/complete), wherever in the family
    it currently sits. Returns None if the family has no open run."""
    family_id = _family_id_of(template_id)
    family_ids = _family_template_ids(family_id)
    today = datetime.date.today().isoformat()
    closed = _request("PATCH", "gym_template_runs", params={
        "template_id": f"in.({','.join(family_ids)})", "ended_at": "is.null",
    }, body={"ended_at": today}, prefer="return=representation")
    return closed[0] if closed else None


def archive_template_version(template_id: str) -> None:
    """Archive exactly this template version — no other version, no run."""
    _family_id_of(template_id)  # 404s clearly if the id doesn't exist
    _request("PATCH", "gym_templates", params={"id": f"eq.{template_id}"},
             body={"archived": True, "updated_at": "now()"}, prefer="return=minimal")


def delete_template_version(template_id: str) -> None:
    """Hard-delete exactly this template version and its exercise rows.
    Refuses if any gym_sessions or gym_template_runs still reference it —
    those need `template-archive` instead, since deleting out from under a
    logged session or run history would orphan/cascade data the user cares
    about."""
    _family_id_of(template_id)  # 404s clearly if the id doesn't exist
    sessions = _request("GET", "gym_sessions", params={
        "template_id": f"eq.{template_id}", "select": "id", "limit": "1",
    })
    if sessions:
        sys.exit(
            f"cannot delete template {template_id}: referenced by gym_sessions "
            "(logged sessions point at it) — use template-archive instead"
        )
    session_templates = _request("GET", "gym_session_templates", params={
        "template_id": f"eq.{template_id}", "select": "session_id", "limit": "1",
    })
    if session_templates:
        sys.exit(
            f"cannot delete template {template_id}: referenced by gym_session_templates "
            "(a logged session draws from it) — use template-archive instead"
        )
    runs = _request("GET", "gym_template_runs", params={
        "template_id": f"eq.{template_id}", "select": "id", "limit": "1",
    })
    if runs:
        sys.exit(
            f"cannot delete template {template_id}: it has gym_template_runs history "
            "— use template-archive instead"
        )
    _request("DELETE", "gym_template_exercises",
             params={"template_id": f"eq.{template_id}"}, prefer="return=minimal")
    _request("DELETE", "gym_templates", params={"id": f"eq.{template_id}"}, prefer="return=minimal")


def create_template_version(base_template_id: str, plan: object) -> dict:
    """Save a new VERSION of an existing template family: same document shape
    as a single template-apply entry. Copies the exercise list forward,
    increments version, flips is_current across the family, and carries any
    open run in the family onto the new version so an active run survives a
    plan upgrade."""
    if not isinstance(plan, dict):
        sys.exit("invalid template plan: expected a JSON object")
    if "templates" not in plan:
        plan = {"templates": [plan]}
    templates = validate_template_document(plan)
    if len(templates) != 1:
        sys.exit("invalid template plan: create-version takes exactly one template")
    template = templates[0]

    exercises = []
    for position, prescription in enumerate(template["exercises"]):
        exercise = resolve_exercise(prescription["exercise"], create=False, body_part=None)
        exercises.append({
            "exercise_id": exercise["id"],
            "position": position,
            "target_sets": prescription["sets"],
            "target_reps": prescription["reps"],
            "target_weight_kg": prescription["kg"],
            "note": prescription["note"],
            "rest_after_s": prescription["rest_after_s"],
        })

    family_id = _family_id_of(base_template_id)
    latest = _request("GET", "gym_templates", params={
        "family_id": f"eq.{family_id}", "select": "version", "order": "version.desc", "limit": "1",
    })
    next_version = (latest[0]["version"] if latest else 0) + 1

    created = _request("POST", "gym_templates", body={
        "name": template["name"], "notes": template["notes"],
        "default_rest_s": template["default_rest_s"], "archived": False,
        "family_id": family_id, "version": next_version, "is_current": True,
    }, prefer="return=representation")
    new_template = created[0]
    new_id = new_template["id"]

    item_rows = [{**item, "template_id": new_id} for item in exercises]
    _request("POST", "gym_template_exercises", body=item_rows, prefer="return=minimal")

    _request("PATCH", "gym_templates", params={
        "family_id": f"eq.{family_id}", "id": f"neq.{new_id}",
    }, body={"is_current": False}, prefer="return=minimal")

    sibling_ids = [tid for tid in _family_template_ids(family_id) if tid != new_id]
    if sibling_ids:
        _request("PATCH", "gym_template_runs", params={
            "template_id": f"in.({','.join(sibling_ids)})", "ended_at": "is.null",
        }, body={"template_id": new_id}, prefer="return=minimal")

    return new_template


def cmd_run_start(args) -> None:
    run = start_template_run(args.template_id)
    print(f"open run {run['id']} on template {run['template_id']} (started {run['started_at']}, source {run['source']})")


def cmd_run_complete(args) -> None:
    run = complete_template_run(args.template_id)
    if run is None:
        print("no open run for that template's family")
        return
    print(f"closed run {run['id']} on template {run['template_id']} (ended {run['ended_at']})")


def cmd_template_archive(args) -> None:
    archive_template_version(args.template_id)
    print(f"archived template {args.template_id}")


def cmd_template_delete(args) -> None:
    delete_template_version(args.template_id)
    print(f"deleted template {args.template_id}")


def cmd_create_version(args) -> None:
    try:
        plan = json.loads(pathlib.Path(args.file).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"cannot read workout template JSON: {exc}")
    new_template = create_template_version(args.base_template_id, plan)
    print(f"created version {new_template['version']} of family {new_template['family_id']}: "
          f"template {new_template['id']} ({new_template['name']})")


def cmd_template_list(_args) -> None:
    rows = _request("GET", "gym_templates", params={
        "select": "id,name,notes,default_rest_s,archived,"
                  "gym_template_exercises(position,target_sets,target_reps,target_weight_kg,note,rest_after_s,exercises(name))",
        "order": "archived,created_at",
    })
    if not rows:
        print("_no workout templates_")
        return
    print("| id | name | exercises | default rest | archived | notes |")
    print("| --- | --- | --- | --- | --- | --- |")
    for row in rows:
        items = sorted(row.get("gym_template_exercises") or [], key=lambda item: item.get("position", 0))
        exercise_text = "; ".join(
            f"{(item.get('exercises') or {}).get('name') or '?'} "
            f"{item.get('target_sets') or '—'}x{item.get('target_reps') or '—'}"
            + (f" (rest {item['rest_after_s']}s)" if item.get("rest_after_s") is not None else "")
            for item in items
        )
        default_rest = row.get("default_rest_s")
        default_rest_text = f"{default_rest}s" if default_rest is not None else "—"
        notes = (row.get("notes") or "").replace("|", "\\|").replace("\n", " ")
        print(f"| {row['id']} | {row.get('name') or ''} | {exercise_text} | {default_rest_text} | "
              f"{row.get('archived')} | {notes} |")


def cmd_template_apply(args) -> None:
    try:
        plan = json.loads(pathlib.Path(args.file).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"cannot read workout template JSON: {exc}")
    results = apply_template_document(plan)
    for template_id, name, action in results:
        print(f"{action} workout template {template_id}: {name}")


def sync_plan_checks(exercise_ids: list[str], done_date: str) -> list[str]:
    """The app's gym→rehab bridge, mirrored exactly (db.ts
    syncPlanChecksFromGymSets): any active plan item (of a non-resolved
    injury) linked — directly or via the name-fallback in
    active_plan_items_for_exercises — to an exercise this session just logged
    gets its day's check upserted, source='gym'. Additive only; an existing
    manual check wins (ignore-duplicates). Returns the display names of the
    matched exercises (for the CLI's summary line, not the item names)."""
    items = active_plan_items_for_exercises(exercise_ids)
    if not items:
        return []
    _request("POST", "plan_item_checks",
             body=[{"item_id": i["id"], "done_date": done_date, "source": "gym"} for i in items],
             prefer="return=minimal,resolution=ignore-duplicates",
             on_conflict="item_id,done_date")
    names = exercise_names_by_id([i["matched_exercise_id"] for i in items])
    return [names[eid] for eid in dict.fromkeys(i["matched_exercise_id"] for i in items) if eid in names]


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


def remove_gym_plan_checks_for_session(session_id: str) -> list[str]:
    """Retracts the plan_item_checks a session produced, mirroring db.ts'
    removeGymPlanChecksForSession exactly: for each active plan item linked
    (directly or via the name-fallback in active_plan_items_for_exercises) to
    an exercise the session logged, on the session's local done_date, delete
    the source='gym' check for that (item, date) — but ONLY if no OTHER
    still-existing session logs that same exercise on the same local date (a
    second same-day session, e.g. AM/PM, still justifies the check). Manual
    (source='user') checks are never touched.

    Unlike db.ts (which retracts best-effort AFTER a successful app-side
    delete and only logs on failure), the CLI calls this BEFORE deleting the
    session and lets a failure here raise/exit loudly — see cmd_delete for
    the fail-before-delete framing that suits an interactive CLI.

    Returns the display names of the exercises whose checks were retracted
    (for the CLI's summary line). Raises RuntimeError (via _request's
    sys.exit path, or directly) if a lookup/delete step fails; the caller
    decides how to react.

    No session_id on plan_item_checks, so this is derived from the session's
    own exercises + date rather than a direct join — same schema-level
    tradeoff as the app.
    """
    session_rows = _request("GET", "gym_sessions", params={
        "id": f"eq.{session_id}", "select": "id,performed_at", "limit": "1",
    })
    if not session_rows:
        return []  # already gone
    performed_at = session_rows[0]["performed_at"]

    sets = _request("GET", "gym_sets", params={
        "session_id": f"eq.{session_id}", "select": "exercise_id",
    })
    exercise_ids = list(dict.fromkeys(s["exercise_id"] for s in sets))
    if not exercise_ids:
        return []

    items = active_plan_items_for_exercises(exercise_ids)
    if not items:
        return []

    timezone_name = user_timezone()
    done_date = local_date_in_tz(performed_at, timezone_name)

    # Other sessions whose LOCAL date could match: a generous +/-1 UTC-day
    # window around performed_at, precisely filtered below via
    # local_date_in_tz — mirrors the same day-boundary handling used to
    # compute done_date itself (and db.ts' identical window).
    performed_dt = datetime.datetime.fromisoformat(performed_at)
    range_start = (performed_dt - datetime.timedelta(days=1)).isoformat()
    range_end = (performed_dt + datetime.timedelta(days=1)).isoformat()
    nearby_sessions = _request("GET", "gym_sessions", params={
        "id": f"neq.{session_id}",
        "and": f"(performed_at.gte.{range_start},performed_at.lte.{range_end})",
        "select": "id,performed_at",
    })
    same_day_session_ids = [
        s["id"] for s in nearby_sessions
        if local_date_in_tz(s["performed_at"], timezone_name) == done_date
    ]

    exercises_still_logged: set = set()
    if same_day_session_ids:
        surviving_sets = _request("GET", "gym_sets", params={
            "session_id": f"in.({','.join(same_day_session_ids)})", "select": "exercise_id",
        })
        exercises_still_logged = {s["exercise_id"] for s in surviving_sets}

    item_ids_to_unmark = [
        item["id"] for item in items if item["matched_exercise_id"] not in exercises_still_logged
    ]
    if not item_ids_to_unmark:
        return []

    _request("DELETE", "plan_item_checks", params={
        "source": "eq.gym",
        "done_date": f"eq.{done_date}",
        "item_id": f"in.({','.join(item_ids_to_unmark)})",
    }, prefer="return=minimal")

    spared_exercise_ids = {
        item["matched_exercise_id"] for item in items if item["id"] not in item_ids_to_unmark
    }
    retracted_exercise_ids = [
        eid for eid in dict.fromkeys(item["matched_exercise_id"] for item in items)
        if eid not in spared_exercise_ids
    ]
    names = exercise_names_by_id(retracted_exercise_ids)
    return [names[eid] for eid in retracted_exercise_ids if eid in names]


def cmd_delete(args) -> None:
    existing = _request("GET", "gym_sessions", params={
        "id": f"eq.{args.session_id}", "select": "id", "limit": "1",
    })
    if not existing:
        sys.exit(f"session {args.session_id} not found")

    # Retract plan checks BEFORE deleting: gym_sets cascades away with the
    # session, so the (exercise, date) match this depends on must be read
    # first. Unlike the app's best-effort/log-only posture, the CLI fails
    # loudly here — sys.exit, before the session is touched — because an
    # interactive delete has a human to report to and no UI state depending
    # on the delete having happened regardless.
    retracted = remove_gym_plan_checks_for_session(args.session_id)

    _request("DELETE", "gym_sessions", params={"id": f"eq.{args.session_id}"},
             prefer="return=minimal")
    summary = f"deleted session {args.session_id}"
    if retracted:
        summary += " — retracted rehab checks: " + ", ".join(retracted)
    print(summary)


def main() -> None:
    parser = argparse.ArgumentParser(description="Gym log write helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="List recent gym sessions")
    p_list.add_argument("--days", type=int, default=30)
    p_list.set_defaults(func=cmd_list)

    p_template_list = sub.add_parser("template-list", help="List reusable Gym workout templates")
    p_template_list.set_defaults(func=cmd_template_list)

    p_template_apply = sub.add_parser(
        "template-apply", help="Validate and idempotently apply reusable templates from JSON"
    )
    p_template_apply.add_argument("--file", required=True)
    p_template_apply.set_defaults(func=cmd_template_apply)

    p_template_archive = sub.add_parser(
        "template-archive", help="Archive a single template version (leaves runs/other versions untouched)"
    )
    p_template_archive.add_argument("template_id")
    p_template_archive.set_defaults(func=cmd_template_archive)

    p_template_delete = sub.add_parser(
        "template-delete",
        help="Hard-delete a template version; refuses if a session or run history references it",
    )
    p_template_delete.add_argument("template_id")
    p_template_delete.set_defaults(func=cmd_template_delete)

    p_run_start = sub.add_parser("run-start", help="Start/resurrect a run on a template version")
    p_run_start.add_argument("template_id")
    p_run_start.set_defaults(func=cmd_run_start)

    p_run_complete = sub.add_parser("run-complete", help="Close the family's open run (archive/complete)")
    p_run_complete.add_argument("template_id")
    p_run_complete.set_defaults(func=cmd_run_complete)

    p_create_version = sub.add_parser(
        "create-version", help="Save a new version of an existing template family from JSON"
    )
    p_create_version.add_argument("base_template_id")
    p_create_version.add_argument("--file", required=True)
    p_create_version.set_defaults(func=cmd_create_version)

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
