import pytest
from argparse import Namespace
import json

import chatctx.injuries as injuries
from chatctx.injuries import (
    cmd_note,
    cmd_plan_apply,
    cmd_show,
    current_plan_week,
    format_period,
    validate_plan_document,
)


def note_args(**overrides):
    args = {
        "injury_id": "injury-1", "note": "…", "source": "chat", "pain": None,
        "date": None, "until": None, "precision": None, "context": None, "workout": None,
    }
    args.update(overrides)
    return Namespace(**args)


def capture_note_body(monkeypatch, args, today="2026-07-14"):
    captured = {}

    def request(method, path, **kwargs):
        captured.update(method=method, path=path, body=kwargs.get("body"))
        return []

    monkeypatch.setattr(injuries, "_request", request)
    monkeypatch.setattr(injuries, "user_today", lambda: today)
    cmd_note(args)
    return captured["body"]


def exercise(**overrides):
    """Every exercise-kind item is catalog-backed now, so the default fixture
    carries a link (name resolved elsewhere) plus target_sets/target_reps —
    with structured `steps` still attached as plan-item detail (routines
    stay tabular even though the item itself links to the catalog)."""
    item = {
        "name": "Daily mobility",
        "kind": "exercise",
        "start_week": 1,
        "weekly_target": 14,
        "green_min": 10,
        "yellow_min": 7,
        "note": None,
        "exercise": "Daily Mobility Routine",
        "create": None,
        "body_part": None,
        "target_sets": 2,
        "target_reps": 1,
        "steps": [{
            "name": "Straight-knee calf stretch",
            "sets": 2,
            "reps": None,
            "duration_seconds": 30,
            "distance_m": None,
            "per_side": True,
            "note": None,
        }],
    }
    item.update(overrides)
    return item


def test_validation_preserves_start_week():
    normalized = validate_plan_document({"approach": "Stack phases.", "items": [exercise(start_week=3)]})
    assert normalized[0]["start_week"] == 3


def test_validation_requires_start_week():
    with pytest.raises(SystemExit, match="start_week"):
        validate_plan_document({"approach": "Stack phases.", "items": [exercise(start_week=None)]})


def test_validation_accepts_more_than_eight_items():
    items = [exercise(name=f"Exercise {index}") for index in range(10)]
    assert len(validate_plan_document({"approach": "Comprehensive.", "items": items})) == 10


def test_validation_rejects_integer_per_side():
    # 1 slipped through the old `in (True, False, None)` check because
    # Python's bool/int aliasing makes `1 in (True, ...)` true.
    step = dict(exercise()["steps"][0], per_side=1)
    with pytest.raises(SystemExit, match="per_side"):
        validate_plan_document({"approach": "Stack phases.", "items": [exercise(steps=[step])]})


def test_validation_rejects_non_string_note_and_exercise():
    with pytest.raises(SystemExit, match=r"note must be a string"):
        validate_plan_document({"approach": "Stack phases.", "items": [exercise(note=123)]})
    with pytest.raises(SystemExit, match=r"exercise must be a string"):
        validate_plan_document({"approach": "Stack phases.", "items": [exercise(exercise=123)]})


def test_validation_rejects_blank_exercise_link():
    with pytest.raises(SystemExit, match="must not be blank"):
        validate_plan_document({"approach": "Stack phases.", "items": [exercise(exercise="  ")]})


# ---- Every exercise-kind item is catalog-backed now (user overrule of the
# old "home-mobility items may stay unlinked" rule) ----


def test_validation_requires_catalog_link_for_every_exercise_item():
    with pytest.raises(SystemExit, match="require a catalog exercise link"):
        validate_plan_document({"approach": "Stack phases.", "items": [exercise(exercise=None)]})


def test_validation_still_requires_target_sets_and_reps_when_linked():
    with pytest.raises(SystemExit, match="lacks target_sets/target_reps"):
        validate_plan_document({
            "approach": "Stack phases.",
            "items": [exercise(target_sets=None, target_reps=None)],
        })


