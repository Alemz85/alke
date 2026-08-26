"""F1 regression: the incremental daily CTL/ATL/ACWR chain must preserve the
stored TRIMP of workouts OUTSIDE the recompute window.

Before the fix, trimp_by_id was seeded only from the freshly-recomputed
RECOMPUTE_DAYS window, so every older workout resolved to 0.0 — silently
rewriting all pre-window computed_daily rows (and their CTL/ATL/ACWR) to zero on
each nightly run. This drives run(full=False) through a fully faked db layer and
asserts a pre-window workout's day keeps its stored trimp_total."""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from metrics import compute, db

TZ = "Europe/Paris"
NOW = datetime(2026, 7, 11, 3, 30, tzinfo=timezone.utc)


def _iso(d, hour=10):
    return f"{d.isoformat()}T{hour:02d}:00:00Z"


def test_incremental_chain_preserves_prewindow_trimp(monkeypatch):
    today = NOW.astimezone(ZoneInfo(TZ)).date()
    # One OLD workout 200 days ago (well outside the 60-day RECOMPUTE_DAYS window)
    # and one recent workout inside it. The old one already has a stored trimp in
    # computed_workout; the incremental run does NOT recompute it.
    old_day = today - timedelta(days=200)
    recent_day = today - timedelta(days=5)
    old_id, recent_id = "old-workout", "recent-workout"

    workouts_all = [
        {"id": old_id, "type": "pool_swim", "start_at": _iso(old_day),
         "duration_s": 1800, "distance_m": 1500, "avg_hr": 130, "max_hr": 150,
         "external_id": "e-old", "end_at": _iso(old_day, 11)},
        {"id": recent_id, "type": "pool_swim", "start_at": _iso(recent_day),
         "duration_s": 1800, "distance_m": 1500, "avg_hr": 130, "max_hr": 150,
         "external_id": "e-recent", "end_at": _iso(recent_day, 11)},
    ]

    # Stored per-workout metrics: the OLD workout carries trimp=58.4,
    # the recent one an arbitrary value. The window fetch (since != None) returns
    # only the recent workout, so only IT gets recomputed this run.
    stored_computed = [
        {"workout_id": old_id, "trimp": 58.4, "ef": None,
         "decoupling_pct": None, "hrr60": None,
         "time_in_zones": {"z1": 300, "z2": 900, "z3": 600, "z4": 0, "z5": 0}},
        {"workout_id": recent_id, "trimp": 20.0, "ef": None,
         "decoupling_pct": None, "hrr60": None,
         "time_in_zones": {"z1": 300, "z2": 900, "z3": 600, "z4": 0, "z5": 0}},
    ]

    def fake_fetch_workouts(sb, since_iso):
        if since_iso is None:
            return workouts_all
        return [w for w in workouts_all if w["start_at"] >= since_iso]

    captured = {}
    monkeypatch.setattr(db, "client", lambda: None)
    monkeypatch.setattr(db, "fetch_user_config", lambda sb: {"timezone": TZ, "hr_max": 190})
    monkeypatch.setattr(db, "fetch_daily_metrics", lambda sb: [])
    # Real HR samples for the recent workout so its RECOMPUTE yields trimp>0 (the
    # overlay of fresh-over-stored must survive for the window workout).
    def recent_bpm(offset):
        if offset < 300:
            return 120
        if 600 <= offset < 900:
            return 132
        return 80

    recent_samples = [(s, recent_bpm(s)) for s in range(0, 1800, 10)]

    def fake_hr_samples(sb, ids):
        return {i: (recent_samples if i == recent_id else []) for i in ids}

    monkeypatch.setattr(db, "fetch_workouts", fake_fetch_workouts)
    monkeypatch.setattr(db, "fetch_hr_samples", fake_hr_samples)
    monkeypatch.setattr(
        db,
        "fetch_swim_sets",
        lambda sb, ids: {
            i: ([
                {"start_offset_s": 0, "duration_s": 300, "distance_m": 250},
                {"start_offset_s": 600, "duration_s": 300, "distance_m": 250},
            ]
                if i == recent_id else [])
            for i in ids
        },
        raising=False,
    )
    monkeypatch.setattr(db, "update_hr_max", lambda sb, v: None)
    monkeypatch.setattr(
        db, "upsert_computed_workouts", lambda sb, rows: captured.setdefault("computed", rows)
    )
    monkeypatch.setattr(db, "fetch_computed_workouts", lambda sb: stored_computed)
    monkeypatch.setattr(db, "upsert_computed_daily",
                        lambda sb, rows: captured.setdefault("daily", rows))
    # short-circuit everything after the daily chain — the chain is what F1 fixes.
    monkeypatch.setattr(compute, "run_insights", lambda *a, **k: None)
    monkeypatch.setattr(compute, "run_zone2_fitness", lambda *a, **k: None)
    monkeypatch.setattr(compute, "run_goals", lambda sb: None)
    monkeypatch.setattr(compute, "run_geocoding", lambda sb: None)
    monkeypatch.setattr(compute, "datetime", _FrozenNow)

    compute.run(full=False)

    recent = next(r for r in captured["computed"] if r["workout_id"] == recent_id)
    # The full workout lasts 30 minutes, but its active swim sets total only 10.
    # It must not qualify as a >=20-minute steady EF/decoupling observation.
    assert recent["ef"] is None
    assert recent["decoupling_pct"] is None

    by_date = {r["date"]: r for r in captured["daily"]}
    # The pre-window workout's day keeps its stored TRIMP (was 0.0 before the fix).
    assert by_date[old_day.isoformat()]["trimp_total"] == 58.4
    # And the recent (recomputed) day survives too.
    assert by_date[recent_day.isoformat()]["trimp_total"] > 0.0
    # CTL is non-zero across the chain (it was flattened to 0 when TRIMP zeroed).
    assert any(r["ctl"] > 0 for r in captured["daily"])


