"""End-to-end wiring test for run_zone2_fitness against a fake db layer.

Pins the compute-level v4 fixes the pure-math tests cannot reach:
  - strength/core workouts never feed w(t)/sessions/B (fix 1)
  - per-day CAUSAL B/τ_slow/floor + B decaying through a training gap (fix 3)
  - per-day causal days_since_vo2max, never negative, None before first (fix 3)
  - anchor_beta key no longer written; new horizon columns on every row (7/10)
  - continuous confidence in [0,1] falling as signals stale; band widening (7/8)
  - warn_after_days stored as the CONTINUOUS horizon (fix 10)
  - b_ref ≤ 0 params guard (fix 12)
"""

import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from metrics import compute, db

TZ = ZoneInfo("Europe/Paris")
NOW = datetime(2026, 7, 11, 3, 30, tzinfo=timezone.utc)


def _run_synthetic(monkeypatch, with_ef=True, with_rhr=True, with_vo2=True,
                   steps_per_day=8000, aerobic_type="indoor_cycling", params=None):
    """400-day synthetic history. Toggles let the level-fusion tests isolate one
    signal at a time: with_ef=False drops ride EF (no distance in practice),
    with_rhr=False drops resting-HR data, with_vo2=False drops watch VO2max.
    aerobic_type swaps the every-3rd-day aerobic session's modality (e.g.
    'running' to exercise the run-EF signal); params overrides the fake params row."""
    today = NOW.astimezone(TZ).date()
    n_days = 400
    days = [today - timedelta(days=n_days - 1 - i) for i in range(n_days)]

    # An aerobic Z2 session every 3rd day for the first 300 days, then a 100-day
    # full gap. Strength sessions every 2nd day THROUGHOUT — if they leaked into
    # w(t), the gap would never read as a gap.
    prefix = "run" if "run" in aerobic_type else "bike"
    workouts, zones, computed = [], {}, []
    for i, d in enumerate(days):
        if i % 3 == 0 and i < 300:
            w = {"id": f"{prefix}{i}", "type": aerobic_type,
                 "start_at": f"{d.isoformat()}T10:00:00Z", "duration_s": 2400,
                 "distance_m": 20000 if with_ef else None, "avg_hr": 130, "max_hr": 150}
            workouts.append(w)
            zones[w["id"]] = {"z1": 300, "z2": 1800, "z3": 300, "z4": 0, "z5": 0}
            computed.append({"workout_id": w["id"],
                             "ef": (2.0 + 1.2 * i / 300) if with_ef else None,
                             "decoupling_pct": 4.0, "hrr60": None})
        if i % 2 == 0:
            w = {"id": f"str{i}", "type": "functional_strength_training",
                 "start_at": f"{d.isoformat()}T18:00:00Z", "duration_s": 3600,
                 "distance_m": None, "avg_hr": 120, "max_hr": 160}
            workouts.append(w)
            zones[w["id"]] = {"z1": 600, "z2": 2400, "z3": 600, "z4": 0, "z5": 0}
            computed.append({"workout_id": w["id"], "ef": None,
                             "decoupling_pct": None, "hrr60": None})

    daily_metrics = [
        {"date": d.isoformat(),
         "resting_hr": (58 if i % 2 == 0 else None) if with_rhr else None,
         "hrv_sdnn_ms": 45.0,
         "steps": steps_per_day,
         "vo2max": 42.0 if (with_vo2 and i in (50, 200, 350)) else None}
        for i, d in enumerate(days)
    ]
    daily_rows = [{"date": d.isoformat(), "rhr_dev": 0.5, "hrv_dev": -1.0} for d in days]

    captured = {}
    default_params = {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 0,  # 0 → guard must kick in
        # RATIFIED EF baselines = 2.0, the synthetic's genuine detrained-era
        # first EF (the ramp starts there). EF signals fuse only when their
        # baseline is ratified in params — never derived from the observation
        # history (see test_unratified_ef_baseline_never_enters_the_fusion).
        "run_ef_baseline": 2.0, "bike_ef_baseline": 2.0,
    }
    monkeypatch.setattr(db, "fetch_zone2_fitness_params",
                        lambda sb: params if params is not None else default_params)
    monkeypatch.setattr(db, "fetch_computed_workout_zones", lambda sb: zones)
    monkeypatch.setattr(db, "fetch_computed_workouts", lambda sb: computed)
    monkeypatch.setattr(db, "fetch_active_injury_holds",
                        lambda sb: {"active_injuries": 0, "active_constraints": 0})
    monkeypatch.setattr(db, "upsert_computed_zone2_fitness",
                        lambda sb, rows: captured.setdefault("rows", rows))
    monkeypatch.setattr(db, "update_zone2_fitted_from",
                        lambda sb, ff: captured.__setitem__("fitted_from", ff))

    compute.run_zone2_fitness(None, workouts, daily_metrics, daily_rows, days, TZ, NOW)
    # expose the fitted_from write (F4 ratchet) on the returned list for callers
    # that want it, without changing the primary rows return.
    rows = captured["rows"]
    rows_fitted_from = captured.get("fitted_from")
    return _Rows(rows, rows_fitted_from)


