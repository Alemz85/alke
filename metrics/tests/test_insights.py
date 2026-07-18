"""Insights layer tests (SPEC §5.4): correlations with lags + the EF
distributed-lag model."""

import numpy as np
import pandas as pd
import pytest

from metrics.insights import (
    _bh_qvalues,
    _block_bootstrap_stability,
    _effective_n,
    _lag1_autocorr,
    _nw_maxlags,
    apply_persistence,
    compute_correlations,
    discover_adjusted_insights,
    ef_dlm,
    weight_series,
    zscore_trailing,
)

RNG = np.random.default_rng(7)


def make_frame(n=200):
    dates = pd.date_range("2026-01-01", periods=n, freq="D")
    sleep = RNG.normal(450, 40, n)
    return pd.DataFrame(
        {
            "sleep_duration": sleep,
            "rhr_dev": RNG.normal(0, 2, n),
            "trimp_total": RNG.normal(50, 20, n),
        },
        index=dates,
    )


def test_zscore_trailing_zero_mean_unit_sd():
    frame = make_frame()
    z = zscore_trailing(frame, days=180)
    assert len(z) <= 180
    for col in z.columns:
        assert z[col].mean() == pytest.approx(0.0, abs=1e-9)
        assert z[col].std(ddof=0) == pytest.approx(1.0, abs=1e-9)


def test_correlations_detect_lagged_relationship():
    frame = make_frame()
    # ef today strongly follows yesterday's sleep
    frame["ef"] = np.nan
    frame.iloc[1:, frame.columns.get_loc("ef")] = frame["sleep_duration"].to_numpy()[:-1] * 0.001
    rows = compute_correlations(frame, drivers=["sleep_duration"], perfs=["ef"], max_lag=3)
    by_lag = {r["lag_days"]: r for r in rows}
    assert by_lag[1]["r"] == pytest.approx(1.0, abs=1e-6)
    assert by_lag[1]["p_value"] < 1e-6
    assert abs(by_lag[0]["r"]) < 0.5  # same-day should be much weaker
    assert all(r["n"] >= 20 for r in rows)


def test_correlations_skip_small_n():
    frame = make_frame(30)
    frame["ef"] = np.nan
    frame.iloc[:10, frame.columns.get_loc("ef")] = 0.2  # only 10 obs -> n<20
    rows = compute_correlations(frame, drivers=["sleep_duration"], perfs=["ef"], max_lag=1)
    assert rows == []


def _planted_frame_and_specs(n=240, seed=85):
    """A frame with a real driver→outcome effect, a confound, and a near-copy
    of the confound (collinear-control fodder), plus its single-candidate spec."""
    dates = pd.date_range("2025-01-01", periods=n, freq="D")
    rng = np.random.default_rng(seed)
    driver = rng.normal(size=n)
    confound = rng.normal(size=n)
    outcome = 0.55 * driver + 0.8 * confound + rng.normal(0, 0.65, n)
    frame = pd.DataFrame(
        {
            "driver": driver,
            "outcome": outcome,
            "confound": confound,
            "confound_copy": confound + rng.normal(0, 0.001, n),
        },
        index=dates,
    )
    specs = [{
        "name": "driver_to_outcome",
        "label": "Driver → outcome",
        "driver": "driver",
        "outcome": "outcome",
        "controls": ["confound", "confound_copy"],
        "direction": "lagged",
    }]
    return frame, specs