def test_validation_allows_a_linked_exercise_to_also_carry_steps():
    # Composite-routine detail (steps) is plan-item detail alongside a
    # catalog link now, not mutually exclusive with it — the old "linked
    # exercise cannot also carry steps" rule is gone.
    normalized = validate_plan_document({"approach": "Stack phases.", "items": [exercise()]})
    assert normalized[0]["exercise"] == "Daily Mobility Routine"
    assert normalized[0]["steps"][0]["name"] == "Straight-knee calf stretch"


def test_validation_accepts_linked_exercise_without_steps():
    normalized = validate_plan_document({
        "approach": "Stack phases.", "items": [exercise(steps=None)],
    })
    assert normalized[0]["steps"] is None


def test_validation_defaults_create_to_false():
    normalized = validate_plan_document({"approach": "Stack phases.", "items": [exercise()]})
    assert normalized[0]["create"] is False


def test_validation_rejects_non_boolean_create():
    with pytest.raises(SystemExit, match="create must be true, false, or null"):
        validate_plan_document({"approach": "Stack phases.", "items": [exercise(create=1)]})


def test_validation_accepts_true_create_with_body_part():
    normalized = validate_plan_document({
        "approach": "Stack phases.",
        "items": [exercise(create=True, body_part="legs")],
    })
    assert normalized[0]["create"] is True
    assert normalized[0]["body_part"] == "legs"


def test_validation_rejects_invalid_body_part():
    with pytest.raises(SystemExit, match="body_part must be null"):
        validate_plan_document({
            "approach": "Stack phases.",
            "items": [exercise(create=True, body_part="not-a-body-part")],
        })


def test_validation_rejects_body_part_without_create():
    with pytest.raises(SystemExit, match="body_part only applies"):
        validate_plan_document({
            "approach": "Stack phases.",
            "items": [exercise(create=False, body_part="legs")],
        })


def test_validation_rejects_create_on_constraint_items():
    with pytest.raises(SystemExit, match="constraint carries targets or Gym fields"):
        validate_plan_document({
            "approach": "Stack phases.",
            "items": [{
                "name": "No overhead pressing", "kind": "constraint", "start_week": 1,
                "weekly_target": None, "green_min": None, "yellow_min": None, "note": None,
                "exercise": None, "create": True, "body_part": None,
                "target_sets": None, "target_reps": None, "steps": None,
            }],
        })


def test_validation_rejects_create_on_habit_items():
    with pytest.raises(SystemExit, match="only exercises may carry Gym fields"):
        validate_plan_document({
            "approach": "Stack phases.",
            "items": [{
                "name": "Wear supportive shoes", "kind": "habit", "start_week": 1,
                "weekly_target": None, "green_min": None, "yellow_min": None, "note": None,
                "exercise": None, "create": True, "body_part": None,
                "target_sets": None, "target_reps": None, "steps": None,
            }],
        })


# ---- resolve_exercise: resolve-or-create (mirrors gym.py's resolve_exercise) ----


def test_resolve_exercise_returns_exact_match_without_creating():
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "exercises":
            params = kwargs.get("params") or {}
            if params.get("name_key") == "eq.heel walk":
                return [{"id": "ex-1", "name": "Heel Walk"}]
            return []
        raise AssertionError((method, path))

    import chatctx.injuries as injuries_module
    orig = injuries_module._request
    injuries_module._request = request
    try:
        result = injuries_module.resolve_exercise("Heel Walk", create=False, body_part=None)
    finally:
        injuries_module._request = orig

    assert result == {"id": "ex-1", "name": "Heel Walk"}
    assert not any(method == "POST" for method, _, _ in calls)


def test_resolve_exercise_creates_a_user_row_when_create_true_and_no_match():
    import chatctx.injuries as injuries_module
    created_bodies = []

    def request(method, path, **kwargs):
        if method == "GET" and path == "exercises":
            return []
        if method == "POST" and path == "exercises":
            created_bodies.append(kwargs["body"])
            return [{"id": "new-ex", "name": kwargs["body"]["name"]}]
        raise AssertionError((method, path))

    orig = injuries_module._request
    injuries_module._request = request
    try:
        result = injuries_module.resolve_exercise("Ankle mobility routine", create=True, body_part="legs")
    finally:
        injuries_module._request = orig

    assert result == {"id": "new-ex", "name": "Ankle mobility routine"}
    assert created_bodies == [{"name": "Ankle mobility routine", "body_part": "legs", "source": "user"}]