class _Rows(list):
    """A list of computed rows that also carries the fitted_from jsonb the run
    persisted (F4 ratchet), so existing row-based callers are unaffected."""

    def __init__(self, rows, fitted_from):
        super().__init__(rows)
        self.fitted_from = fitted_from


def test_run_zone2_fitness_wiring(monkeypatch, capsys):
    rows = _run_synthetic(monkeypatch)
    assert len(rows) == 400

    # anchor_beta gone; horizon columns present on every row. build/ΔI are
    # always defined; warn/maintain are NULL exactly when the projection hit
    # the search cap ("no meaningful drop in the window" is a state, not a
    # calendar date — the renderer omits that marker).
    assert all("anchor_beta" not in r for r in rows)
    for key in ("maintain_horizon_days", "build_interval_days",
                "expected_session_build", "warn_after_days"):
        assert all(key in r for r in rows), key
    assert all(r["build_interval_days"] is not None for r in rows)
    assert all(r["expected_session_build"] is not None for r in rows)
    # warn/maintain: continuous floats when a real horizon exists, else NULL.
    for key in ("warn_after_days", "maintain_horizon_days"):
        assert all(r[key] is None or isinstance(r[key], float) for r in rows), key
    # mid-block (trained state): real, continuous horizons.
    assert isinstance(rows[250]["warn_after_days"], float)
    assert rows[250]["maintain_horizon_days"] is not None

    # per-day causal days_since_vo2max: None before the first reading (day 50),
    # 0 on reading days, never negative anywhere.
    assert rows[49]["days_since_vo2max"] is None
    assert rows[50]["days_since_vo2max"] == 0
    assert rows[51]["days_since_vo2max"] == 1
    assert rows[200]["days_since_vo2max"] == 0
    assert all(r["days_since_vo2max"] is None or r["days_since_vo2max"] >= 0 for r in rows)

    # per-day causal B: builds during the block, decays through the gap.
    bs = [r["base_accum_b"] for r in rows]
    assert bs[10] < bs[250]
    assert bs[299] > bs[330] > bs[360] > bs[-1]

    # D and F decay through the gap (strength sessions kept running — they must
    # not hold the model up).
    assert rows[-1]["durable_base"] < rows[299]["durable_base"]
    assert rows[-1]["sharpness"] < 1.0
    assert rows[250]["maintenance_met"] is True
    assert rows[-1]["maintenance_met"] is False

    # continuous confidence in [0,1]; falls as the bike-EF signal stales through
    # the gap, and the index band widens accordingly.
    assert all(0.0 <= r["confidence"] <= 1.0 for r in rows)
    assert rows[290]["confidence"] > rows[-1]["confidence"]
    width_290 = rows[290]["durable_band_hi"] - rows[290]["durable_band_lo"]
    width_last = rows[-1]["durable_band_hi"] - rows[-1]["durable_band_lo"]
    assert width_last >= width_290

    # v4 build cadence is the B-scaled interval (7/(3+2.5·B), floored 24h): for a
    # near-detrained end (low B) it sits near the ~2.3d novice dose, and it tracks
    # the row's own B exactly.
    from metrics import models as _m
    assert rows[-1]["build_interval_days"] == pytest.approx(
        _m.build_cadence_days(rows[-1]["base_accum_b"]), abs=0.01
    )
    assert _m.Z2_BUILD_INTERVAL_FLOOR_DAYS <= rows[-1]["build_interval_days"] <= 7.0 / 3.0
    assert rows[-1]["expected_session_build"] > 0

    # v4 eases (durable erosion vs the confidence band) is PHASE-GATED: mid-block
    # (banked base) it fires a real horizon; at the thin/detrained end the base
    # cannot lose a whole band → NULL ("building phase", no erosion marker).
    assert isinstance(rows[250]["warn_after_days"], float)  # maintenance phase
    assert rows[-1]["warn_after_days"] is None               # building phase
    assert rows[-1]["flags"] == []                           # no maintenance flag when building