def test_adjusted_finder_recovers_stable_signal_and_drops_collinear_control():
    frame, specs = _planted_frame_and_specs()

    model = discover_adjusted_insights(frame, specs=specs, min_n=60, boot_reps=60)
    candidate = model["diagnostics"]["candidates"][0]
    # tonight's statistical verdict clears every gate...
    assert candidate["raw_status"] == "signal"
    assert candidate["partial_r"] > 0.4
    assert candidate["q_value"] < 0.1
    assert candidate["stable"] is True
    assert candidate["boot_sign_agree"] >= 0.9
    assert candidate["n_eff"] >= 30
    assert "confound_copy" in candidate["dropped_controls"]
    # ...but the surfaced status waits for multi-night persistence
    assert candidate["status"] == "watch"
    assert candidate["persistence"] == {"streak": 1, "miss_streak": 0}

    # with persistence dialed to a single night it promotes immediately
    fast = discover_adjusted_insights(
        frame, specs=specs, min_n=60, boot_reps=60, promote_after=1, run_placebos=False
    )
    assert fast["diagnostics"]["candidates"][0]["status"] == "signal"


def test_adjusted_finder_does_not_promote_random_noise():
    n = 180
    dates = pd.date_range("2025-01-01", periods=n, freq="D")
    rng = np.random.default_rng(17)
    frame = pd.DataFrame({"x": rng.normal(size=n), "y": rng.normal(size=n)}, index=dates)
    specs = [{
        "name": "noise",
        "label": "Noise",
        "driver": "x",
        "outcome": "y",
        "controls": [],
        "direction": "co-measured",
    }]
    model = discover_adjusted_insights(frame, specs=specs, min_n=60, boot_reps=40, run_placebos=False)
    candidate = model["diagnostics"]["candidates"][0]
    assert candidate["raw_status"] == "no_clear_signal"
    assert candidate["status"] == "no_clear_signal"


def test_finder_persistence_promotes_signal_after_seven_nights():
    frame, specs = _planted_frame_and_specs()
    state = None
    statuses = []
    for _ in range(7):
        model = discover_adjusted_insights(
            frame, specs=specs, min_n=60, prior_state=state, boot_reps=25, run_placebos=False
        )
        candidate = model["diagnostics"]["candidates"][0]
        statuses.append(candidate["status"])
        state = model["diagnostics"]["persistence"]["state"]
    assert statuses[:6] == ["watch"] * 6
    assert statuses[6] == "signal"
    assert candidate["persistence"]["streak"] == 7


def _cand(name, raw):
    return {"name": name, "raw_status": raw}


def test_apply_persistence_promotes_after_streak_and_demotes_after_misses():
    # night 1: a raw signal surfaces as watch (persistence pending)
    cand = _cand("a", "signal")
    state = apply_persistence([cand], None, promote_after=3, demote_after=2)
    assert cand["status"] == "watch"
    assert state["a"] == {"streak": 1, "miss_streak": 0, "surfaced": "watch"}
    # nights 2-3: streak reaches promote_after → surfaced signal
    cand = _cand("a", "signal")
    state = apply_persistence([cand], state, promote_after=3, demote_after=2)
    assert cand["status"] == "watch"
    cand = _cand("a", "signal")
    state = apply_persistence([cand], state, promote_after=3, demote_after=2)
    assert cand["status"] == "signal"
    # a raw watch night is NOT a miss — surfaced signal sticks
    cand = _cand("a", "watch")
    state = apply_persistence([cand], state, promote_after=3, demote_after=2)
    assert cand["status"] == "signal"
    # first raw miss: still surfaced (1 < demote_after)
    cand = _cand("a", "no_clear_signal")
    state = apply_persistence([cand], state, promote_after=3, demote_after=2)
    assert cand["status"] == "signal"
    # second consecutive miss hits demote_after → falls back to the raw status
    cand = _cand("a", "no_clear_signal")
    state = apply_persistence([cand], state, promote_after=3, demote_after=2)
    assert cand["status"] == "no_clear_signal"


def test_apply_persistence_carries_absent_candidates_unchanged():
    prior = {"ghost": {"streak": 2, "miss_streak": 0, "surfaced": "watch"}}
    new_state = apply_persistence([_cand("a", "no_clear_signal")], prior)
    assert new_state["ghost"] == {"streak": 2, "miss_streak": 0, "surfaced": "watch"}
    assert new_state["a"]["surfaced"] == "no_clear_signal"


