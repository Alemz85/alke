import uuid

import pytest

import chatctx.gym as gym
from chatctx.gym import (
    apply_template_document,
    archive_template_version,
    complete_template_run,
    create_template_version,
    delete_template_version,
    start_template_run,
    validate_template_document,
)


def template(name="Full body A"):
    return {
        "name": name,
        "notes": "45-60 minutes. Add reps before load.",
        "default_rest_s": 90,
        "exercises": [{
            "exercise": "Back Squat",
            "sets": 3,
            "reps": 8,
            "kg": None,
            "note": "Leave 2 reps in reserve.",
            "rest_after_s": 180,
        }],
    }


def test_validation_preserves_template_and_exercise_order():
    plan = {"templates": [template("A"), template("B")]}
    normalized = validate_template_document(plan)
    assert [entry["name"] for entry in normalized] == ["A", "B"]
    assert normalized[0]["exercises"][0]["sets"] == 3
    assert normalized[0]["default_rest_s"] == 90
    assert normalized[0]["exercises"][0]["rest_after_s"] == 180


def test_validation_accepts_missing_rest_fields():
    plan = template()
    del plan["default_rest_s"]
    del plan["exercises"][0]["rest_after_s"]
    normalized = validate_template_document({"templates": [plan]})
    assert normalized[0]["default_rest_s"] is None
    assert normalized[0]["exercises"][0]["rest_after_s"] is None


def test_validation_rejects_out_of_range_default_rest_s():
    invalid = template()
    invalid["default_rest_s"] = 3601
    with pytest.raises(SystemExit, match="default_rest_s"):
        validate_template_document({"templates": [invalid]})


def test_validation_rejects_out_of_range_rest_after_s():
    invalid = template()
    invalid["exercises"][0]["rest_after_s"] = -1
    with pytest.raises(SystemExit, match="rest_after_s"):
        validate_template_document({"templates": [invalid]})


def test_validation_rejects_duplicate_template_names():
    with pytest.raises(SystemExit, match="duplicated"):
        validate_template_document({"templates": [template("A"), template("a")]})


def test_validation_rejects_incomplete_prescriptions():
    invalid = template()
    invalid["exercises"][0]["reps"] = None
    with pytest.raises(SystemExit, match="reps"):
        validate_template_document({"templates": [invalid]})