def test_neat_activity_floor_raises_the_durable_floor(monkeypatch):
    # v4.2: sustained daily steps raise the durable FLOOR (maintenance, not build).
    from metrics import models as _m

    active = _run_synthetic(monkeypatch, steps_per_day=9000)
    # NEAT bonus present in provenance once the steps EWMA has seeded.
    assert active[-1]["contributing"]["neat"] > 0
    # The stored floor exceeds the training-age-only floor → steps genuinely raised it.
    b_last = active[-1]["base_accum_b"]
    age_only_floor_d = _m.durable_score_from_percentile(_m.durable_floor_score(b_last))
    assert active[-1]["floor_score"] > age_only_floor_d + 1.0


def test_neat_floor_is_zero_when_sedentary(monkeypatch):
    # Below the sedentary step threshold → no floor bonus (steps don't fabricate base).
    sedentary = _run_synthetic(monkeypatch, steps_per_day=1500)
    assert all(r["contributing"]["neat"] == 0.0 for r in sedentary)


def test_neat_only_enters_the_floor_never_the_build(monkeypatch):
    # Steps must NOT feed w(t): sharpness/durable during the training block are
    # identical whether steps are high or low — only the FLOOR differs.
    active = _run_synthetic(monkeypatch, steps_per_day=12000)
    sedentary = _run_synthetic(monkeypatch, steps_per_day=1000)
    # Mid-block sharpness (fast layer, pure load) is unaffected by steps.
    assert active[250]["sharpness"] == pytest.approx(sedentary[250]["sharpness"], abs=1e-9)
    # But the detrained-end floor is higher for the active lifestyle.
    assert active[-1]["floor_score"] > sedentary[-1]["floor_score"]


def test_uncapped_horizon_nulls_the_search_cap():
    # A horizon at the bisection search cap is "no meaningful drop within the
    # window" — a state, not a calendar date. Stored NULL (renderer omits the
    # marker); real horizons pass through rounded, still continuous.
    from metrics.models import Z2_DECAY_ONSET_MAX_DAYS

    assert compute._uncapped(Z2_DECAY_ONSET_MAX_DAYS) is None
    assert compute._uncapped(Z2_DECAY_ONSET_MAX_DAYS + 5.0) is None
    assert compute._uncapped(3.217) == 3.22
    assert compute._uncapped(0.0) == 0.0  # "already easing" stays a valid 0
    assert compute._uncapped(Z2_DECAY_ONSET_MAX_DAYS - 0.01) is not None


# ===========================================================================
# v4 level-fusion redesign: RHR demoted to corroborator, B-prior default
# level-setter, honest absolute variances.
# ===========================================================================

def test_rhr_never_moves_the_level(monkeypatch):
    # (a) RHR is a corroborator, not a level-setter (v3 pt3: strength-confounded).
    # Removing ALL resting-HR data must change NOTHING about the level, the
    # confidence, or the band — it is excluded from the fusion by design.
    with_rhr = _run_synthetic(monkeypatch, with_rhr=True)
    monkeypatch.undo()
    without_rhr = _run_synthetic(monkeypatch, with_rhr=False)
    for a, b in zip(with_rhr, without_rhr):
        assert a["durable_base"] == b["durable_base"]
        assert a["confidence"] == b["confidence"]
        assert a["durable_band_lo"] == b["durable_band_lo"]
        assert a["durable_band_hi"] == b["durable_band_hi"]
        assert a["contributing"]["rhr"] == 0.0  # reported, weight 0.0 always


def test_no_ef_no_vo2_level_is_the_b_prior(monkeypatch):
    # (b) With no trusted aerobic signal the fusion IS the B-prior: the level
    # calibrates to C_D·B — the sparse Zone-2 trainer reads LOW (v3 pt1), from
    # their own load history, not from confounded RHR (which is present here!).
    # Sedentary steps here so the NEAT floor (tested separately) doesn't hold the
    # detrained-end base up and confound this level/decay check.
    rows = _run_synthetic(monkeypatch, with_ef=False, with_vo2=False, steps_per_day=1500)
    c_d = 70.0
    b_today = rows[-1]["base_accum_b"]
    calib = c_d * b_today
    assert calib < 20.0  # B≈0.19 in this synthetic → a LOW level, ~13 pts
    # The calibration point maps the floorless-track max to EXACTLY C_D·B; the
    # pass-2 (floored) track can peak somewhat above the floorless calib_load
    # (Newton floor support accumulates through the block — by design), so D's
    # window max brackets C_D·B rather than equaling it. It must stay in the
    # B-prior's magnitude — NOT the ~40+ the confounded RHR fusion produced.
    d_window = [r["durable_base"] for r in rows[-180:]]
    assert calib * 0.9 <= max(d_window) <= calib * 1.5
    # and deep in the gap D has decayed back near the earned floor — low single
    # digits.
    assert rows[-1]["durable_base"] < 8.0
    # b_prior is the only contributing level weight; EF/VO2 absent.
    assert rows[-1]["contributing"]["b_prior"] > 0.0
    assert rows[-1]["contributing"]["bike_ef"] == 0.0
    assert rows[-1]["contributing"]["vo2max"] == 0.0