def test_resolve_exercise_rejects_invalid_body_part_on_create():
    import chatctx.injuries as injuries_module

    def request(method, path, **kwargs):
        if method == "GET" and path == "exercises":
            return []
        raise AssertionError((method, path))

    orig = injuries_module._request
    injuries_module._request = request
    try:
        with pytest.raises(SystemExit, match="invalid body_part"):
            injuries_module.resolve_exercise("Something", create=True, body_part="not-a-part")
    finally:
        injuries_module._request = orig


def test_resolve_exercise_aborts_with_near_matches_when_create_false():
    import chatctx.injuries as injuries_module

    def request(method, path, **kwargs):
        if method == "GET" and path == "exercises":
            params = kwargs.get("params") or {}
            if params.get("name"):
                return [{"name": "Heel Walk"}]
            return []
        raise AssertionError((method, path))

    orig = injuries_module._request
    injuries_module._request = request
    try:
        with pytest.raises(SystemExit, match='add "create": true'):
            injuries_module.resolve_exercise("Heel walks", create=False, body_part=None)
    finally:
        injuries_module._request = orig


# ---- cmd_plan_apply: resolve-or-create end to end via the plan document ----


def test_plan_apply_creates_a_catalog_exercise_when_item_opts_in(monkeypatch, tmp_path):
    item = exercise(exercise="Ankle mobility routine", create=True, body_part="legs", steps=None)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps({"approach": "Stack phases.", "items": [item]}))
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "injuries":
            return [{"id": "injury-1", "plan_started_at": "2026-06-01"}]
        if method == "GET" and path == "recovery_plan_items":
            return []
        if method == "GET" and path == "exercises":
            return []  # no existing match — forces the create path
        if method == "POST" and path == "exercises":
            return [{"id": "new-ex", "name": kwargs["body"]["name"]}]
        if method == "PATCH" and path == "injuries":
            return []
        if method == "POST" and path == "recovery_plan_items":
            return [{"id": "item-1"}]
        return []

    monkeypatch.setattr(injuries, "_request", request)
    monkeypatch.setattr(injuries, "user_today", lambda: "2026-07-13")
    cmd_plan_apply(Namespace(injury_id="injury-1", file=str(plan_file)))

    create_call = next(kwargs for method, path, kwargs in calls if method == "POST" and path == "exercises")
    assert create_call["body"] == {"name": "Ankle mobility routine", "body_part": "legs", "source": "user"}
    item_post = next(kwargs for method, path, kwargs in calls if method == "POST" and path == "recovery_plan_items")
    assert item_post["body"]["exercise_id"] == "new-ex"
    # create/body_part are consumed by resolution, not persisted on the item row.
    assert "create" not in item_post["body"]
    assert "body_part" not in item_post["body"]


def test_plan_apply_aborts_without_writes_when_link_is_ambiguous(monkeypatch, tmp_path):
    item = exercise(exercise="Some Typo Name", create=False)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps({"approach": "Stack phases.", "items": [item]}))
    writes = []

    def request(method, path, **kwargs):
        if method == "GET" and path == "injuries":
            return [{"id": "injury-1", "plan_started_at": "2026-06-01"}]
        if method == "GET" and path == "recovery_plan_items":
            return []
        if method == "GET" and path == "exercises":
            return []
        if method in ("POST", "PATCH", "DELETE"):
            writes.append((method, path))
            return []
        return []

    monkeypatch.setattr(injuries, "_request", request)
    monkeypatch.setattr(injuries, "user_today", lambda: "2026-07-13")

    with pytest.raises(SystemExit, match="no exact exercise match"):
        cmd_plan_apply(Namespace(injury_id="injury-1", file=str(plan_file)))

    assert writes == []


# ---- cmd_plan_add / cmd_plan_update: --create / --body-part wiring ----