def test_placebo_suite_runs_identical_gates_and_stays_quiet():
    frame, specs = _planted_frame_and_specs()
    model = discover_adjusted_insights(frame, specs=specs, min_n=60, boot_reps=40)
    placebo = model["diagnostics"]["placebo"]
    # one spec × three circular shifts, all long enough for a 240-day frame
    assert placebo["shifts"] == [61, 91, 122]
    assert placebo["tested"] == 3
    # shifted null drivers must not clear the gates the real driver clears
    assert placebo["signal_count"] == 0
    assert all("raw_status" in row for row in placebo["candidates"])
    assert all(row["name"].startswith("driver_to_outcome__placebo") for row in placebo["candidates"])


def test_effective_n_gate_blocks_smooth_null_pair():
    # Two independent near-random-walk series: without a lagged-outcome control
    # only a small fraction of rows carry independent information, so the finder
    # must refuse to test rather than hand HAC an impossible inference job.
    rng = np.random.default_rng(11)
    n = 220
    frame = pd.DataFrame(
        {"x": _ar1(n, 0.95, 1.0, rng), "y": _ar1(n, 0.95, 1.0, rng)},
        index=pd.date_range("2025-01-01", periods=n, freq="D"),
    )
    specs = [{
        "name": "smooth_null",
        "label": "Smooth null",
        "driver": "x",
        "outcome": "y",
        "controls": [],
        "direction": "co-measured",
    }]
    model = discover_adjusted_insights(frame, specs=specs, min_n=60, boot_reps=20, run_placebos=False)
    candidate = model["diagnostics"]["candidates"][0]
    assert candidate["raw_status"] == "insufficient"
    assert candidate["reason"] == "effective_n"
    assert candidate["status"] == "insufficient"
    assert candidate["n_eff"] < 30


def test_nw_maxlags_rule_of_thumb():
    assert _nw_maxlags(100) == 4
    assert _nw_maxlags(400) == 5
    assert _nw_maxlags(10) == 2
    assert _nw_maxlags(1) >= 1


def test_block_bootstrap_stability_strong_vs_noise_and_deterministic():
    rng = np.random.default_rng(5)
    n = 200
    x = rng.normal(size=n)
    strong = pd.DataFrame({"x": x, "y": 0.8 * x + rng.normal(0, 0.5, n)})
    noise = pd.DataFrame({"x": rng.normal(size=n), "y": rng.normal(size=n)})

    s = _block_bootstrap_stability(strong, [], 0.8, "strong", reps=100)
    assert s["stable"] is True
    assert s["agree"] >= 0.99
    w = _block_bootstrap_stability(noise, [], 0.02, "noise", reps=100)
    assert w["stable"] is False
    # crc32(name)-seeded rng: same data + name → identical verdict every run
    assert _block_bootstrap_stability(strong, [], 0.8, "strong", reps=100) == s


def test_ef_dlm_recovers_coefficient_and_requires_40_obs():
    n = 120
    dates = pd.date_range("2026-01-01", periods=n, freq="D")
    sleep = RNG.normal(450, 40, n)
    frame = pd.DataFrame(
        {
            "sleep_duration": sleep,
            "rhr_dev": RNG.normal(0, 2, n),
            "ctl": RNG.normal(20, 5, n),
            "atl": RNG.normal(25, 8, n),
        },
        index=dates,
    )
    sleep_prev = np.roll(sleep, 1)
    frame["ef"] = 0.1 + 0.0005 * sleep_prev + RNG.normal(0, 0.001, n)
    frame.iloc[0, frame.columns.get_loc("ef")] = np.nan  # no lag for day one

    model = ef_dlm(frame)
    assert model is not None
    assert model["name"] == "ef_on_sleep_dlm"
    assert model["coefficients"]["sleep_prev"]["coef"] == pytest.approx(0.0005, rel=0.15)
    assert model["diagnostics"]["n"] >= 40
    assert 0 < model["diagnostics"]["r2"] <= 1
    assert "caveat" in model["diagnostics"]
    ci = model["coefficients"]["sleep_prev"]
    assert ci["ci_low"] < ci["coef"] < ci["ci_high"]

    # under 40 EF observations -> None
    small = frame.copy()
    small.iloc[40:, small.columns.get_loc("ef")] = np.nan
    assert ef_dlm(small) is None