def test_fresh_bike_ef_dominates_the_b_prior(monkeypatch):
    # (c) When eligible bike EF exists (var 22 ≪ 306) it genuinely sets the
    # level above what the thin load history alone would license.
    with_ef = _run_synthetic(monkeypatch, with_vo2=False)
    monkeypatch.undo()
    without_ef = _run_synthetic(monkeypatch, with_ef=False, with_vo2=False)
    peak_with = max(r["durable_base"] for r in with_ef)
    peak_without = max(r["durable_base"] for r in without_ef)
    assert peak_with > 2.0 * peak_without  # EF-led ≫ B-prior-led
    # and confidence is far higher while the EF is fresh (during the block).
    assert with_ef[290]["confidence"] > without_ef[290]["confidence"] + 0.3


def test_b_prior_only_confidence_low_band_wide(monkeypatch):
    # (d) With only the B-prior setting the level: posterior_sd = C_D/4, so
    # confidence = 1 − (C_D/4)/(C_D/√12) = 1 − √12/4 ≈ 0.134 and the 95% band
    # half-width is 1.96·C_D/4 ≈ 34 pts — WIDE. "Trustworthy on trend, banded
    # on absolute placement": no aerobic-specific anchor exists yet.
    rows = _run_synthetic(monkeypatch, with_ef=False, with_vo2=False)
    expected_conf = 1.0 - math.sqrt(12.0) / 4.0
    assert rows[-1]["confidence"] == pytest.approx(expected_conf, abs=0.01)
    assert all(r["confidence"] <= expected_conf + 0.01 for r in rows)
    width = rows[-1]["durable_band_hi"] - rows[-1]["durable_band_lo"]
    assert width > 30.0


# ===========================================================================
# F2: running EF is the aerobic-specific calibration signal that actually fires.
# ===========================================================================

def test_run_ef_sets_the_level_like_bike_ef(monkeypatch):
    # Runs carry distance + HR, so run EF is EF-eligible and feeds the fusion.
    # Mirroring bike EF: with run EF present the level rises far above the thin
    # B-prior-only level, and run_ef carries a contributing weight.
    with_run = _run_synthetic(monkeypatch, aerobic_type="running", with_vo2=False)
    monkeypatch.undo()
    without = _run_synthetic(monkeypatch, aerobic_type="running", with_ef=False, with_vo2=False)
    peak_with = max(r["durable_base"] for r in with_run)
    peak_without = max(r["durable_base"] for r in without)
    assert peak_with > 2.0 * peak_without  # run-EF-led ≫ B-prior-led
    # run_ef contributes a real inverse-variance weight during the training block;
    # bike_ef stays 0 (no bike EF here). Confidence is higher while EF is fresh.
    assert with_run[290]["contributing"]["run_ef"] > 0.0
    assert with_run[290]["contributing"]["bike_ef"] == 0.0
    assert with_run[290]["confidence"] > without[290]["confidence"] + 0.3


def test_run_ef_weight_matches_the_run_ef_variance(monkeypatch):
    # The contributing weight equals 1/variance with the run-EF variance (fresh,
    # staleness age 0 on a session day) — i.e. run EF is wired with its OWN var.
    from metrics import models as _m

    rows = _run_synthetic(monkeypatch, aerobic_type="running", with_vo2=False)
    # day 288 is a session day (i%3==0) inside the block → EF age 0.
    w = rows[288]["contributing"]["run_ef"]
    assert w == pytest.approx(1.0 / _m.Z2_RUN_EF_VARIANCE, abs=0.02)