def test_apply_updates_a_named_template_without_creating_a_session(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            return [{"id": "template-1", "name": "Full body A", "family_id": "family-1"}]
        return []

    monkeypatch.setattr(gym, "_request", request)
    monkeypatch.setattr(gym, "resolve_exercise", lambda *_args, **_kwargs: {"id": "exercise-1", "name": "Back Squat"})

    result = apply_template_document({"templates": [template()]})

    assert result == [("template-1", "Full body A", "updated")]
    lookup = next(kwargs for method, path, kwargs in calls
                  if method == "GET" and path == "gym_templates")
    assert lookup["params"]["is_current"] == "is.true"
    patch = next(kwargs["body"] for method, path, kwargs in calls
                 if method == "PATCH" and path == "gym_templates")
    assert patch["default_rest_s"] == 90
    assert any(method == "DELETE" and path == "gym_template_exercises" for method, path, _ in calls)
    insert = next(kwargs["body"] for method, path, kwargs in calls
                  if method == "POST" and path == "gym_template_exercises")
    assert insert[0]["position"] == 0
    assert insert[0]["exercise_id"] == "exercise-1"
    assert insert[0]["rest_after_s"] == 180
    assert all(path != "gym_sessions" for _, path, _ in calls)


def test_apply_does_not_abort_on_a_families_own_prior_versions(monkeypatch):
    """Regression for agent_log #7-adjacent bug: versioning gives every
    version in a family the same name, so the lookup must only consider each
    family's CURRENT version — not hard-abort on the family's own history."""
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            # Only the current version comes back (is_current=true filter);
            # an old, non-current version of the SAME family sharing the name
            # must never appear here or this test would need to assert abort.
            return [{"id": "template-2", "name": "Full body A", "family_id": "family-1"}]
        if method == "POST" and path == "gym_template_exercises":
            return []
        return []

    monkeypatch.setattr(gym, "_request", request)
    monkeypatch.setattr(gym, "resolve_exercise", lambda *_a, **_k: {"id": "exercise-1", "name": "Back Squat"})

    result = apply_template_document({"templates": [template("Full body A")]})

    assert result == [("template-2", "Full body A", "updated")]


def test_apply_aborts_on_genuine_cross_family_name_collision(monkeypatch):
    """Two DIFFERENT families' current versions sharing a name is real
    ambiguity and must still hard-abort."""
    def request(method, path, **kwargs):
        if method == "GET" and path == "gym_templates":
            return [
                {"id": "template-1", "name": "Full body A", "family_id": "family-1"},
                {"id": "template-9", "name": "Full body A", "family_id": "family-9"},
            ]
        return []

    monkeypatch.setattr(gym, "_request", request)
    monkeypatch.setattr(gym, "resolve_exercise", lambda *_a, **_k: {"id": "exercise-1", "name": "Back Squat"})

    with pytest.raises(SystemExit, match="duplicate existing template name"):
        apply_template_document({"templates": [template("Full body A")]})


def test_apply_create_branch_sets_family_id_version_and_is_current(monkeypatch):
    """Regression for agent_log #7: a fresh create must satisfy gym_templates'
    NOT NULL family_id (and the versioning columns), not just name/notes/
    default_rest_s/archived."""
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            return []  # no existing template with this name
        if method == "POST" and path == "gym_templates":
            return [{"id": "template-new", "name": "Full body A"}]
        return []

    monkeypatch.setattr(gym, "_request", request)
    monkeypatch.setattr(gym, "resolve_exercise", lambda *_a, **_k: {"id": "exercise-1", "name": "Back Squat"})

    result = apply_template_document({"templates": [template("Full body A")]})

    assert result == [("template-new", "Full body A", "created")]
    create = next(kwargs["body"] for method, path, kwargs in calls
                  if method == "POST" and path == "gym_templates")
    assert create["family_id"]
    # a real (parseable) uuid4, not a placeholder string
    assert uuid.UUID(create["family_id"]).version == 4
    assert create["version"] == 1
    assert create["is_current"] is True


def test_run_start_is_a_no_op_when_the_template_already_has_an_open_run(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            return [{"family_id": "family-1"}]
        if method == "GET" and path == "gym_template_runs":
            return [{"id": "run-1", "template_id": "template-1", "started_at": "2026-07-01",
                      "ended_at": None, "source": "user"}]
        return []

    monkeypatch.setattr(gym, "_request", request)

    result = start_template_run("template-1")

    assert result["id"] == "run-1"
    assert all(method != "POST" for method, path, _ in calls if path == "gym_template_runs")
    assert all(method != "PATCH" for method, path, _ in calls if path == "gym_template_runs")


def test_run_start_closes_sibling_runs_before_opening_a_new_one(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            params = kwargs.get("params") or {}
            if params.get("id") == "eq.template-2":
                return [{"family_id": "family-1"}]
            return [{"id": "template-1"}, {"id": "template-2"}]
        if method == "GET" and path == "gym_template_runs":
            return []  # nothing open on template-2 itself
        if method == "POST" and path == "gym_template_runs":
            return [{"id": "run-2", "template_id": "template-2", "started_at": "2026-07-13",
                      "ended_at": None, "source": "chat"}]
        return []

    monkeypatch.setattr(gym, "_request", request)

    result = start_template_run("template-2")

    assert result["template_id"] == "template-2"
    assert result["source"] == "chat"
    close = next(kwargs for method, path, kwargs in calls
                 if method == "PATCH" and path == "gym_template_runs")
    assert close["body"] == {"ended_at": gym.datetime.date.today().isoformat()}
    assert "template-1" in close["params"]["template_id"]
    assert "template-2" in close["params"]["template_id"]
    create = next(kwargs["body"] for method, path, kwargs in calls
                  if method == "POST" and path == "gym_template_runs")
    assert create == {"template_id": "template-2", "started_at": gym.datetime.date.today().isoformat(),
                       "source": "chat"}


def test_run_complete_closes_the_family_open_run(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            params = kwargs.get("params") or {}
            if params.get("id") == "eq.template-1":
                return [{"family_id": "family-1"}]
            return [{"id": "template-1"}, {"id": "template-2"}]
        if method == "PATCH" and path == "gym_template_runs":
            return [{"id": "run-1", "template_id": "template-1", "started_at": "2026-07-01",
                      "ended_at": gym.datetime.date.today().isoformat(), "source": "user"}]
        return []

    monkeypatch.setattr(gym, "_request", request)

    result = complete_template_run("template-1")

    assert result["id"] == "run-1"
    patch = next(kwargs for method, path, kwargs in calls
                 if method == "PATCH" and path == "gym_template_runs")
    assert patch["body"] == {"ended_at": gym.datetime.date.today().isoformat()}
    assert patch["params"]["ended_at"] == "is.null"


def test_run_complete_returns_none_when_no_open_run(monkeypatch):
    def request(method, path, **kwargs):
        if method == "GET" and path == "gym_templates":
            params = kwargs.get("params") or {}
            if params.get("id") == "eq.template-1":
                return [{"family_id": "family-1"}]
            return [{"id": "template-1"}]
        if method == "PATCH" and path == "gym_template_runs":
            return []
        return []

    monkeypatch.setattr(gym, "_request", request)

    assert complete_template_run("template-1") is None


def test_create_version_preserves_family_bumps_version_and_flips_current(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            params = kwargs.get("params") or {}
            if params.get("id") == "eq.template-1":
                return [{"family_id": "family-1"}]
            if "order" in params:  # latest-version lookup
                return [{"version": 2}]
            return [{"id": "template-1"}, {"id": "template-3"}]  # family member ids
        if method == "POST" and path == "gym_templates":
            return [{"id": "template-3", "name": "Full body A", "family_id": "family-1",
                      "version": 3, "is_current": True}]
        return []

    monkeypatch.setattr(gym, "_request", request)
    monkeypatch.setattr(gym, "resolve_exercise", lambda *_a, **_k: {"id": "exercise-1", "name": "Back Squat"})

    new_template = create_template_version("template-1", {"templates": [template()]})

    assert new_template == {"id": "template-3", "name": "Full body A", "family_id": "family-1",
                             "version": 3, "is_current": True}
    create = next(kwargs["body"] for method, path, kwargs in calls
                  if method == "POST" and path == "gym_templates")
    assert create["family_id"] == "family-1"
    assert create["version"] == 3
    assert create["is_current"] is True
    items = next(kwargs["body"] for method, path, kwargs in calls
                 if method == "POST" and path == "gym_template_exercises")
    assert items[0]["template_id"] == "template-3"
    demote = next(kwargs for method, path, kwargs in calls
                  if method == "PATCH" and path == "gym_templates")
    assert demote["body"] == {"is_current": False}
    assert demote["params"]["id"] == "neq.template-3"
    run_carry = next((kwargs for method, path, kwargs in calls
                       if method == "PATCH" and path == "gym_template_runs"), None)
    assert run_carry is not None
    assert run_carry["body"] == {"template_id": "template-3"}
    assert "template-1" in run_carry["params"]["template_id"]


def test_create_version_rejects_more_than_one_template(monkeypatch):
    monkeypatch.setattr(gym, "_request", lambda *_a, **_k: [{"family_id": "family-1"}])
    with pytest.raises(SystemExit, match="exactly one template"):
        create_template_version("template-1", {"templates": [template("A"), template("B")]})


def test_archive_template_version_touches_only_that_version(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            return [{"family_id": "family-1"}]
        return []

    monkeypatch.setattr(gym, "_request", request)

    archive_template_version("template-1")

    patch = next(kwargs for method, path, kwargs in calls
                 if method == "PATCH" and path == "gym_templates")
    assert patch["params"]["id"] == "eq.template-1"
    assert patch["body"]["archived"] is True
    assert all(path not in ("gym_template_runs",) for _, path, _ in calls)


def test_delete_template_version_refuses_when_sessions_reference_it(monkeypatch):
    def request(method, path, **kwargs):
        if method == "GET" and path == "gym_templates":
            return [{"family_id": "family-1"}]
        if method == "GET" and path == "gym_sessions":
            return [{"id": "session-1"}]
        return []

    monkeypatch.setattr(gym, "_request", request)

    with pytest.raises(SystemExit, match="template-archive"):
        delete_template_version("template-1")


def test_delete_template_version_refuses_when_session_templates_reference_it(monkeypatch):
    def request(method, path, **kwargs):
        if method == "GET" and path == "gym_templates":
            return [{"family_id": "family-1"}]
        if method == "GET" and path == "gym_sessions":
            return []
        if method == "GET" and path == "gym_session_templates":
            return [{"session_id": "session-1"}]
        return []

    monkeypatch.setattr(gym, "_request", request)

    with pytest.raises(SystemExit, match="template-archive"):
        delete_template_version("template-1")


def test_delete_template_version_refuses_when_runs_reference_it(monkeypatch):
    def request(method, path, **kwargs):
        if method == "GET" and path == "gym_templates":
            return [{"family_id": "family-1"}]
        if method == "GET" and path == "gym_sessions":
            return []
        if method == "GET" and path == "gym_session_templates":
            return []
        if method == "GET" and path == "gym_template_runs":
            return [{"id": "run-1"}]
        return []

    monkeypatch.setattr(gym, "_request", request)

    with pytest.raises(SystemExit, match="template-archive"):
        delete_template_version("template-1")


def test_delete_template_version_deletes_exercises_then_template_when_unreferenced(monkeypatch):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "gym_templates":
            return [{"family_id": "family-1"}]
        if method == "GET" and path in ("gym_sessions", "gym_session_templates", "gym_template_runs"):
            return []
        return []

    monkeypatch.setattr(gym, "_request", request)

    delete_template_version("template-1")

    delete_paths = [path for method, path, _ in calls if method == "DELETE"]
    assert delete_paths == ["gym_template_exercises", "gym_templates"]
    exercise_delete = next(kwargs for method, path, kwargs in calls
                           if method == "DELETE" and path == "gym_template_exercises")
    assert exercise_delete["params"]["template_id"] == "eq.template-1"
    template_delete = next(kwargs for method, path, kwargs in calls
                           if method == "DELETE" and path == "gym_templates")
    assert template_delete["params"]["id"] == "eq.template-1"
