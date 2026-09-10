"""Owner-declared manual session end (migration 20260910140000).

A workout the owner forgot to stop keeps recording a fabricated tail past the
real end of the session — see the migration file for the motivating pool
swim (more time and distance recorded than the last length HR corroborates,
a few minutes earlier). `manual_end_at` is an owner-only, compute-time overlay:
the ingested columns and samples are never touched in the DB (Health Auto
Export re-delivers a workout for ~2 days and would clobber any in-place edit),
so the truncation logic in models.py must be pure, inert-by-default, and
idempotent, and compute.py must apply it consistently everywhere duration_s /
samples / swim_sets are read for a workout.

Layers covered here:
  1. pure rules    (models.manual_end_cutoff_s / truncate_workout_at_manual_end
                     / samples_within_manual_end / swim_sets_within_manual_end)
  2. wiring        (compute.apply_manual_ends, and hrr60 receiving the FULL
                     sample stream while every other metric gets the truncated
                     one)
"""

from datetime import datetime, timedelta, timezone

from metrics import compute, db, models

BASE_START = datetime(2026, 9, 1, 8, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _workout(duration_s, cutoff_s=None, id_="w1", **extra) -> dict:
    """A workout dict shaped like a `db.fetch_workouts` row. `cutoff_s`, when
    given, sets `manual_end_at` to exactly that many seconds after `start_at`
    (the raw, device-recorded `duration_s` is passed separately so tests can
    place the cutoff anywhere relative to it)."""
    row = {
        "id": id_,
        "external_id": f"e-{id_}",
        "type": "outdoor_run",
        "start_at": _iso(BASE_START),
        "end_at": _iso(BASE_START + timedelta(seconds=duration_s)),
        "duration_s": duration_s,
        "distance_m": 1000.0,
        "energy_kcal": 300.0,
        "avg_hr": 140,
        "max_hr": 150,
    }
    if cutoff_s is not None:
        row["manual_end_at"] = _iso(BASE_START + timedelta(seconds=cutoff_s))
    row.update(extra)
    return row


# ---------------------------------------------------------------------------
# 1. Pure rules
# ---------------------------------------------------------------------------


def test_manual_end_at_or_after_recorded_end_is_inert():
    """A value at or after the recorded end must never EXTEND a workout. The
    only-truncates gate lives in truncate_workout_at_manual_end, so what is
    asserted here is observable inertness across all three consumers, not a
    None from the cutoff helper (which reports the stored instant verbatim so
    it stays valid on an already-truncated row — see its docstring)."""
    at_end = _workout(1800, cutoff_s=1800)
    past_end = _workout(1800, cutoff_s=1850)

    # Truncation is a strict no-op — the SAME object back, never a copy.
    assert models.truncate_workout_at_manual_end(at_end, []) is at_end
    assert models.truncate_workout_at_manual_end(past_end, []) is past_end

    # The filters are no-ops too, because every recorded sample offset and set
    # start already lies within the recorded duration.
    samples = [(0, 120.0), (900, 150.0), (1799, 148.0)]
    sets = [{"start_offset_s": 0, "duration_s": 60, "distance_m": 50.0}]
    for workout in (at_end, past_end):
        assert models.samples_within_manual_end(workout, samples) == samples
        assert models.swim_sets_within_manual_end(workout, sets) == sets


def test_cutoff_survives_on_an_already_truncated_row():
    """Regression: the cutoff must be re-derivable from a workout that has
    ALREADY been truncated, because compute.py filters that workout's samples
    and swim sets from the same (post-overlay) dict. A cutoff helper that
    gated on `duration_s` reported "no correction" here and silently restored
    the full, untruncated sample stream."""
    raw = _workout(2100, cutoff_s=1750)
    truncated = models.truncate_workout_at_manual_end(raw, [])
    assert truncated["duration_s"] == 1750
    assert models.manual_end_cutoff_s(truncated) == 1750

    samples = [(0, 120.0), (1749, 140.0), (1751, 110.0), (2000, 108.0)]
    assert models.samples_within_manual_end(truncated, samples) == [(0, 120.0), (1749, 140.0)]


def test_cutoff_inert_when_manual_end_at_missing_or_garbage():
    absent = _workout(1800)
    absent.pop("manual_end_at", None)
    assert models.manual_end_cutoff_s(absent) is None

    explicit_none = _workout(1800)
    explicit_none["manual_end_at"] = None
    assert models.manual_end_cutoff_s(explicit_none) is None

    garbage = _workout(1800)
    garbage["manual_end_at"] = "not-a-timestamp"
    assert models.manual_end_cutoff_s(garbage) is None


def test_cutoff_inert_when_start_at_unparseable():
    w = _workout(1800, cutoff_s=900)
    w["start_at"] = "also-not-a-timestamp"
    assert models.manual_end_cutoff_s(w) is None


def test_cutoff_handles_trailing_z_and_offset_forms_the_same_way():
    """The DB returns e.g. 2026-09-01T11:30:00+00:00; parsing must also accept
    a trailing 'Z' (both forms name the same instant)."""
    offset_form = _workout(1800, cutoff_s=900)
    assert models.manual_end_cutoff_s(offset_form) == 900.0

    z_form = dict(offset_form)
    z_form["manual_end_at"] = z_form["manual_end_at"].replace("+00:00", "Z")
    assert models.manual_end_cutoff_s(z_form) == 900.0


def test_cutoff_inert_when_non_positive():
    """A cutoff of exactly start_at (0s) or before it (negative) is inert —
    the DB CHECK constraint should prevent this, but the model must not trust
    that and must never crash on it."""
    w = _workout(1800)
    w["manual_end_at"] = w["start_at"]
    assert models.manual_end_cutoff_s(w) is None


def test_truncate_sets_duration_and_end_at_and_leaves_energy_kcal_alone():
    w = _workout(2000, cutoff_s=1800, distance_m=5000.0, energy_kcal=333.0, type="outdoor_run")
    truncated = models.truncate_workout_at_manual_end(w, [])

    assert truncated["duration_s"] == 1800
    assert isinstance(truncated["duration_s"], int)
    assert truncated["end_at"] == w["manual_end_at"]
    # non-swim (no sets passed in) -> distance_m goes unavailable, not stale
    assert truncated["distance_m"] is None
    # energy_kcal is UNCHANGED, deliberately: compute.py's ambient Zone-2
    # channel subtracts each logged workout's energy_kcal from the day's
    # active_energy_kcal, and the day's total still contains the tail's
    # calories regardless of this overlay.
    assert truncated["energy_kcal"] == 333.0
    # the original dict must not be mutated in place
    assert w["duration_s"] == 2000


def test_truncate_is_idempotent():
    w = _workout(2000, cutoff_s=1800, distance_m=5000.0, energy_kcal=333.0)
    once = models.truncate_workout_at_manual_end(w, [])
    twice = models.truncate_workout_at_manual_end(once, [])
    assert twice == once


def test_samples_within_manual_end_keeps_boundary_sample_drops_later_ones():
    w = _workout(2000, cutoff_s=1800)
    samples = [(1790, 140.0), (1800, 140.0), (1801, 90.0), (1900, 80.0)]
    kept = models.samples_within_manual_end(w, samples)
    assert kept == [(1790, 140.0), (1800, 140.0)]


def test_samples_within_manual_end_unchanged_without_a_correction():
    w = _workout(2000)  # no manual_end_at
    samples = [(1, 100.0), (2, 105.0)]
    assert models.samples_within_manual_end(w, samples) is samples


def test_swim_sets_within_manual_end_keeps_a_straddling_set_whole():
    """A set that STARTED before the cutoff is kept WHOLE even though it runs
    past it — it was a real length in progress, not part of the fabricated
    tail."""
    w = _workout(2000, cutoff_s=1800, type="swim")
    straddling = {"start_offset_s": 1750, "duration_s": 100, "distance_m": 25.0}
    starts_at_cutoff = {"start_offset_s": 1800, "duration_s": 20, "distance_m": 25.0}
    starts_after = {"start_offset_s": 1900, "duration_s": 20, "distance_m": 25.0}
    kept = models.swim_sets_within_manual_end(w, [straddling, starts_at_cutoff, starts_after])
    assert kept == [straddling]


def test_swim_sets_within_manual_end_unchanged_without_a_correction():
    w = _workout(2000, type="swim")  # no manual_end_at
    sets = [{"start_offset_s": 0, "duration_s": 10, "distance_m": 25.0}]
    assert models.swim_sets_within_manual_end(w, sets) is sets


def test_truncate_distance_m_is_the_kept_set_sum_or_none_without_sets():
    w = _workout(2000, cutoff_s=1800, type="swim", distance_m=1000.0)
    sets = [
        {"start_offset_s": 1000, "duration_s": 200, "distance_m": 400.0},
        {"start_offset_s": 1850, "duration_s": 50, "distance_m": 25.0},  # dropped: >= cutoff
    ]
    truncated = models.truncate_workout_at_manual_end(w, sets)
    assert truncated["distance_m"] == 400.0

    truncated_no_sets = models.truncate_workout_at_manual_end(w, [])
    assert truncated_no_sets["distance_m"] is None


def test_realistic_swim_regression_drops_two_fabricated_tail_lengths():
    """Shaped like the migration's motivating example: a 2100 s pool swim with a real
    length ending at 1750 s (start_offset_s 1660, duration 90) followed by two
    watch-fabricated "lengths" (12 s and 40 s) recorded while getting out of
    the pool. A manual end at 1750 s must drop exactly those two and truncate
    duration_s to 1750."""
    w = _workout(2100, cutoff_s=1750, type="swim", distance_m=1000.0)
    sets = [
        {"start_offset_s": 1660, "duration_s": 90, "distance_m": 25.0},
        {"start_offset_s": 1900, "duration_s": 12, "distance_m": 25.0},
        {"start_offset_s": 1960, "duration_s": 40, "distance_m": 25.0},
    ]

    kept = models.swim_sets_within_manual_end(w, sets)
    assert kept == [sets[0]]

    truncated = models.truncate_workout_at_manual_end(w, sets)
    assert truncated["duration_s"] == 1750
    assert truncated["distance_m"] == 25.0


# ---------------------------------------------------------------------------
# 2. Wiring — compute.apply_manual_ends and the per-workout loop
# ---------------------------------------------------------------------------


def test_apply_manual_ends_skips_the_db_round_trip_when_nothing_needs_it(monkeypatch):
    def boom(sb, ids):
        raise AssertionError("fetch_swim_sets must not be called when no workout is corrected")

    monkeypatch.setattr(db, "fetch_swim_sets", boom)
    workouts = [_workout(1800, id_="a"), _workout(1800, id_="b")]
    result = compute.apply_manual_ends(None, workouts)
    assert result is workouts  # literally unchanged, no copy


def test_apply_manual_ends_fetches_swim_sets_only_for_corrected_workouts(monkeypatch):
    calls = []

    def fake_fetch(sb, ids):
        calls.append(list(ids))
        return {i: [] for i in ids}

    monkeypatch.setattr(db, "fetch_swim_sets", fake_fetch)
    corrected = _workout(2000, cutoff_s=1800, id_="corrected")
    plain = _workout(1800, id_="plain")
    result = compute.apply_manual_ends(None, [corrected, plain])

    assert calls == [["corrected"]]
    by_id = {w["id"]: w for w in result}
    assert by_id["corrected"]["duration_s"] == 1800
    assert by_id["plain"] is plain  # untouched, not even copied


class _FrozenNow(datetime):
    @classmethod
    def now(cls, tz=None):
        frozen = BASE_START + timedelta(days=3)
        return frozen.astimezone(tz) if tz else frozen


def _run_compute_over(monkeypatch, workouts, samples_by_id, swim_sets_by_id=None):
    captured = {}
    swim_sets_by_id = swim_sets_by_id or {}
    monkeypatch.setattr(db, "client", lambda: None)
    monkeypatch.setattr(db, "fetch_user_config", lambda sb: {"timezone": "UTC", "hr_max": 190})
    monkeypatch.setattr(db, "fetch_daily_metrics", lambda sb: [])
    monkeypatch.setattr(db, "fetch_workouts", lambda sb, since: workouts)
    monkeypatch.setattr(
        db, "fetch_hr_samples", lambda sb, ids: {i: samples_by_id.get(i, []) for i in ids}
    )
    monkeypatch.setattr(
        db, "fetch_swim_sets", lambda sb, ids: {i: swim_sets_by_id.get(i, []) for i in ids}
    )
    monkeypatch.setattr(db, "update_hr_max", lambda sb, v: None)
    monkeypatch.setattr(
        db, "upsert_computed_workouts", lambda sb, rows: captured.setdefault("computed", rows)
    )
    monkeypatch.setattr(db, "fetch_computed_workouts", lambda sb: [])
    monkeypatch.setattr(db, "upsert_computed_daily", lambda sb, rows: None)
    monkeypatch.setattr(compute, "run_insights", lambda *a, **k: None)
    monkeypatch.setattr(compute, "run_zone2_fitness", lambda *a, **k: None)
    monkeypatch.setattr(compute, "run_goals", lambda sb: None)
    monkeypatch.setattr(compute, "run_geocoding", lambda sb: None)
    monkeypatch.setattr(compute, "datetime", _FrozenNow)

    compute.run(full=True)
    return {r["workout_id"]: r for r in captured["computed"]}


def test_hrr60_reads_the_full_sample_stream_while_zone_time_reads_the_truncated_one(
    monkeypatch,
):
    """The one wiring detail most likely to be gotten wrong: hrr60 must see the
    device's UNTRUNCATED samples (its post-cutoff tail can hold a genuine
    60s-post-end recovery reading) while time_in_zones/decoupling must not."""

    def bpm_at(offset):
        if offset <= 1800:
            return 140.0  # steady Z2 effort, satisfies the eligibility gate
        return 100.0  # device kept recording after the owner actually stopped

    full_samples = [(off, bpm_at(off)) for off in range(0, 2000, 10)]
    # a single, unambiguous recovery reading inside hrr60's post-end window
    # [duration_s+45, duration_s+90] once duration_s is truncated to 1800
    full_samples.append((1860, 100.0))

    workout = _workout(2000, cutoff_s=1800, type="outdoor_run", distance_m=None)

    rows = _run_compute_over(monkeypatch, [workout], {"w1": full_samples})
    row = rows["w1"]
    # hrr60 = max HR in final 2 min of the TRUNCATED duration (140) minus the
    # recovery reading ~60s after the TRUNCATED end (100) = 40. This value is
    # only reachable because hrr60 got the untruncated sample stream — the
    # recovery sample sits at offset 1860, past the truncated duration_s.
    assert row["hrr60"] == 40.0
    # zone time reflects ONLY pre-cutoff samples: 1800s of steady Z2, none of
    # the post-cutoff tail leaks in as easy/aerobic time.
    tiz = row["time_in_zones"]
    assert tiz["z2"] == 1800
    assert tiz["z1"] == 0 and tiz["z3"] == 0 and tiz["z4"] == 0 and tiz["z5"] == 0


def test_swim_workout_wiring_drops_tail_sets_and_samples_from_ef_and_drift(monkeypatch):
    """End-to-end: a swim with a manual end must have its EF/drift computed
    from truncated active windows only, matching the pure-function contract.

    One long real set (0..1750s, >=20 min so the eligibility gate passes)
    followed by the migration's two fabricated tail lengths, dropped by the
    1750s cutoff."""
    workout = _workout(
        2100, cutoff_s=1750, type="pool_swim", distance_m=1000.0, energy_kcal=500.0
    )
    sets = [
        {"start_offset_s": 0, "duration_s": 1750, "distance_m": 1000.0},
        {"start_offset_s": 1900, "duration_s": 12, "distance_m": 25.0},
        {"start_offset_s": 1960, "duration_s": 40, "distance_m": 25.0},
    ]
    # Steady in-set HR samples so swim_active_ef/drift have enough active
    # points; well within Z1-Z2 so the eligibility gate passes easily.
    samples = [(off, 130.0) for off in range(0, 1750, 5)]

    rows = _run_compute_over(
        monkeypatch, [workout], {"w1": samples}, {"w1": sets}
    )
    row = rows["w1"]
    # EF is computed from the KEPT set only (1000m / 1750s), not the raw
    # workout's own duration_s/distance_m — it must not blow up or silently
    # vanish because of the overlay.
    assert row["ef"] == models.ef(1000.0, 1750, 130.0)
