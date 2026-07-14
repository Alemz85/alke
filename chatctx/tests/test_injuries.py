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
    item = {
        "name": "Daily mobility",
        "kind": "exercise",
        "start_week": 1,
        "weekly_target": 14,
        "green_min": 10,
        "yellow_min": 7,
        "note": None,
        "exercise": None,
        "target_sets": None,
        "target_reps": None,
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
