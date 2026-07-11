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

TZ = ZoneInfo("Europe/Berlin")
NOW = datetime(2026, 7, 11, 3, 30, tzinfo=timezone.utc)


def _run_synthetic(monkeypatch, with_ef=True, with_rhr=True, with_vo2=True, steps_per_day=8000):
    """400-day synthetic history. Toggles let the level-fusion tests isolate one
    signal at a time: with_ef=False drops ride EF (no distance in practice),
    with_rhr=False drops resting-HR data, with_vo2=False drops watch VO2max."""
    today = NOW.astimezone(TZ).date()
    n_days = 400
    days = [today - timedelta(days=n_days - 1 - i) for i in range(n_days)]

    # An indoor_cycling Z2 ride every 3rd day for the first 300 days, then a
    # 100-day full gap. Strength sessions every 2nd day THROUGHOUT — if they
    # leaked into w(t), the gap would never read as a gap.
    workouts, zones, computed = [], {}, []
    for i, d in enumerate(days):
        if i % 3 == 0 and i < 300:
            w = {"id": f"bike{i}", "type": "indoor_cycling",
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
         "vo2max": 42.0 if (with_vo2 and i in (50, 200)) else None}
        for i, d in enumerate(days)
    ]
    daily_rows = [{"date": d.isoformat(), "rhr_dev": 0.5, "hrv_dev": -1.0} for d in days]

    captured = {}
    monkeypatch.setattr(db, "fetch_zone2_fitness_params", lambda sb: {
        "id": 1, "stage": "literature", "fast_sat": 26, "rhr_top_amateur": 48,
        "ef_top_factor": 1.6, "b_ref_min_per_wk": 0,  # 0 → guard must kick in
    })
    monkeypatch.setattr(db, "fetch_computed_workout_zones", lambda sb: zones)
    monkeypatch.setattr(db, "fetch_computed_workouts", lambda sb: computed)
    monkeypatch.setattr(db, "fetch_active_injury_holds",
                        lambda sb: {"active_injuries": 0, "active_constraints": 0})
    monkeypatch.setattr(db, "upsert_computed_zone2_fitness",
                        lambda sb, rows: captured.setdefault("rows", rows))

    compute.run_zone2_fitness(None, workouts, daily_metrics, daily_rows, days, TZ, NOW)
    return captured["rows"]


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