def test_unratified_ef_baseline_never_enters_the_fusion(monkeypatch):
    """Regression for the self-baselining incident: the first-ever bike EF observation
    became its own baseline (elevation ≡ 0 — a tautology, not a measurement) and
    fused at the model's strongest weight, crashing the durable calibration below
    the floor while the confidence band falsely collapsed 2.5×. EF baselines now
    come ONLY from an owner-ratified params value; without one the signal is
    collected but withheld from the level fusion — level, confidence and band
    must be IDENTICAL to having no EF data at all (the swim-EF treatment)."""
    unratified = {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 200,  # no *_ef_baseline keys
    }
    with_obs = _run_synthetic(monkeypatch, with_ef=True, with_vo2=False,
                              params=unratified)
    monkeypatch.undo()
    without_obs = _run_synthetic(monkeypatch, with_ef=False, with_vo2=False,
                                 params=unratified)

    assert all(r["contributing"]["bike_ef"] == 0.0 for r in with_obs)
    assert all(r["contributing"]["run_ef"] == 0.0 for r in with_obs)
    for a, b in zip(with_obs, without_obs):
        assert a["durable_base"] == b["durable_base"]
        assert a["confidence"] == b["confidence"]
        assert a["durable_band_lo"] == b["durable_band_lo"]
        assert a["durable_band_hi"] == b["durable_band_hi"]


def test_swim_ef_never_enters_durable_fusion(monkeypatch):
    """Whole-workout swim EF mixes rest structure and returning technique with
    cardio fitness, so even a long RHR-corroborated history must not set D."""
    with_swim_ef = _run_synthetic(
        monkeypatch, aerobic_type="swimming", with_ef=True, with_vo2=False, with_rhr=True
    )
    monkeypatch.undo()
    without_swim_ef = _run_synthetic(
        monkeypatch, aerobic_type="swimming", with_ef=False, with_vo2=False, with_rhr=True
    )

    assert all(row["contributing"]["swim_ef"] == 0.0 for row in with_swim_ef)
    for with_row, without_row in zip(with_swim_ef, without_swim_ef):
        assert with_row["durable_base"] == without_row["durable_base"]
        assert with_row["confidence"] == without_row["confidence"]
        assert with_row["durable_band_lo"] == without_row["durable_band_lo"]
        assert with_row["durable_band_hi"] == without_row["durable_band_hi"]


# ===========================================================================
# F5: B is stamped with the PREVIOUS completed week — no intra-week lookahead.
# ===========================================================================

def test_b_has_no_intra_week_lookahead(monkeypatch):
    # First-week days carry B=0 (no completed predecessor week yet): the very first
    # session cannot retroactively raise B for the days before it in the same week.
    rows = _run_synthetic(monkeypatch, aerobic_type="running", with_vo2=False)
    assert rows[0]["base_accum_b"] == 0.0
    # B still builds through the block and decays through the gap (unchanged trend),
    # only now lagged by one completed week rather than reading its own week ahead.
    bs = [r["base_accum_b"] for r in rows]
    assert bs[10] < bs[250]
    assert bs[299] > bs[-1]


# ===========================================================================
# F4: personal detrained baselines RATCHET (widen-only) via fitted_from.
# ===========================================================================

def test_baseline_ratchet_persists_lifetime_extremes(monkeypatch):
    # No stored extremes yet → the run seeds fitted_from with this window's
    # RHR max / VO2 min (the most-detrained extremes) and valid-day counts.
    rows = _run_synthetic(monkeypatch, aerobic_type="running")
    ff = rows.fitted_from
    assert ff is not None
    assert ff["rhr_lifetime_max"] == 58.0     # the only RHR value in the synthetic
    assert ff["vo2_lifetime_min"] == 42.0     # the only VO2max value
    assert ff["rhr_valid_days"] > 0


def test_baseline_ratchet_only_widens_never_shrinks(monkeypatch):
    # A stored MORE-detrained history (higher RHR, lower VO2, larger valid-day
    # count) must SURVIVE even though this window's trained extremes are milder.
    stored = {
        "rhr_lifetime_max": 72.0,   # more detrained than the window's 58
        "vo2_lifetime_min": 30.0,   # more detrained than the window's 42
        "rhr_valid_days": 900,
        "vo2_valid_days": 900,
    }
    params = {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 200, "fitted_from": stored,
    }
    rows = _run_synthetic(monkeypatch, aerobic_type="running", params=params)
    ff = rows.fitted_from
    # widen-only: the detrained extremes are kept, not overwritten by trained ones.
    assert ff is None or (
        ff["rhr_lifetime_max"] == 72.0 and ff["vo2_lifetime_min"] == 30.0
        and ff["rhr_valid_days"] == 900 and ff["vo2_valid_days"] == 900
    )