def test_weight_series_linear_decline_gives_constant_negative_slope():
    n = 60
    dates = pd.date_range("2026-01-01", periods=n, freq="D")
    # exactly -0.1 kg/day -> -0.7 kg/week
    raw = pd.Series(90.0 - 0.1 * np.arange(n), index=dates)
    weight, slope = weight_series(raw)

    assert weight.equals(raw)  # no gaps to ffill, raw passes through unchanged

    tail_slope = slope.dropna().iloc[-10:]
    assert tail_slope.mean() == pytest.approx(-0.7, abs=0.05)
    assert tail_slope.std() < 0.05  # ~constant


def test_weight_series_ffills_gaps_up_to_3_days_not_more():
    dates = pd.date_range("2026-01-01", periods=10, freq="D")
    raw = pd.Series(
        [80.0, np.nan, np.nan, np.nan, np.nan, 79.0, np.nan, np.nan, np.nan, np.nan],
        index=dates,
    )
    weight, _ = weight_series(raw)

    # day 1..3 after a reading bridge the gap (limit=3)
    assert weight.iloc[1] == pytest.approx(80.0)
    assert weight.iloc[2] == pytest.approx(80.0)
    assert weight.iloc[3] == pytest.approx(80.0)
    # day 4 is beyond the 3-day bridge -> stays NaN
    assert pd.isna(weight.iloc[4])

    assert weight.iloc[6] == pytest.approx(79.0)
    assert weight.iloc[7] == pytest.approx(79.0)
    assert weight.iloc[8] == pytest.approx(79.0)
    assert pd.isna(weight.iloc[9])


def test_weight_series_missing_column_no_crash():
    weight, slope = weight_series(None)
    assert weight is None
    assert slope is None


def test_weight_series_coerces_string_values():
    dates = pd.date_range("2026-01-01", periods=5, freq="D")
    raw = pd.Series(["80.5", "80.4", None, "80.2", "80.1"], index=dates)
    weight, _ = weight_series(raw)
    assert weight.iloc[0] == pytest.approx(80.5)
    assert weight.iloc[2] == pytest.approx(80.4)  # ffilled from previous day


def test_correlations_detect_driver_to_weight_slope_relationship():
    frame = make_frame(200)
    # plant a same-day relationship between rhr_dev and weight_7d_slope
    frame["weight_7d_slope"] = frame["rhr_dev"] * 0.05 + RNG.normal(0, 0.01, 200)
    rows = compute_correlations(frame, drivers=["rhr_dev"], perfs=["weight_7d_slope"], max_lag=0)
    assert len(rows) == 1
    assert rows[0]["r"] > 0.8
    assert rows[0]["n"] >= 20


def test_correlations_tolerates_missing_weight_column():
    frame = make_frame(200)  # no weight_7d_slope column at all
    rows = compute_correlations(frame, drivers=["rhr_dev"], perfs=["weight_7d_slope"], max_lag=1)
    assert rows == []


# --- F3: effective-sample-size correction + BH q-values on autocorrelated series ---

def _ar1(n, phi, sd, rng):
    """A synthetic AR(1) series x_t = phi·x_{t-1} + eps."""
    x = np.zeros(n)
    for i in range(1, n):
        x[i] = phi * x[i - 1] + rng.normal(0, sd)
    return x


def test_lag1_autocorr_recovers_ar1_phi():
    rng = np.random.default_rng(3)
    x = _ar1(4000, 0.9, 1.0, rng)
    assert _lag1_autocorr(pd.Series(x)) == pytest.approx(0.9, abs=0.05)
    # a clamp + degenerate guard: constant series → 0 (treated iid)
    assert _lag1_autocorr(pd.Series([5.0] * 50)) == 0.0