def plan_add_args(**overrides):
    args = {
        "injury_id": "injury-1", "name": "Ankle mobility routine", "kind": "exercise",
        "start_week": 1, "target": None, "note": None, "exercise": None,
        "create": False, "body_part": None, "green_min": None, "yellow_min": None,
        "target_sets": None, "target_reps": None,
    }
    args.update(overrides)
    return Namespace(**args)


def test_plan_add_creates_exercise_when_create_flag_set(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "exercises":
            return []
        if method == "POST" and path == "exercises":
            return [{"id": "new-ex", "name": kwargs["body"]["name"]}]
        if method == "POST" and path == "recovery_plan_items":
            return [{"id": "item-1"}]
        return []

    monkeypatch.setattr(injuries, "_request", request)
    injuries.cmd_plan_add(plan_add_args(exercise="Ankle mobility routine", create=True, body_part="legs"))

    item_post = next(kwargs for method, path, kwargs in calls if method == "POST" and path == "recovery_plan_items")
    assert item_post["body"]["exercise_id"] == "new-ex"


def test_plan_add_rejects_body_part_without_create():
    with pytest.raises(SystemExit, match="--body-part only applies together with --create"):
        injuries.cmd_plan_add(plan_add_args(exercise="Ankle mobility routine", create=False, body_part="legs"))


def test_plan_add_rejects_create_without_exercise():
    with pytest.raises(SystemExit, match="--create requires --exercise"):
        injuries.cmd_plan_add(plan_add_args(exercise=None, create=True))


def plan_update_args(**overrides):
    args = {
        "id": "item-1", "name": None, "kind": None, "start_week": None, "target": None,
        "note": None, "active": None, "exercise": None, "create": False, "body_part": None,
        "green_min": None, "yellow_min": None, "target_sets": None, "target_reps": None,
        "steps_file": None,
    }
    args.update(overrides)
    return Namespace(**args)


def test_plan_update_creates_exercise_when_create_flag_set(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "exercises":
            return []
        if method == "POST" and path == "exercises":
            return [{"id": "new-ex", "name": kwargs["body"]["name"]}]
        if method == "PATCH" and path == "recovery_plan_items":
            return []
        return []

    monkeypatch.setattr(injuries, "_request", request)
    injuries.cmd_plan_update(plan_update_args(exercise="Heel walks", create=True, body_part="legs"))

    patch_call = next(kwargs for method, path, kwargs in calls if method == "PATCH" and path == "recovery_plan_items")
    assert patch_call["body"]["exercise_id"] == "new-ex"


def test_plan_update_unlink_with_none_does_not_require_create_flag(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return []

    monkeypatch.setattr(injuries, "_request", request)
    injuries.cmd_plan_update(plan_update_args(exercise="none"))

    patch_call = next(kwargs for method, path, kwargs in calls if method == "PATCH" and path == "recovery_plan_items")
    assert patch_call["body"]["exercise_id"] is None


def test_format_period_renders_only_known_precision():
    assert format_period("2025-03-10", None, "day") == "2025-03-10"
    assert format_period("2025-03-10", None, "month") == "2025-03"
    assert format_period("2025-01-01", None, "year") == "2025"
    assert format_period("2025-01-01", "2026-03-01", "year") == "2025 → 2026"
    assert format_period("2025-03-14", "2025-04-28", "day") == "2025-03-14 → 2025-04-28"
    # An end that collapses to the same rendered value shows as a single date.
    assert format_period("2026-05-01", "2026-05-20", "month") == "2026-05"
    assert format_period(None, None, None) == ""


def test_note_records_span_and_precision(monkeypatch):
    body = capture_note_body(monkeypatch, note_args(
        note="Quiet since", pain=0, date="2025-03-14", until="2025-04-28", precision="day"))
    assert body["entry_date"] == "2025-03-14"
    assert body["entry_end_date"] == "2025-04-28"
    assert body["date_precision"] == "day"
    assert body["pain_level"] == 0


def test_note_span_without_start_defaults_to_today(monkeypatch):
    body = capture_note_body(monkeypatch, note_args(until="2026-08-01"))
    assert body["entry_date"] == "2026-07-14"
    assert body["entry_end_date"] == "2026-08-01"


def test_note_single_day_stays_span_free(monkeypatch):
    body = capture_note_body(monkeypatch, note_args(date="2026-07-10", pain=3))
    assert "entry_end_date" not in body
    assert "date_precision" not in body


def test_note_rejects_backwards_span(monkeypatch):
    with pytest.raises(SystemExit, match="on or after"):
        capture_note_body(monkeypatch, note_args(date="2026-07-10", until="2026-07-01"))


def test_note_rejects_malformed_date(monkeypatch):
    with pytest.raises(SystemExit, match="expected YYYY-MM-DD"):
        capture_note_body(monkeypatch, note_args(date="last may"))


def test_current_plan_week_uses_seven_day_phases():
    assert current_plan_week("2026-07-01", "2026-07-01") == 1
    assert current_plan_week("2026-07-01", "2026-07-07") == 1
    assert current_plan_week("2026-07-01", "2026-07-08") == 2
    assert current_plan_week("2026-07-01", "2026-06-30") == 0
    assert current_plan_week(None, "2026-07-01") is None


def test_show_prints_injury_notes_and_phase_aware_plan(monkeypatch, capsys):
    def request(method, path, **kwargs):
        assert method == "GET"
        if path == "injuries":
            return [{
                "id": "injury-1",
                "name": "Knee pain",
                "body_area": "ankles",
                "status": "recovering",
                "severity": None,
                "started_at": None,
                "plan_started_at": "2026-07-13",
                "summary": "Running provokes symptoms.",
                "recovery_plan": "Build tolerance progressively.",
            }]
        if path == "injury_notes":
            return [{
                "entry_date": "2026-07-12",
                "source": "user",
                "pain_level": 3,
                "note": "Sore after running.",
            }]
        if path == "recovery_plan_items":
            return [{
                "id": "item-1",
                "name": "Heel walks",
                "kind": "exercise",
                "start_week": 2,
                "weekly_target": 4,
                "green_min": 3,
                "yellow_min": 2,
                "target_sets": None,
                "target_reps": None,
                "steps": [{"name": "Heel walks", "sets": 2, "distance_m": 20}],
                "note": "Controlled pace.",
                "active": True,
                "exercise": None,
            }]
        raise AssertionError(path)

    monkeypatch.setattr(injuries, "_request", request)
    monkeypatch.setattr(injuries, "user_today", lambda: "2026-07-13")

    cmd_show(Namespace(injury_id="injury-1"))

    output = capsys.readouterr().out
    assert "Knee pain" in output
    assert "current plan week: 1" in output
    assert "Sore after running." in output
    assert "Heel walks" in output
    assert "future" in output


@pytest.mark.parametrize(
    ("existing_start", "expected_start"),
    [(None, "2026-07-13"), ("2026-06-01", None)],
)
def test_plan_apply_sets_only_the_initial_plan_start(
    monkeypatch, tmp_path, existing_start, expected_start
):
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps({"approach": "Stack phases.", "items": [exercise()]}))
    patches = []

    def request(method, path, **kwargs):
        if method == "GET" and path == "injuries":
            return [{"id": "injury-1", "plan_started_at": existing_start}]
        if method == "GET" and path == "recovery_plan_items":
            return []
        if method == "GET" and path == "exercises":
            params = kwargs.get("params") or {}
            if params.get("name_key") == "eq.daily mobility routine":
                return [{"id": "ex-1", "name": "Daily Mobility Routine"}]
            return []
        if method == "PATCH" and path == "injuries":
            patches.append(kwargs["body"])
            return []
        if method == "POST" and path == "recovery_plan_items":
            return [{"id": "item-1"}]
        return []

    monkeypatch.setattr(injuries, "_request", request)
    monkeypatch.setattr(injuries, "user_today", lambda: "2026-07-13")
    cmd_plan_apply(Namespace(injury_id="injury-1", file=str(plan_file)))

    assert patches
    assert patches[0].get("plan_started_at") == expected_start