class _FrozenNow(datetime):
    """Freeze datetime.now(...) inside compute.run so 'today' is deterministic;
    every other datetime behavior passes through unchanged."""

    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW


# --- Replaced-workout duplicates ------------------------------------------
# Apple Health can replace a workout object — delete it and re-create an
# identical one under a fresh UUID — leaving the same session stored twice.
# Each duplicate row adds its TRIMP to the day again, which is the same class
# of silent daily-chain corruption as the pre-window zeroing above.

_RUN_START = "2026-08-25T16:00:00+00:00"


def _workout(id_, external_id, type_="outdoor_run", start_at=_RUN_START):
    return {"id": id_, "external_id": external_id, "type": type_, "start_at": start_at}


def test_dedupe_replaced_workouts_collapses_same_session_under_two_uuids():
    stale = _workout("a", "OLD")
    fresh = _workout("b", "NEW")
    gym = _workout("c", "GYM", "traditional_strength_training",
                   "2026-08-26T15:00:00+00:00")

    kept, dropped = compute.dedupe_replaced_workouts([stale, fresh, gym],
                                                     {"a": 120.0})

    assert [w["id"] for w in kept] == ["a", "c"]
    assert len(dropped) == 1
    winner, loser = dropped[0]
    assert winner["id"] == "a"
    assert loser["id"] == "b"


def test_dedupe_replaced_workouts_prefers_the_row_with_known_trimp():
    """The freshly-inserted replacement usually has no computed_workout row
    yet; keeping it would zero the day rather than double it."""
    kept, _ = compute.dedupe_replaced_workouts(
        [_workout("b", "NEW"), _workout("a", "OLD")], {"a": 120.0}
    )
    assert [w["id"] for w in kept] == ["a"]


def test_dedupe_replaced_workouts_leaves_distinct_sessions_alone():
    first = _workout("a", "A", start_at="2026-08-25T06:00:00+00:00")
    second = _workout("b", "B")

    kept, dropped = compute.dedupe_replaced_workouts([first, second], {})

    assert [w["id"] for w in kept] == ["a", "b"]
    assert dropped == []