def test_effective_n_shrinks_for_autocorrelated_series():
    # Two series each with lag-1 autocorr 0.9 → n_eff = n·(1−0.81)/(1+0.81) ≈ 0.105·n.
    assert _effective_n(200, 0.9, 0.9) == pytest.approx(200 * (1 - 0.81) / (1 + 0.81), abs=1.0)
    # iid series (r1=0) → n_eff == n (no penalty).
    assert _effective_n(200, 0.0, 0.0) == 200
    # clamped to [3, n].
    assert _effective_n(200, 0.99, 0.99) >= 3.0
    assert _effective_n(200, 0.9, 0.9) <= 200


def test_autocorrelation_correction_makes_p_less_overconfident():
    # Two INDEPENDENT AR(1) series (no true relationship). The iid pearsonr p can
    # look "significant" by chance because each series carries far less independent
    # information than its length; the effective-n correction must widen (raise) p.
    rng = np.random.default_rng(11)
    n = 220
    x = _ar1(n, 0.92, 1.0, rng)
    y = _ar1(n, 0.92, 1.0, rng)
    dates = pd.date_range("2025-01-01", periods=n, freq="D")
    frame = pd.DataFrame({"drv": x, "prf": y}, index=dates)
    rows = compute_correlations(frame, drivers=["drv"], perfs=["prf"], max_lag=0)
    assert len(rows) == 1
    row = rows[0]
    # the correction never makes the series look MORE certain: corrected ≥ naive.
    assert row["p_value"] >= row["p_value_naive"] - 1e-9
    # effective n is materially smaller than the raw n for phi≈0.9 series.
    assert row["n_eff"] < row["n"]
    # q_value is attached and ≥ its own p (single-test BH q == p here).
    assert row["q_value"] == pytest.approx(row["p_value"], abs=1e-9)


def test_bh_qvalues_monotone_and_ordered():
    q = _bh_qvalues([0.001, 0.5, 0.02, 0.8])
    assert len(q) == 4
    assert all(0.0 <= v <= 1.0 for v in q)
    # BH: smallest p gets the tightest q; q is monotone in p-rank.
    assert q[0] <= q[2] <= q[1] <= q[3]
    assert _bh_qvalues([]) == []


def test_correlations_attach_qvalue_across_sweep():
    frame = make_frame(200)
    frame["ef"] = frame["sleep_duration"] * 0.001 + RNG.normal(0, 0.01, 200)
    rows = compute_correlations(
        frame, drivers=["sleep_duration", "rhr_dev"], perfs=["ef"], max_lag=2
    )
    assert rows  # sweep produced pairs
    assert all("q_value" in r and "n_eff" in r and "p_value_naive" in r for r in rows)


def test_perfs_constant_includes_weight_slope():
    from metrics.insights import PERFS

    assert "weight_7d_slope" in PERFS


def test_default_specs_include_steps_candidates():
    # NEAT hypothesis gets a controlled test, not just the raw sweep: steps
    # candidates must control for training load so big-step days don't proxy
    # long workouts.
    from metrics.insights import DEFAULT_ADJUSTED_SPECS

    steps_specs = {s["name"]: s for s in DEFAULT_ADJUSTED_SPECS if s["driver"] == "steps_prior"}
    assert {"steps_to_rhr", "steps_to_hrv", "steps_to_sleep"} <= set(steps_specs)
    assert all("trimp_prior" in s["controls"] for s in steps_specs.values())


def test_correlations_spearman_flags_outlier_driven_pair():
    n = 60
    rng = np.random.default_rng(42)
    x = rng.normal(0, 1, n)
    y = rng.normal(0, 1, n)
    x[0] = 40.0
    y[0] = 40.0  # one shared extreme day fabricates a Pearson relationship
    frame = pd.DataFrame(
        {"drv": x, "prf": y}, index=pd.date_range("2026-01-01", periods=n, freq="D")
    )
    rows = compute_correlations(frame, drivers=["drv"], perfs=["prf"], max_lag=0)
    assert len(rows) == 1
    row = rows[0]
    assert row["r"] > 0.8  # Pearson is fooled by the outlier
    assert abs(row["spearman_r"]) < 0.4  # ranks are not
    assert row["rank_disagree"] is True


