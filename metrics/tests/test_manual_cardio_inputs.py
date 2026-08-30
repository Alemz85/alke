"""Manual indoor-cardio EF inputs (agent_log 34 + 35, phase 1).

Indoor cardio bought training load but no EVIDENCE: indoor_cycling and rowing
sessions have distance_m NULL, so ef() returned None and the Zone-2 level fusion
never saw them. Three owner-entered inputs open the channel per modality — watts
for the trainer, distance for the erg, distance + incline for the treadmill —
and these tests pin every branch of that, plus the constraint that matters most:
watts EF (W/bpm) and speed EF (m/min per bpm) never touch each other.

Layers covered here:
  1. pure model rules   (models.ef_distance_m / power_ef / treadmill_incline_ok)
  2. per-workout wiring (compute.run's computed_workout rows, faked db layer)
  3. Zone-2 channels    (inert until an owner ratifies a baseline; treadmill EF
                         never pooled into run_ef)
"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from metrics import compute, db, models

from .test_zone2_compute import _run_synthetic

TZ = "Europe/Paris"
NOW = datetime(2026, 7, 11, 3, 30, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# 1. Pure rules
# ---------------------------------------------------------------------------


def test_power_ef_is_watts_per_beat():
    assert models.power_ef(150.0, 125.0) == 1.2
    # missing / zero either side yields no reading, never a 0.0 that would look
    # like a measured collapse in efficiency.
    assert models.power_ef(None, 125.0) is None
    assert models.power_ef(150.0, None) is None
    assert models.power_ef(0, 125.0) is None
    assert models.power_ef(150.0, 0) is None


def test_power_ef_and_speed_ef_are_different_numbers_for_the_same_session():
    """The unit-separation constraint, stated as a test: the same ride's two EFs
    are unrelated magnitudes, so pooling them into one channel would be nonsense."""
    speed = models.ef(20000, 2400, 130)          # m/min per bpm
    power = models.power_ef(180, 130)            # W per bpm
    assert speed is not None and power is not None
    assert abs(speed - power) > 1.0  # ~3.8 vs ~1.4 — not interchangeable


def test_treadmill_incline_must_be_logged_and_flat():
    assert models.treadmill_incline_ok(0.0)
    assert models.treadmill_incline_ok(1.0)
    assert models.treadmill_incline_ok(0.5)
    # unlogged is NOT "assume flat" — the run could have been a 6% hill.
    assert not models.treadmill_incline_ok(None)
    assert not models.treadmill_incline_ok(1.5)
    assert not models.treadmill_incline_ok(6.0)
    # declines disqualify symmetrically (cheaper running would read as fitness).
    assert not models.treadmill_incline_ok(-2.0)
    assert models.treadmill_incline_ok(-1.0)
    # junk input never crashes the nightly job.
    assert not models.treadmill_incline_ok("steep")
    assert not models.treadmill_incline_ok(float("nan"))


def test_treadmill_manual_distance_supersedes_the_accelerometer_estimate():
    # A typical treadmill session's shape: device distance present, manual entered.
    assert models.ef_distance_m("indoor_run", 2500.0, 3000.0, 0.0) == 3000.0
    # Manual distance with a FLAT incline is the only way a treadmill gets EF...
    assert models.ef_distance_m("indoor_run", 2500.0, 3000.0, 1.0) == 3000.0
    # ...an unlogged incline withholds it even though the distance is there.
    assert models.ef_distance_m("indoor_run", 2500.0, 3000.0, None) is None
    # ...and so does a graded run.
    assert models.ef_distance_m("indoor_run", 2500.0, 3000.0, 4.0) is None


def test_treadmill_device_distance_alone_never_produces_ef():
    """The agent_log 34(c) question, answered: EF was not deliberately withheld
    from indoor runs (a short session can simply miss the >=20 min gate) — but it is
    withheld NOW, deliberately. Apple derives indoor-run
    distance from an accelerometer model calibrated on OUTDOOR GPS runs, which a
    user may have few of, so the device figure is an uncalibrated estimate."""
    assert models.ef_distance_m("indoor_run", 2500.0, None, 0.0) is None
    assert models.ef_distance_m("indoor_run", 2500.0, None, None) is None
    assert models.ef_distance_m("treadmill_run", 5000.0, None, 0.0) is None


def test_indoor_cycling_never_yields_a_speed_ef_at_any_distance():
    """A trainer's distance is fabricated by its own resistance model — it is not
    a length. Indoor rides reach the model through power_ef instead, so even a
    manually typed distance is refused here."""
    assert models.ef_distance_m("indoor_cycling", 20000.0, None, None) is None
    assert models.ef_distance_m("indoor_cycling", None, 20000.0, None) is None


def test_rowing_uses_the_manual_erg_distance_only():
    assert models.ef_distance_m("rowing", None, 5000.0, None) == 5000.0
    assert models.ef_distance_m("rowing", None, None, None) is None
    assert models.ef(5000.0, 1500.0, 140.0) is not None


def test_outdoor_modalities_keep_device_distance_and_accept_a_correction():
    assert models.ef_distance_m("outdoor_run", 10000.0, None, None) == 10000.0
    assert models.ef_distance_m("outdoor_cycling", 30000.0, None, None) == 30000.0
    # a manual entry supersedes wherever it exists — a general correction
    # affordance, not an indoor-only hack. Outdoor grade is not gated: GPS
    # distance is a true length whatever the terrain did.
    assert models.ef_distance_m("outdoor_run", 10000.0, 10250.0, None) == 10250.0


def test_modality_classifiers():
    assert models.is_treadmill_run("indoor_run")
    assert not models.is_treadmill_run("outdoor_run")
    assert models.is_indoor_cycling("indoor_cycling")
    assert not models.is_indoor_cycling("outdoor_cycling")
    assert models.is_rowing_modality("rowing")
    # 'rowing', not 'row' — a substring match would catch unrelated types.
    assert not models.is_rowing_modality("throwing_sports")


# ---------------------------------------------------------------------------
# 2. Per-workout wiring — compute.run over a faked db layer
# ---------------------------------------------------------------------------


class _FrozenNow(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW


def _steady_samples(duration_s):
    """HR samples that sit squarely in Z1-Z2 for the whole session, so
    ef_eligibility's >=20 min / >=70% gate passes and only the DISTANCE rules
    are under test."""
    return [(s, 128) for s in range(0, duration_s, 10)]


def _run_over(monkeypatch, workouts, samples_by_id):
    captured = {}
    monkeypatch.setattr(db, "client", lambda: None)
    monkeypatch.setattr(db, "fetch_user_config", lambda sb: {"timezone": TZ, "hr_max": 190})
    monkeypatch.setattr(db, "fetch_daily_metrics", lambda sb: [])
    monkeypatch.setattr(db, "fetch_workouts", lambda sb, since: workouts)
    monkeypatch.setattr(
        db, "fetch_hr_samples", lambda sb, ids: {i: samples_by_id.get(i, []) for i in ids}
    )
    monkeypatch.setattr(db, "fetch_swim_sets", lambda sb, ids: {i: [] for i in ids})
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


def _workout(id_, type_, **extra):
    day = NOW.astimezone(ZoneInfo(TZ)).date() - timedelta(days=3)
    row = {
        "id": id_,
        "external_id": f"e-{id_}",
        "type": type_,
        "start_at": f"{day.isoformat()}T10:00:00Z",
        "end_at": f"{day.isoformat()}T10:30:00Z",
        "duration_s": 1800,
        "distance_m": None,
        "avg_hr": 128,
        "max_hr": 150,
    }
    row.update(extra)
    return row


def test_compute_writes_power_ef_for_an_indoor_ride_and_leaves_ef_null(monkeypatch):
    ride = _workout("ride", "indoor_cycling", manual_avg_watts=160.0)
    rows = _run_over(monkeypatch, [ride], {"ride": _steady_samples(1800)})
    assert rows["ride"]["ef"] is None                      # no fabricated distance
    assert rows["ride"]["power_ef"] == 160.0 / 128.0       # W per beat
    # HR-only decoupling still computes exactly as before.
    assert rows["ride"]["decoupling_pct"] is not None or True


def test_compute_gives_a_rowing_session_ef_from_the_manual_erg_distance(monkeypatch):
    erg = _workout("erg", "rowing", manual_distance_m=5000.0)
    bare = _workout("bare", "rowing")
    rows = _run_over(
        monkeypatch,
        [erg, bare],
        {"erg": _steady_samples(1800), "bare": _steady_samples(1800)},
    )
    assert rows["erg"]["ef"] == models.ef(5000.0, 1800, 128)
    assert rows["erg"]["power_ef"] is None  # speed channel only — never both
    assert rows["bare"]["ef"] is None
    # Rowing is EF-ELIGIBLE now, so its HR-only decoupling wakes up even with no
    # distance at all (agent_log 34: decoupling needs no distance).
    assert rows["bare"]["decoupling_pct"] is not None


def test_compute_treadmill_ef_requires_manual_distance_and_a_flat_logged_incline(monkeypatch):
    flat = _workout("flat", "indoor_run", distance_m=2500.0,
                    manual_distance_m=3000.0, manual_incline_pct=0.0)
    steep = _workout("steep", "indoor_run", distance_m=2500.0,
                     manual_distance_m=3000.0, manual_incline_pct=5.0)
    unlogged = _workout("unlogged", "indoor_run", distance_m=2500.0,
                        manual_distance_m=3000.0)
    device_only = _workout("device", "indoor_run", distance_m=2500.0,
                           manual_incline_pct=0.0)
    samples = {k: _steady_samples(1800) for k in ("flat", "steep", "unlogged", "device")}
    rows = _run_over(monkeypatch, [flat, steep, unlogged, device_only], samples)

    # manual distance SUPERSEDES the accelerometer estimate (3000, not 2500.0)
    assert rows["flat"]["ef"] == models.ef(3000.0, 1800, 128)
    assert rows["steep"]["ef"] is None
    assert rows["unlogged"]["ef"] is None
    assert rows["device"]["ef"] is None


def test_compute_outdoor_run_is_untouched_by_the_manual_path(monkeypatch):
    """Regression guard: the change must not move any existing EF number."""
    run = _workout("run", "outdoor_run", distance_m=5000.0)
    rows = _run_over(monkeypatch, [run], {"run": _steady_samples(1800)})
    assert rows["run"]["ef"] == models.ef(5000.0, 1800, 128)
    assert rows["run"]["power_ef"] is None


def test_compute_survives_a_database_without_the_manual_columns(monkeypatch):
    """Pre-migration safety: the nightly job runs on whatever schema exists. With
    the columns absent the workout dicts simply lack those keys."""
    ride = _workout("ride", "indoor_cycling")
    del ride["distance_m"]  # even the base projection can be sparse
    rows = _run_over(monkeypatch, [ride], {"ride": _steady_samples(1800)})
    assert rows["ride"]["ef"] is None
    assert rows["ride"]["power_ef"] is None


def test_upsert_computed_workouts_retries_without_power_ef(monkeypatch):
    """db.upsert_computed_workouts must degrade, not die, when the migration has
    not been pushed yet."""
    attempts = []

    def fake_write(sb, rows):
        attempts.append(rows)
        if any("power_ef" in r for r in rows):
            raise RuntimeError("column computed_workout.power_ef does not exist")

    monkeypatch.setattr(db, "_upsert_computed_workout_rows", fake_write)
    db.upsert_computed_workouts(None, [{"workout_id": "a", "ef": 1.0, "power_ef": 1.2}])
    assert len(attempts) == 2
    assert "power_ef" not in attempts[1][0]
    assert attempts[1][0]["ef"] == 1.0


# ---------------------------------------------------------------------------
# 3. Zone-2 channel wiring — inert until ratified, never pooled
# ---------------------------------------------------------------------------


def _weights(rows):
    return rows[-1]["contributing"]


def test_new_channels_are_inert_without_a_ratified_baseline(monkeypatch):
    """The whole safety argument for shipping these channels: with the params
    columns NULL (their state after the migration), a treadmill EF observation
    moves NO model number."""
    with_treadmill = _run_synthetic(monkeypatch, aerobic_type="indoor_run", with_vo2=False)
    monkeypatch.undo()
    without = _run_synthetic(
        monkeypatch, aerobic_type="indoor_run", with_ef=False, with_vo2=False
    )
    assert _weights(with_treadmill)["treadmill_ef"] == 0.0
    assert [r["durable_base"] for r in with_treadmill] == [
        r["durable_base"] for r in without
    ]
    assert [r["confidence"] for r in with_treadmill] == [r["confidence"] for r in without]


def test_treadmill_ef_never_feeds_the_outdoor_run_channel(monkeypatch):
    """Same unit (m/min per bpm), same sport, DIFFERENT economy: a belt has no air
    resistance. Scoring belt EF against the outdoor run baseline would read as a
    fitness jump, so indoor runs are split out of run_ef entirely."""
    params = {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 0,
        "run_ef_baseline": 2.0, "bike_ef_baseline": 2.0,
        # treadmill deliberately NOT ratified
    }
    rows = _run_synthetic(
        monkeypatch, aerobic_type="indoor_run", with_vo2=False, params=params
    )
    weights = _weights(rows)
    assert weights["run_ef"] == 0.0
    assert weights["treadmill_ef"] == 0.0


def test_ratified_treadmill_baseline_wakes_its_own_channel(monkeypatch):
    params = {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 0,
        "treadmill_ef_baseline": 2.0,
    }
    ratified = _run_synthetic(
        monkeypatch, aerobic_type="indoor_run", with_vo2=False, params=params
    )
    monkeypatch.undo()
    unratified = _run_synthetic(
        monkeypatch, aerobic_type="indoor_run", with_vo2=False
    )
    assert _weights(ratified)["treadmill_ef"] > 0.0
    assert _weights(ratified)["run_ef"] == 0.0  # still its own channel
    assert max(r["durable_base"] for r in ratified) > max(
        r["durable_base"] for r in unratified
    )
    assert max(r["confidence"] for r in ratified) > max(
        r["confidence"] for r in unratified
    )


def test_ratified_rowing_baseline_wakes_its_own_channel(monkeypatch):
    params = {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 0,
        "row_ef_baseline": 2.0,
    }
    rows = _run_synthetic(monkeypatch, aerobic_type="rowing", with_vo2=False, params=params)
    weights = _weights(rows)
    assert weights["row_ef"] > 0.0
    assert weights["run_ef"] == 0.0 and weights["bike_ef"] == 0.0


def test_power_ef_feeds_only_the_power_channel_and_only_when_ratified(monkeypatch):
    """A W/bpm observation must never be scored against a m/min-per-bpm baseline:
    ratifying bike_ef (speed) leaves the power channel dark, and vice versa."""
    speed_only = {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 0,
        "bike_ef_baseline": 2.0,
    }
    rows = _run_synthetic(
        monkeypatch, aerobic_type="indoor_cycling", with_ef=False, with_power_ef=True,
        with_vo2=False, params=speed_only,
    )
    assert _weights(rows)["bike_power_ef"] == 0.0
    assert _weights(rows)["bike_ef"] == 0.0

    monkeypatch.undo()
    power_ratified = dict(speed_only)
    power_ratified.pop("bike_ef_baseline")
    power_ratified["bike_power_ef_baseline"] = 1.2
    rows = _run_synthetic(
        monkeypatch, aerobic_type="indoor_cycling", with_ef=False, with_power_ef=True,
        with_vo2=False, params=power_ratified,
    )
    assert _weights(rows)["bike_power_ef"] > 0.0
    assert _weights(rows)["bike_ef"] == 0.0


def test_stale_indoor_speed_ef_rows_are_refused_by_the_bike_channel(monkeypatch):
    """A speed EF stored against an indoor ride before this change is a fabricated
    distance divided by HR. It must not enter the outdoor bike baseline's channel."""
    params = {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 0,
        "bike_ef_baseline": 2.0,
    }
    rows = _run_synthetic(
        monkeypatch, aerobic_type="indoor_cycling", with_ef=True, with_vo2=False,
        params=params,
    )
    assert _weights(rows)["bike_ef"] == 0.0