def test_correlations_agreeing_pair_not_flagged():
    frame = make_frame(200)
    frame["ef"] = frame["sleep_duration"] * 0.001 + RNG.normal(0, 0.001, 200)
    rows = compute_correlations(frame, drivers=["sleep_duration"], perfs=["ef"], max_lag=0)
    row = rows[0]
    assert "spearman_r" in row
    assert row["rank_disagree"] is False


def test_correlations_skip_trivial_shifted_pair():
    # trimp_prior IS trimp_total shifted a day — correlating them only measures
    # training-schedule autocorrelation, so the sweep must skip the pair.
    frame = make_frame(120)
    frame["trimp_prior"] = frame["trimp_total"].shift(1)
    rows = compute_correlations(frame, drivers=["trimp_prior"], perfs=["trimp_total"], max_lag=2)
    assert rows == []


def test_ef_dlm_drops_collinear_regressor():
    n = 120
    rng = np.random.default_rng(9)
    dates = pd.date_range("2026-01-01", periods=n, freq="D")
    sleep = rng.normal(450, 40, n)
    ctl = rng.normal(20, 5, n)
    frame = pd.DataFrame(
        {
            "sleep_duration": sleep,
            "rhr_dev": rng.normal(0, 2, n),
            "ctl": ctl,
            "atl": ctl * 1.2 + rng.normal(0, 0.1, n),  # near-copy of ctl
        },
        index=dates,
    )
    sleep_prev = np.roll(sleep, 1)
    frame["ef"] = 0.1 + 0.0005 * sleep_prev + rng.normal(0, 0.001, n)
    frame.iloc[0, frame.columns.get_loc("ef")] = np.nan

    model = ef_dlm(frame)
    assert "atl" in model["diagnostics"]["dropped_regressors"]
    assert "atl" not in model["coefficients"]
    # the model still recovers the planted sleep coefficient without atl
    assert model["coefficients"]["sleep_prev"]["coef"] == pytest.approx(0.0005, rel=0.15)


def test_perf_series_by_date_ef_is_swim_only():
    # ef_eligibility now extends to bikes (bike EF feeds the zone2 durable
    # calibration), but swim EF (~0.5–1.5 m/min/bpm) and bike EF (~2–4) are
    # incomparable units — the insights per-day EF series must stay SWIM-ONLY,
    # while decoupling/hrr60 (relative/HR-domain) stay cross-sport.
    from zoneinfo import ZoneInfo

    from metrics.compute import perf_series_by_date

    tz = ZoneInfo("Europe/Paris")
    workouts = [
        {"id": "w-swim", "type": "pool_swim", "start_at": "2026-07-01T10:00:00Z"},
        {"id": "w-bike", "type": "indoor_cycling", "start_at": "2026-07-01T18:00:00Z"},
        {"id": "w-none", "type": "cycling", "start_at": "2026-07-02T10:00:00Z"},
    ]
    perf_by_id = {
        "w-swim": {"ef": 1.2, "decoupling_pct": 3.0, "hrr60": None},
        "w-bike": {"ef": 3.1, "decoupling_pct": 5.0, "hrr60": 22.0},
        # no computed row for w-none -> skipped entirely
    }
    out = perf_series_by_date(workouts, perf_by_id, tz)
    from datetime import date

    day = date(2026, 7, 1)
    assert out[day]["ef"] == [1.2]                 # bike EF excluded from the series
    assert sorted(out[day]["decoupling"]) == [3.0, 5.0]  # cross-sport preserved
    assert out[day]["hrr60"] == [22.0]
    assert date(2026, 7, 2) not in out
