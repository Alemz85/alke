"""Insights layer tests (SPEC §5.4): exploratory and adjusted correlations."""

from datetime import date

import numpy as np
import pandas as pd
import pytest

from metrics.insights import (
    _bh_qvalues,
    _block_bootstrap_stability,
    _calendar_covariates,
    _evaluate_cyclic_spec,
    _effective_n,
    _evaluate_spec,
    _lag1_autocorr,
    _nw_maxlags,
    _suppress_placebo_sensitive,
    apply_persistence,
    compute_correlations,
    discover_adjusted_insights,
    discover_workout_context_insights,
    prior_rolling_deviation,
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


def test_calendar_trend_uses_elapsed_days_not_workout_row_order():
    index = pd.to_datetime(
        ["2026-01-01 08:00", "2026-01-01 18:00", "2026-01-04 09:00"]
    )

    calendar = _calendar_covariates(index)

    assert calendar["time_trend"].tolist() == [0.0, 0.0, 3.0]


def test_zscore_trailing_zero_mean_unit_sd():
    frame = make_frame()
    z = zscore_trailing(frame, days=180)
    assert len(z) <= 180
    for col in z.columns:
        assert z[col].mean() == pytest.approx(0.0, abs=1e-9)
        assert z[col].std(ddof=0) == pytest.approx(1.0, abs=1e-9)


def test_prior_rolling_deviation_excludes_current_observation_and_uses_calendar_days():
    dates = pd.to_datetime(
        [
            "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
            "2026-01-10", "2026-01-11",
        ]
    )
    values = pd.Series([8.0, 8.0, 8.0, 8.0, 20.0, 7.0], index=dates)

    deviation = prior_rolling_deviation(values, days=7, min_periods=2)

    # Jan 10 only sees Jan 3-4 in the prior 7 calendar days. Its extreme current
    # value cannot pull its own baseline upward.
    assert deviation.loc["2026-01-10"] == pytest.approx(12.0)
    # Jan 11 sees Jan 4 and Jan 10; it is not the "last two observations" rule.
    assert deviation.loc["2026-01-11"] == pytest.approx(7.0 - 14.0)


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
    assert model["diagnostics"]["model_version"] == 9
    assert "finalized" in model["diagnostics"]["caveat"]
    assert candidate["raw_status"] == "no_clear_signal"
    assert candidate["status"] == "no_clear_signal"


def test_adjusted_finder_removes_shared_annual_seasonality():
    rng = np.random.default_rng(171)
    n = 730
    dates = pd.date_range("2024-01-01", periods=n, freq="D")
    annual = np.sin(2 * np.pi * np.arange(n) / 365.2425)
    frame = pd.DataFrame(
        {
            "driver": annual + rng.normal(0, 0.2, n),
            "outcome": annual + rng.normal(0, 0.2, n),
        },
        index=dates,
    )
    specs = [{
        "name": "seasonal", "label": "Seasonal", "driver": "driver",
        "outcome": "outcome", "controls": [], "direction": "co-measured",
    }]

    model = discover_adjusted_insights(
        frame, specs=specs, min_n=60, boot_reps=30, run_placebos=False,
    )
    candidate = model["diagnostics"]["candidates"][0]

    assert abs(candidate["partial_r"]) < 0.15
    assert candidate["raw_status"] == "no_clear_signal"


def test_cyclic_workout_candidate_recovers_peak_across_midnight_safe_clock():
    rng = np.random.default_rng(91)
    n = 240
    hours = rng.uniform(0, 24, n)
    theta = 2 * np.pi * hours / 24
    # A planted peak at 18:00. The relationship is circular rather than a
    # discontinuous 0..24 linear slope.
    outcome = 1.1 * np.cos(2 * np.pi * (hours - 18) / 24) + rng.normal(0, 0.35, n)
    frame = pd.DataFrame(
        {
            "start_sin": np.sin(theta),
            "start_cos": np.cos(theta),
            "outcome": outcome,
        },
        index=pd.date_range("2025-01-01", periods=n, freq="2D"),
    )
    spec = {
        "name": "time_to_outcome",
        "label": "Workout time → outcome",
        "outcome": "outcome",
        "controls": [],
        "direction": "circadian",
    }

    result = _evaluate_cyclic_spec(frame, spec, min_n=60, boot_reps=80)

    assert result is not None
    assert result["p_value"] < 1e-6
    assert result["effect_size"] > 0.7
    assert result["stable"] is True
    assert result["phase_within_6h"] >= 0.8
    assert result["peak_hour"] == pytest.approx(18.0, abs=1.0)


def test_cyclic_workout_candidate_refuses_to_extrapolate_from_one_time_window():
    rng = np.random.default_rng(911)
    n = 100
    hours = rng.uniform(17, 19, n)
    theta = 2 * np.pi * hours / 24
    frame = pd.DataFrame(
        {"start_sin": np.sin(theta), "start_cos": np.cos(theta), "outcome": rng.normal(size=n)},
        index=pd.date_range("2025-01-01", periods=n, freq="D"),
    )
    spec = {
        "name": "narrow_time", "label": "Narrow time", "outcome": "outcome",
        "controls": [], "kind": "cyclic",
    }

    result = _evaluate_cyclic_spec(frame, spec, min_n=60, boot_reps=20)

    assert result is not None
    assert result["raw_status"] == "insufficient"
    assert result["reason"] == "time_coverage"
    assert result["time_bin_counts"]["morning"] == 0


def test_workout_context_finder_uses_own_model_name_and_multiplicity_pool():
    rng = np.random.default_rng(92)
    n = 180
    hours = rng.uniform(0, 24, n)
    theta = 2 * np.pi * hours / 24
    frame = pd.DataFrame(
        {
            "start_sin": np.sin(theta),
            "start_cos": np.cos(theta),
            "workout_intensity": np.cos(theta) + rng.normal(0, 0.3, n),
        },
        index=pd.date_range("2025-01-01", periods=n, freq="D"),
    )
    specs = [{
        "name": "time_to_intensity",
        "label": "Workout time → recorded intensity",
        "outcome": "workout_intensity",
        "controls": [],
        "direction": "circadian",
        "kind": "cyclic",
    }]

    model = discover_workout_context_insights(
        frame, specs=specs, min_n=60, boot_reps=50, promote_after=1,
        run_placebos=False,
    )

    assert model["name"] == "workout_context_finder"
    assert model["diagnostics"]["model_version"] == 15
    assert "finalized" in model["diagnostics"]["caveat"]
    assert "date-clustered" in model["spec"]
    assert "calendar-date block" in model["spec"]
    assert "wake-ordered sleep context" in model["spec"]
    assert "wake instant precedes" in model["diagnostics"]["caveat"]
    assert "recorded offset" in model["diagnostics"]["caveat"]
    assert "measured HR minute" in model["diagnostics"]["caveat"]
    assert "90%" in model["diagnostics"]["caveat"]
    assert "Apple energy intensity" in model["diagnostics"]["caveat"]
    candidate = model["diagnostics"]["candidates"][0]
    assert candidate["status"] == "signal"
    assert candidate["q_value"] == pytest.approx(candidate["p_value"])


def test_workout_context_requires_distinct_dates_not_duplicated_sessions():
    rng = np.random.default_rng(921)
    days = pd.date_range("2025-01-01", periods=40, freq="D")
    index = pd.DatetimeIndex(
        [day + pd.Timedelta(hours=hour) for day in days for hour in (8, 18)]
    )
    driver_by_day = rng.normal(size=len(days))
    driver = np.repeat(driver_by_day, 2)
    frame = pd.DataFrame(
        {
            "readiness": driver,
            "workout_duration": 0.7 * driver + rng.normal(0, 0.5, len(index)),
        },
        index=index,
    )
    specs = [{
        "name": "readiness_to_duration",
        "label": "Readiness → duration",
        "driver": "readiness",
        "outcome": "workout_duration",
        "controls": [],
        "direction": "morning-to-workout",
        "kind": "scalar",
    }]

    model = discover_workout_context_insights(
        frame, specs=specs, min_n=60, boot_reps=10, run_placebos=False
    )
    candidate = model["diagnostics"]["candidates"][0]

    assert candidate["n"] == 80
    assert candidate["n_days"] == 40
    assert candidate["raw_status"] == "insufficient"
    assert candidate["reason"] == "independent_dates"
    assert candidate["required_n_days"] == 60


def test_workout_timing_requires_distinct_dates_not_three_sessions_per_day():
    rng = np.random.default_rng(922)
    days = pd.date_range("2025-01-01", periods=30, freq="D")
    hours = np.tile([8.0, 14.0, 20.0], len(days))
    theta = 2 * np.pi * hours / 24
    index = pd.DatetimeIndex(
        [day + pd.Timedelta(hours=hour) for day in days for hour in (8, 14, 20)]
    )
    frame = pd.DataFrame(
        {
            "start_sin": np.sin(theta),
            "start_cos": np.cos(theta),
            "workout_intensity": np.cos(theta) + rng.normal(0, 0.3, len(index)),
        },
        index=index,
    )
    specs = [{
        "name": "time_to_intensity",
        "label": "Workout time → recorded intensity",
        "outcome": "workout_intensity",
        "controls": [],
        "direction": "circadian",
        "kind": "cyclic",
    }]

    model = discover_workout_context_insights(
        frame, specs=specs, min_n=60, boot_reps=10, run_placebos=False
    )
    candidate = model["diagnostics"]["candidates"][0]

    assert candidate["n"] == 90
    assert candidate["n_days"] == 30
    assert candidate["raw_status"] == "insufficient"
    assert candidate["reason"] == "independent_dates"


def test_workout_timing_coverage_counts_distinct_dates_per_clock_window():
    rng = np.random.default_rng(9221)
    days = pd.date_range("2025-01-01", periods=20, freq="D")
    timestamps = []
    for position, day in enumerate(days):
        morning_hours = (8, 10) if position < 5 else ()
        timestamps.extend(day + pd.Timedelta(hours=hour) for hour in (*morning_hours, 14, 20))
    index = pd.DatetimeIndex(timestamps)
    hours = index.hour.to_numpy(dtype=float)
    theta = 2 * np.pi * hours / 24
    frame = pd.DataFrame(
        {
            "start_sin": np.sin(theta),
            "start_cos": np.cos(theta),
            "workout_intensity": rng.normal(size=len(index)),
        },
        index=index,
    )
    specs = [{
        "name": "time_to_intensity",
        "label": "Workout time → recorded intensity",
        "outcome": "workout_intensity",
        "controls": [],
        "direction": "circadian",
        "kind": "cyclic",
    }]

    model = discover_workout_context_insights(
        frame, specs=specs, min_n=20, boot_reps=10, run_placebos=False
    )
    candidate = model["diagnostics"]["candidates"][0]

    assert candidate["raw_status"] == "insufficient"
    assert candidate["reason"] == "time_coverage"
    assert candidate["time_bin_counts"]["morning"] == 10
    assert candidate["time_bin_date_counts"]["morning"] == 5


def test_workout_scalar_inference_is_conservative_across_hac_and_date_clusters():
    rng = np.random.default_rng(923)
    days = pd.date_range("2025-01-01", periods=80, freq="D")
    index = pd.DatetimeIndex(
        [day + pd.Timedelta(hours=hour) for day in days for hour in (8, 18)]
    )
    driver_by_day = rng.normal(size=len(days))
    driver = np.repeat(driver_by_day, 2)
    day_error = np.repeat(rng.normal(0, 1.0, len(days)), 2)
    frame = pd.DataFrame(
        {
            "readiness": driver,
            "workout_duration": 0.35 * driver + day_error + rng.normal(0, 0.15, len(index)),
        },
        index=index,
    )
    specs = [{
        "name": "readiness_to_duration",
        "label": "Readiness → duration",
        "driver": "readiness",
        "outcome": "workout_duration",
        "controls": [],
        "direction": "morning-to-workout",
        "kind": "scalar",
    }]

    model = discover_workout_context_insights(
        frame, specs=specs, min_n=60, boot_reps=10, run_placebos=False
    )
    candidate = model["diagnostics"]["candidates"][0]

    assert candidate["n_days"] == 80
    assert candidate["n_eff"] <= candidate["n_days"]
    assert candidate["bootstrap_unit"] == "calendar_date"
    assert candidate["p_value"] == pytest.approx(
        max(candidate["p_value_hac"], candidate["p_value_date_cluster"])
    )
    assert candidate["ci_low"] == pytest.approx(
        min(candidate["ci_low_hac"], candidate["ci_low_date_cluster"])
    )
    assert candidate["ci_high"] == pytest.approx(
        max(candidate["ci_high_hac"], candidate["ci_high_date_cluster"])
    )


def test_workout_cosinor_inference_is_conservative_across_hac_and_date_clusters():
    rng = np.random.default_rng(924)
    days = pd.date_range("2025-01-01", periods=80, freq="D")
    hours = np.tile([8.0, 14.0, 20.0], len(days))
    theta = 2 * np.pi * hours / 24
    index = pd.DatetimeIndex(
        [day + pd.Timedelta(hours=hour) for day in days for hour in (8, 14, 20)]
    )
    day_error = np.repeat(rng.normal(0, 0.8, len(days)), 3)
    frame = pd.DataFrame(
        {
            "start_sin": np.sin(theta),
            "start_cos": np.cos(theta),
            "workout_intensity": np.cos(theta) + day_error + rng.normal(0, 0.2, len(index)),
        },
        index=index,
    )
    specs = [{
        "name": "time_to_intensity",
        "label": "Workout time → recorded intensity",
        "outcome": "workout_intensity",
        "controls": [],
        "direction": "circadian",
        "kind": "cyclic",
    }]

    model = discover_workout_context_insights(
        frame, specs=specs, min_n=60, boot_reps=10, run_placebos=False
    )
    candidate = model["diagnostics"]["candidates"][0]

    assert candidate["n_days"] == 80
    assert candidate["n_eff"] <= candidate["n_days"]
    assert candidate["bootstrap_unit"] == "calendar_date"
    assert candidate["p_value"] == pytest.approx(
        max(candidate["p_value_hac"], candidate["p_value_date_cluster"])
    )
    assert candidate["sin_ci_low"] == pytest.approx(
        min(candidate["sin_ci_low_hac"], candidate["sin_ci_low_date_cluster"])
    )
    assert candidate["sin_ci_high"] == pytest.approx(
        max(candidate["sin_ci_high_hac"], candidate["sin_ci_high_date_cluster"])
    )


def test_adjusted_finder_rejects_outlier_only_rank_disagreement():
    rng = np.random.default_rng(93)
    n = 100
    x = rng.normal(size=n)
    y = rng.normal(size=n)
    x[0] = 50.0
    y[0] = 50.0
    frame = pd.DataFrame({"x": x, "y": y}, index=pd.date_range("2025-01-01", periods=n))
    specs = [{
        "name": "outlier", "label": "Outlier", "driver": "x", "outcome": "y",
        "controls": [], "direction": "co-measured",
    }]

    model = discover_adjusted_insights(
        frame, specs=specs, min_n=60, boot_reps=40, promote_after=1,
        run_placebos=False,
    )
    candidate = model["diagnostics"]["candidates"][0]

    assert candidate["partial_r"] > 0.8
    assert abs(candidate["partial_spearman"]) < 0.4
    assert candidate["rank_disagree"] is True
    assert candidate["raw_status"] == "no_clear_signal"


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


def test_candidate_is_suppressed_only_by_its_own_firing_placebo():
    candidates = [
        {"name": "a", "raw_status": "signal"},
        {"name": "b", "raw_status": "signal"},
        {"name": "c", "raw_status": "no_clear_signal"},
    ]
    placebos = [
        {"name": "a__placebo61", "shift": 61, "raw_status": "watch"},
        {"name": "b__placebo61", "shift": 61, "raw_status": "no_clear_signal"},
        {"name": "c__placebo61", "shift": 61, "raw_status": "signal"},
    ]

    _suppress_placebo_sensitive(candidates, placebos)

    assert candidates[0]["raw_status"] == "suppressed_placebo"
    assert candidates[0]["placebo_sensitivity"]["shifts"] == [61]
    assert candidates[1]["raw_status"] == "signal"
    assert candidates[2]["raw_status"] == "no_clear_signal"


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


def test_calendar_block_bootstrap_keeps_every_session_from_a_sampled_date_together():
    from metrics import insights

    sampler = getattr(insights, "_calendar_block_bootstrap_sample", None)
    assert callable(sampler)

    days = pd.date_range("2026-01-01", periods=6, freq="D")
    index = pd.DatetimeIndex(
        [day + pd.Timedelta(hours=hour) for day in days for hour in (8, 18)]
    )
    data = pd.DataFrame(
        {
            "slot": np.tile(["morning", "evening"], len(days)),
            "x": np.arange(len(index), dtype=float),
            "y": np.arange(len(index), dtype=float),
        },
        index=index,
    )

    sample = sampler(data, np.random.default_rng(925), block_len=2)

    for _, group in sample.groupby(pd.DatetimeIndex(sample.index).normalize()):
        counts = group["slot"].value_counts()
        assert counts.get("morning", 0) == counts.get("evening", 0)


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
    # RHR is a finalized full-day aggregate, so only its prior-day value may
    # lead an outcome. Plant that temporally valid relationship.
    frame["weight_7d_slope"] = frame["rhr_dev"].shift(1) * 0.05 + RNG.normal(0, 0.01, 200)
    rows = compute_correlations(frame, drivers=["rhr_dev"], perfs=["weight_7d_slope"], max_lag=1)
    assert len(rows) == 1
    assert rows[0]["lag_days"] == 1
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


def test_correlation_pipeline_coerces_numeric_objects_with_an_empty_series():
    from metrics.insights import zscore_trailing

    dates = pd.date_range("2026-01-01", periods=80, freq="D")
    frame = pd.DataFrame(
        {
            "driver": pd.Series(np.arange(80, dtype=float), index=dates, dtype=object),
            "performance": pd.Series(np.arange(80, dtype=float), index=dates, dtype=object),
            "unavailable": [None] * 80,
        },
        index=dates,
    )

    standardized = zscore_trailing(frame)
    rows = compute_correlations(
        standardized, drivers=["driver"], perfs=["performance"], max_lag=0
    )

    assert standardized["driver"].dtype.kind == "f"
    assert len(rows) == 1
    assert rows[0]["r"] == pytest.approx(1.0)


def test_default_inference_keeps_swim_ef_descriptive():
    from metrics.insights import DEFAULT_ADJUSTED_SPECS, PERFS

    assert "weight_7d_slope" in PERFS
    assert "ef" not in PERFS
    assert all(spec["outcome"] != "ef" for spec in DEFAULT_ADJUSTED_SPECS)


def test_load_inference_is_conditional_on_measured_workout_days():
    from metrics.insights import DEFAULT_ADJUSTED_SPECS

    load_specs = [spec for spec in DEFAULT_ADJUSTED_SPECS if spec["outcome"] == "trimp_total"]
    assert load_specs
    assert all(spec["outcome_positive_only"] is True for spec in load_specs)
    assert {spec["name"] for spec in load_specs} == {
        "prior_rhr_to_workout_load",
        "prior_hrv_to_workout_load",
    }


def test_exploratory_load_correlations_exclude_rest_day_zeros_at_every_lag():
    dates = pd.date_range("2026-01-01", periods=80, freq="D")
    frame = pd.DataFrame(
        {
            "driver": np.arange(80, dtype=float),
            "trimp_total": [float(i + 1) if i % 2 else 0.0 for i in range(80)],
        },
        index=dates,
    )

    rows = compute_correlations(frame, drivers=["driver"], perfs=["trimp_total"], max_lag=2)

    assert [row["n"] for row in rows] == [40, 40, 39]


def test_adjusted_load_candidate_excludes_rest_day_zeros():
    rng = np.random.default_rng(22)
    dates = pd.date_range("2026-01-01", periods=100, freq="D")
    frame = pd.DataFrame(
        {
            "driver": rng.normal(size=100),
            "trimp_total": [float(20 + i) if i % 2 else 0.0 for i in range(100)],
        },
        index=dates,
    )
    spec = {
        "name": "conditional_load",
        "label": "Driver → workout-day load",
        "driver": "driver",
        "outcome": "trimp_total",
        "controls": [],
        "outcome_positive_only": True,
    }

    result = _evaluate_spec(frame, spec, min_n=20, boot_reps=10)

    assert result is not None
    assert result["n"] == 50


def test_default_specs_include_steps_candidates():
    # NEAT hypothesis gets a controlled test, not just the raw sweep: steps
    # candidates must control for training load so big-step days don't proxy
    # long workouts.
    from metrics.insights import DEFAULT_ADJUSTED_SPECS

    steps_specs = {s["name"]: s for s in DEFAULT_ADJUSTED_SPECS if s["driver"] == "steps_prior"}
    assert {"steps_to_sleep", "steps_to_sleep_continuity", "steps_to_respiration"} <= set(steps_specs)
    assert "steps_to_rhr" not in steps_specs
    assert "steps_to_hrv" not in steps_specs
    assert all("trimp_prior" in s["controls"] for s in steps_specs.values())
    # Flights starts later than steps. It gets its own mutually-adjusted
    # candidates, but must not redefine the established step population via
    # complete-case deletion.
    assert all("flights_prior" not in s["controls"] for s in steps_specs.values())


def test_default_specs_include_independent_stair_activity_candidates():
    from metrics.insights import DEFAULT_ADJUSTED_SPECS, DRIVERS

    flights_specs = {
        spec["name"]: spec
        for spec in DEFAULT_ADJUSTED_SPECS
        if spec["driver"] == "flights_prior"
    }
    assert "flights_prior" in DRIVERS
    assert set(flights_specs) == {
        "flights_to_sleep",
        "flights_to_sleep_continuity",
        "flights_to_respiration",
    }
    assert all(
        {"trimp_prior", "steps_prior", "ctl_pre_exposure"} <= set(spec["controls"])
        for spec in flights_specs.values()
    )


def test_default_specs_include_weekly_training_time_distribution_candidates():
    from metrics.insights import DEFAULT_ADJUSTED_SPECS, DEFAULT_WORKOUT_SPECS, DRIVERS

    daily_specs = {
        spec["name"]: spec
        for spec in DEFAULT_ADJUSTED_SPECS
        if spec["driver"] == "training_density_7d_prior"
    }
    assert "training_density_7d_prior" in DRIVERS
    assert set(daily_specs) == {
        "training_density_to_sleep",
        "training_density_to_sleep_continuity",
        "training_density_to_respiration",
    }
    assert all(
        {"duration_7d_prior", "trimp_prior", "ctl_pre_exposure"}
        <= set(spec["controls"])
        for spec in daily_specs.values()
    )

    workout_specs = {
        spec["outcome"]: spec
        for spec in DEFAULT_WORKOUT_SPECS
        if spec.get("driver") == "training_density_7d_prior"
    }
    assert set(workout_specs) == {
        "workout_duration",
        "workout_intensity",
        "energy_intensity",
        "high_zone_fraction",
    }
    assert all("duration_7d_prior" in spec["controls"] for spec in workout_specs.values())


def test_adjusted_specs_never_control_same_day_load_state():
    from metrics.insights import DEFAULT_ADJUSTED_SPECS

    controls = {control for spec in DEFAULT_ADJUSTED_SPECS for control in spec["controls"]}
    assert "ctl" not in controls
    assert "atl" not in controls
    assert "ctl_prior" in controls
    assert "ctl_pre_exposure" in controls


def test_default_specs_cover_respiration_continuity_and_relative_sleep():
    from metrics.insights import DEFAULT_ADJUSTED_SPECS

    names = {spec["name"] for spec in DEFAULT_ADJUSTED_SPECS}
    assert {
        "prior_load_to_respiration",
        "prior_load_to_sleep_continuity",
        "sleep_shortfall_to_hrv",
        "timing_to_respiration",
        "steps_to_sleep_continuity",
        "prior_high_zones_to_sleep",
        "prior_high_zones_to_sleep_continuity",
        "prior_high_zones_to_respiration",
    } <= names


def test_default_specs_distinguish_signed_sleep_phase_from_irregularity():
    from metrics.insights import DEFAULT_ADJUSTED_SPECS, DEFAULT_WORKOUT_SPECS, DRIVERS

    assert "sleep_midpoint_shift" in DRIVERS
    daily = {
        spec["outcome"]
        for spec in DEFAULT_ADJUSTED_SPECS
        if spec.get("driver") == "sleep_midpoint_shift"
    }
    workout = {
        spec["outcome"]
        for spec in DEFAULT_WORKOUT_SPECS
        if spec.get("driver") == "sleep_midpoint_shift"
    }
    assert daily == {
        "sleep_shortfall", "rhr_dev", "hrv_dev", "respiratory_rate_dev",
    }
    assert workout == {
        "workout_duration", "workout_intensity", "energy_intensity",
        "high_zone_fraction",
    }


def test_daily_aggregate_hr_is_never_treated_as_same_day_readiness():
    from metrics.insights import DEFAULT_ADJUSTED_SPECS, DEFAULT_WORKOUT_SPECS

    directed_daily_hr = [
        spec
        for spec in DEFAULT_ADJUSTED_SPECS
        if spec["outcome"] in {"rhr_dev", "hrv_dev"}
        and spec["direction"] != "co-measured"
    ]
    assert directed_daily_hr == []

    workout_drivers = {spec.get("driver") for spec in DEFAULT_WORKOUT_SPECS}
    assert {"rhr_dev_prior", "hrv_dev_prior"} <= workout_drivers
    assert "rhr_dev" not in workout_drivers
    assert "hrv_dev" not in workout_drivers
    assert all(
        spec["direction"] == "prior-day-to-workout"
        for spec in DEFAULT_WORKOUT_SPECS
        if spec.get("driver") in {"rhr_dev_prior", "hrv_dev_prior"}
    )

    workout_day_load = {
        spec["name"]: spec["driver"]
        for spec in DEFAULT_ADJUSTED_SPECS
        if spec["outcome"] == "trimp_total"
    }
    assert workout_day_load == {
        "prior_rhr_to_workout_load": "rhr_dev_prior",
        "prior_hrv_to_workout_load": "hrv_dev_prior",
    }


def test_workout_specs_control_session_sequence_and_include_wake_alignment():
    from metrics.insights import DEFAULT_WORKOUT_SPECS

    names = {spec["name"] for spec in DEFAULT_WORKOUT_SPECS}
    assert {
        "sleep_awake_fraction_to_workout_duration",
        "sleep_awake_fraction_to_workout_intensity",
        "sleep_shortfall_3d_to_workout_duration",
        "sleep_shortfall_3d_to_workout_intensity",
        "atl_prior_to_workout_duration",
        "atl_prior_to_workout_intensity",
        "log_hours_since_prev_workout_to_workout_duration",
        "log_hours_since_prev_workout_to_workout_intensity",
        "hours_awake_to_workout_duration",
        "hours_awake_to_workout_intensity",
        "hours_awake_to_energy_intensity",
        "high_zone_fraction_prior_to_workout_duration",
        "high_zone_fraction_prior_to_workout_intensity",
        "high_zone_fraction_prior_to_energy_intensity",
        "hours_awake_to_high_zone_fraction",
        "hrv_dev_prior_to_high_zone_fraction",
        "atl_prior_to_high_zone_fraction",
        "workout_time_to_load",
        "workout_time_to_energy_intensity",
        "workout_time_to_high_zones",
    } <= names
    for spec in DEFAULT_WORKOUT_SPECS:
        assert "same_day_prior_load" in spec["controls"]
        assert "log_same_day_prior_duration" in spec["controls"]
        assert "atl_prior" in spec["controls"] or spec.get("driver") == "atl_prior"
        assert (
            "log_hours_since_prev_workout" in spec["controls"]
            or spec.get("driver") == "log_hours_since_prev_workout"
        )
        assert "log_days_since_prev_modality" in spec["controls"]
        assert "log_modality_duration_28d_prior" in spec["controls"]
        assert spec.get("driver") not in spec["controls"]

    timing_specs = [spec for spec in DEFAULT_WORKOUT_SPECS if spec.get("kind") == "cyclic"]
    assert timing_specs
    assert all("hours_since_wake" in spec["controls"] for spec in timing_specs)


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


def test_correlations_skip_same_day_finalized_hr_aggregates_as_drivers():
    rng = np.random.default_rng(95)
    frame = pd.DataFrame(
        {
            "rhr_dev": rng.normal(size=100),
            "hrv_dev": rng.normal(size=100),
            "trimp_total": rng.uniform(1, 100, size=100),
        },
        index=pd.date_range("2025-01-01", periods=100, freq="D"),
    )

    rows = compute_correlations(
        frame,
        drivers=["rhr_dev", "hrv_dev"],
        perfs=["trimp_total"],
        max_lag=1,
    )

    assert {(row["var_x"], row["lag_days"]) for row in rows} == {
        ("rhr_dev", 1),
        ("hrv_dev", 1),
    }


def test_perf_series_by_date_keeps_ef_out_of_inference():
    # EF stays descriptive because swim EF combines technique reacquisition and
    # aerobic state. Decoupling/hrr60 remain valid cross-sport outcomes here.
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
    assert "ef" not in out[day]
    assert sorted(out[day]["decoupling"]) == [3.0, 5.0]  # cross-sport preserved
    assert out[day]["hrr60"] == [22.0]
    assert date(2026, 7, 2) not in out


def test_daily_insight_frame_uses_only_pre_outcome_load_controls():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_daily_insight_frame

    dates = pd.date_range("2026-01-01", periods=20, freq="D")
    daily_rows = [
        {
            "date": d.date().isoformat(),
            "rhr_dev": float(i), "hrv_dev": float(-i),
            "ctl": float(100 + i), "atl": float(200 + i),
            "trimp_total": float(i),
        }
        for i, d in enumerate(dates)
    ]
    daily_metrics = [
        {
            "date": d.date().isoformat(),
            "sleep_duration_min": 480.0 if i < 19 else 420.0,
            "sleep_start": f"{d.date().isoformat()}T00:00:00+00:00",
            "sleep_end": f"{d.date().isoformat()}T08:00:00+00:00",
            "sleep_stages": {"awake": 0.5, "core": 4.5, "deep": 1.0, "rem": 2.0},
            "respiratory_rate": 15.0 + i / 10,
            "steps": 5_000 + i,
            "flights_climbed": 3 + i,
        }
        for i, d in enumerate(dates)
    ]

    frame = build_daily_insight_frame(daily_metrics, daily_rows, ZoneInfo("UTC"))
    row = frame.iloc[-1]

    assert row["ctl_prior"] == pytest.approx(118.0)
    assert row["atl_prior"] == pytest.approx(218.0)
    assert row["ctl_pre_exposure"] == pytest.approx(117.0)
    assert row["trimp_prior"] == pytest.approx(18.0)
    assert row["flights_prior"] == pytest.approx(21.0)
    assert row["sleep_shortfall"] == pytest.approx(60.0)
    assert row["sleep_shortfall_3d"] == pytest.approx(20.0)
    assert row["sleep_awake_fraction"] == pytest.approx(0.5 / 8.0)
    assert row["wake_hour"] == pytest.approx(8.0)


def test_daily_insight_frame_masks_rolling_recovery_on_unmeasured_days():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_daily_insight_frame

    daily_rows = [
        {"date": "2026-01-01", "rhr_dev": 1.0, "hrv_dev": -2.0, "ctl": 5.0, "atl": 6.0, "trimp_total": 0.0},
        {"date": "2026-01-02", "rhr_dev": 1.0, "hrv_dev": -2.0, "ctl": 5.0, "atl": 6.0, "trimp_total": 0.0},
    ]
    daily_metrics = [
        {"date": "2026-01-01", "resting_hr": 52.0, "hrv_sdnn_ms": 65.0},
        {"date": "2026-01-02", "resting_hr": None, "hrv_sdnn_ms": None},
    ]

    frame = build_daily_insight_frame(daily_metrics, daily_rows, ZoneInfo("UTC"))

    assert frame.loc["2026-01-01", "rhr_dev"] == pytest.approx(1.0)
    assert frame.loc["2026-01-01", "hrv_dev"] == pytest.approx(-2.0)
    assert pd.isna(frame.loc["2026-01-02", "rhr_dev"])
    assert pd.isna(frame.loc["2026-01-02", "hrv_dev"])


def test_sleep_insight_eligibility_rejects_naps_stitched_spans_and_awake_only_rows():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_daily_insight_frame, sleep_insight_eligible

    valid = {
        "sleep_start": "2026-01-01T22:00:00Z",
        "sleep_end": "2026-01-02T06:00:00Z",
        "sleep_duration_min": 420.0,
        "sleep_stages": {"core": 4.0, "deep": 1.0, "rem": 2.0, "awake": 1.0},
    }
    assert sleep_insight_eligible(valid) is True
    assert sleep_insight_eligible({**valid, "sleep_duration_min": 120.0}) is False
    assert sleep_insight_eligible({
        **valid,
        "sleep_start": "2026-01-01T14:00:00Z",
    }) is False
    assert sleep_insight_eligible({
        **valid,
        "sleep_stages": {"core": 0, "deep": 0, "rem": 0, "awake": 7.0},
    }) is False

    variants = [
        valid,
        {**valid, "sleep_duration_min": 120.0},
        {**valid, "sleep_start": "2026-01-01T14:00:00Z"},
        {**valid, "sleep_stages": {"core": 0, "deep": 0, "rem": 0, "awake": 7.0}},
    ]
    daily_metrics = [
        {**row, "date": f"2026-01-0{index + 1}"}
        for index, row in enumerate(variants)
    ]
    daily_rows = [
        {
            "date": row["date"], "rhr_dev": None, "hrv_dev": None,
            "ctl": 0.0, "atl": 0.0, "trimp_total": 0.0,
        }
        for row in daily_metrics
    ]
    frame = build_daily_insight_frame(daily_metrics, daily_rows, ZoneInfo("UTC"))

    assert frame.loc["2026-01-01", "sleep_duration"] == pytest.approx(420.0)
    for day in ("2026-01-02", "2026-01-03", "2026-01-04"):
        assert frame.loc[day, [
            "sleep_duration", "sleep_midpoint", "sleep_awake_fraction",
            "wake_hour", "wake_at_epoch",
        ]].isna().all()


def test_circular_sleep_deviation_treats_midnight_neighbors_as_close():
    from metrics.insights import prior_rolling_circular_deviation

    dates = pd.date_range("2026-01-01", periods=15, freq="D")
    values = [23.5 if i % 2 == 0 else 0.5 for i in range(14)] + [1.5]
    deviations = prior_rolling_circular_deviation(
        pd.Series(values, index=dates), days=28, min_periods=14
    )

    assert deviations.iloc[-1] == pytest.approx(1.5, abs=0.05)
    assert deviations.iloc[:-1].isna().sum() == 14


def test_daily_insight_frame_uses_scale_free_prior_week_training_density():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_daily_insight_frame

    dates = pd.date_range("2026-01-01", periods=16, freq="D")
    durations_by_date = {
        day.date(): duration
        for day, duration in zip(
            dates,
            [10.0, 0.0, 10.0, 0.0, 10.0, 0.0, 10.0, *([0.0] * 9)],
        )
    }
    daily_rows = [
        {
            "date": day.date().isoformat(),
            "rhr_dev": None,
            "hrv_dev": None,
            "ctl": 0.0,
            "atl": 0.0,
            "trimp_total": 0.0,
        }
        for day in dates
    ]

    frame = build_daily_insight_frame(
        [], daily_rows, ZoneInfo("UTC"), durations_by_date
    )

    # Jan 8 sees Jan 1–7 only: four equal-duration days = four effective days.
    assert frame.loc["2026-01-08", "duration_7d_prior"] == pytest.approx(40.0)
    assert frame.loc["2026-01-08", "training_density_7d_prior"] == pytest.approx(4.0)
    assert frame.loc[:"2026-01-07", "training_density_7d_prior"].isna().all()
    # A complete all-rest prior week has no training-time distribution to estimate.
    assert pd.isna(frame.loc["2026-01-16", "training_density_7d_prior"])

    scaled_durations = {
        day: duration * 3.0 for day, duration in durations_by_date.items()
    }
    scaled_frame = build_daily_insight_frame(
        [], daily_rows, ZoneInfo("UTC"), scaled_durations
    )
    assert scaled_frame.loc["2026-01-08", "training_density_7d_prior"] == pytest.approx(4.0)


def test_daily_insight_frame_exposes_only_previous_day_finalized_hr_aggregates():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_daily_insight_frame

    daily_rows = [
        {"date": "2026-01-01", "rhr_dev": 1.0, "hrv_dev": -2.0, "ctl": 5.0, "atl": 6.0, "trimp_total": 0.0},
        {"date": "2026-01-02", "rhr_dev": 3.0, "hrv_dev": -4.0, "ctl": 5.0, "atl": 6.0, "trimp_total": 0.0},
        {"date": "2026-01-03", "rhr_dev": 5.0, "hrv_dev": -6.0, "ctl": 5.0, "atl": 6.0, "trimp_total": 0.0},
    ]
    daily_metrics = [
        {"date": row["date"], "resting_hr": 50.0, "hrv_sdnn_ms": 60.0}
        for row in daily_rows
    ]

    frame = build_daily_insight_frame(daily_metrics, daily_rows, ZoneInfo("UTC"))

    assert pd.isna(frame.loc["2026-01-01", "rhr_dev_prior"])
    assert pd.isna(frame.loc["2026-01-01", "hrv_dev_prior"])
    assert frame.loc["2026-01-02", "rhr_dev_prior"] == pytest.approx(1.0)
    assert frame.loc["2026-01-02", "hrv_dev_prior"] == pytest.approx(-2.0)
    assert frame.loc["2026-01-03", "rhr_dev_prior"] == pytest.approx(3.0)
    assert frame.loc["2026-01-03", "hrv_dev_prior"] == pytest.approx(-4.0)


def test_workout_insight_frame_keeps_duration_when_load_is_unmeasured_and_derives_context():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_workout_insight_frame

    index = pd.date_range("2026-01-01", periods=3, freq="D")
    daily = pd.DataFrame(
        {
            "ctl_prior": [10.0, 11.0, 12.0],
            "atl_prior": [13.0, 14.0, 15.0],
            "trimp_prior": [1.0, 2.0, 3.0],
            "wake_hour": [8.0, 8.0, 8.0],
            "sleep_shortfall": [0.0, 30.0, -20.0],
            "rhr_dev": [99.0, 99.0, 99.0],
            "hrv_dev": [99.0, 99.0, 99.0],
            "rhr_dev_prior": [1.0, 2.0, 3.0],
            "hrv_dev_prior": [-1.0, -2.0, -3.0],
        },
        index=index,
    )
    workouts = [
        {
            "id": "valid", "type": "indoor_cycling",
            "start_at": "2026-01-02T23:30:00Z", "duration_s": 1200,
        },
        {
            "id": "no-load", "type": "rowing",
            "start_at": "2026-01-03T08:00:00Z", "duration_s": 1800,
            "raw": {"intensity": {"qty": 7.5, "units": "kcal/hr·kg"}},
        },
    ]
    computed = {
        "valid": {
            "trimp": 30.0,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 300, "z4": 200, "z5": 100},
        },
        "no-load": {
            "trimp": 0.0,
            "time_in_zones": {"z1": 1800, "z2": 0, "z3": 0, "z4": 0, "z5": 0},
        },
    }

    frame = build_workout_insight_frame(workouts, computed, daily, ZoneInfo("UTC"))

    assert len(frame) == 2
    row = frame.iloc[0]
    assert row["start_hour"] == pytest.approx(23.5)
    assert row["workout_load"] == pytest.approx(30.0)
    assert row["workout_intensity"] == pytest.approx(1.5)
    assert row["high_zone_fraction"] == pytest.approx(0.25)
    assert row["sleep_shortfall"] == pytest.approx(30.0)
    assert row["rhr_dev_prior"] == pytest.approx(2.0)
    assert row["hrv_dev_prior"] == pytest.approx(-2.0)
    assert "rhr_dev" not in frame
    assert "hrv_dev" not in frame
    assert row["modality"] == "cycling"
    no_load = frame.iloc[1]
    assert no_load["workout_duration"] == pytest.approx(30.0)
    assert pd.isna(no_load["workout_load"])
    assert pd.isna(no_load["workout_intensity"])
    assert pd.isna(no_load["high_zone_fraction"])
    assert no_load["energy_intensity"] == pytest.approx(7.5)


def test_workout_energy_intensity_accepts_only_plausible_supported_units():
    from metrics.compute import workout_energy_intensity

    assert workout_energy_intensity(
        {"intensity": {"qty": 7.25, "units": "kcal/hr·kg"}}
    ) == pytest.approx(7.25)
    assert workout_energy_intensity(
        {"intensity": {"qty": 8.0, "units": "MET"}}
    ) == pytest.approx(8.0)
    assert workout_energy_intensity(
        {"intensity": {"qty": 8.0, "units": "kcal"}}
    ) is None
    assert workout_energy_intensity(
        {"intensity": {"qty": 30.0, "units": "MET"}}
    ) is None
    assert workout_energy_intensity({}) is None


def test_workout_recorded_start_prefers_only_a_verified_payload_offset():
    from zoneinfo import ZoneInfo

    from metrics.compute import workout_recorded_start

    tz = ZoneInfo("Europe/Berlin")
    workout = {
        "start_at": "2026-06-10T10:00:00Z",
        "raw": {"start": "2026-06-10 11:00:00 +0100"},
    }
    recorded = workout_recorded_start(workout, tz)
    assert (recorded.date(), recorded.hour) == (date(2026, 6, 10), 11)

    mismatched = {
        **workout,
        "raw": {"start": "2026-06-10 11:00:00 +0200"},
    }
    fallback = workout_recorded_start(mismatched, tz)
    assert (fallback.date(), fallback.hour) == (date(2026, 6, 10), 12)


def test_workout_duration_distribution_needs_no_hr_and_uses_recorded_date():
    from zoneinfo import ZoneInfo

    from metrics.compute import workout_duration_by_date

    workouts = [
        {
            "id": "travel-no-hr",
            "start_at": "2026-06-10T22:30:00Z",
            "duration_s": 1800,
            "raw": {"start": "2026-06-10 23:30:00 +0100"},
        },
        {
            "id": "same-day-no-hr",
            "start_at": "2026-06-10T18:00:00Z",
            "duration_s": 1200,
        },
        {
            "id": "invalid-duration",
            "start_at": "2026-06-11T08:00:00Z",
            "duration_s": None,
        },
    ]

    totals = workout_duration_by_date(workouts, ZoneInfo("Europe/Berlin"))

    assert totals == {date(2026, 6, 10): pytest.approx(50.0)}


def test_workout_frame_controls_prior_28_day_duration_in_same_modality():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_workout_insight_frame

    workouts = [
        {
            "id": "old-row", "type": "rowing", "start_at": "2026-01-01T08:00:00Z",
            "duration_s": 3600,
        },
        {
            "id": "other-sport", "type": "indoor_cycling",
            "start_at": "2026-01-10T07:00:00Z", "duration_s": 1200,
        },
        {
            "id": "recent-row", "type": "rowing", "start_at": "2026-01-10T08:00:00Z",
            "duration_s": 1800,
        },
        {
            "id": "current-row", "type": "rowing", "start_at": "2026-01-30T08:00:00Z",
            "duration_s": 2400,
        },
    ]

    frame = build_workout_insight_frame(workouts, {}, pd.DataFrame(), ZoneInfo("UTC"))

    assert frame["modality_duration_28d_prior"].tolist() == pytest.approx(
        [0.0, 0.0, 60.0, 30.0]
    )
    assert frame["log_modality_duration_28d_prior"].tolist() == pytest.approx(
        np.log1p([0.0, 0.0, 60.0, 30.0])
    )


def test_workout_hr_outcomes_require_coverage_and_use_measured_time():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_workout_insight_frame

    workouts = [
        {
            "id": "quality-first", "type": "rowing",
            "start_at": "2026-01-02T08:00:00Z", "duration_s": 1200,
        },
        {
            "id": "low-coverage-history", "type": "rowing",
            "start_at": "2026-01-02T10:00:00Z", "duration_s": 1200,
        },
        {
            "id": "quality-second", "type": "rowing",
            "start_at": "2026-01-02T12:00:00Z", "duration_s": 1200,
        },
        {
            "id": "over-covered", "type": "rowing",
            "start_at": "2026-01-02T14:00:00Z", "duration_s": 1200,
        },
    ]
    computed = {
        # Exactly 90% coverage: mean measured zone weight is 1.5, whereas
        # dividing by wall-clock duration would incorrectly report 1.35.
        "quality-first": {
            "trimp": 27.0,
            "time_in_zones": {"z1": 540, "z2": 540, "z3": 0, "z4": 0, "z5": 0},
        },
        "low-coverage-history": {
            "trimp": 15.0,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 0, "z4": 0, "z5": 0},
        },
        "quality-second": {
            "trimp": 30.0,
            "time_in_zones": {"z1": 600, "z2": 600, "z3": 0, "z4": 0, "z5": 0},
        },
        "over-covered": {
            "trimp": 33.0,
            "time_in_zones": {"z1": 660, "z2": 660, "z3": 0, "z4": 0, "z5": 0},
        },
    }

    frame = build_workout_insight_frame(
        workouts, computed, pd.DataFrame(), ZoneInfo("UTC")
    )

    assert len(frame) == 4
    first, low_coverage, second, over_covered = (frame.iloc[i] for i in range(4))
    assert first["hr_coverage_fraction"] == pytest.approx(0.9)
    assert first["workout_intensity"] == pytest.approx(1.5)
    assert low_coverage["hr_coverage_fraction"] == pytest.approx(0.5)
    assert low_coverage["workout_duration"] == pytest.approx(20.0)
    assert pd.isna(low_coverage["workout_load"])
    assert pd.isna(low_coverage["workout_intensity"])
    assert pd.isna(low_coverage["high_zone_fraction"])
    # The low-quality workout still exists for chronology and measured
    # same-day dose, but cannot replace the previous valid outcome control.
    assert second["hours_since_prev_workout"] == pytest.approx(2.0)
    assert second["same_day_prior_load"] == pytest.approx(42.0)
    assert second["same_day_prior_duration"] == pytest.approx(40.0)
    assert second["log_same_day_prior_duration"] == pytest.approx(np.log1p(40.0))
    assert second["load_prev_modality"] == pytest.approx(27.0)
    assert second["intensity_prev_modality"] == pytest.approx(1.5)
    assert over_covered["hr_coverage_fraction"] == pytest.approx(1.1)
    assert pd.isna(over_covered["workout_load"])
    assert pd.isna(over_covered["workout_intensity"])


def test_workout_insight_frame_controls_prior_session_and_hours_awake():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_workout_insight_frame

    daily = pd.DataFrame(
        {
            "wake_hour": [8.0], "ctl_prior": [10.0], "trimp_prior": [5.0],
            "high_zone_fraction_prior": [0.25],
            "duration_7d_prior": [150.0], "training_density_7d_prior": [3.5],
        },
        index=pd.to_datetime(["2026-01-02"]),
    )
    workouts = [
        {"id": "first", "type": "rowing", "start_at": "2026-01-02T10:00:00Z", "duration_s": 1200},
        {"id": "second", "type": "rowing", "start_at": "2026-01-02T18:00:00Z", "duration_s": 1800},
    ]
    computed = {
        workout_id: {
            "trimp": trimp,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 300, "z4": 200, "z5": 100},
        }
        for workout_id, trimp in (("first", 20.0), ("second", 30.0))
    }

    frame = build_workout_insight_frame(workouts, computed, daily, ZoneInfo("UTC"))
    second = frame.iloc[1]

    assert second["hours_since_wake"] == pytest.approx(10.0)
    assert second["hours_since_prev_workout"] == pytest.approx(8.0)
    assert second["days_since_prev_modality"] == pytest.approx(8.0 / 24.0)
    assert second["same_day_prior_load"] == pytest.approx(20.0)
    assert second["same_day_prior_duration"] == pytest.approx(20.0)
    assert second["log_same_day_prior_duration"] == pytest.approx(np.log1p(20.0))
    assert second["load_prev_modality"] == pytest.approx(20.0)
    assert second["high_zone_fraction_prior"] == pytest.approx(0.25)
    assert second["duration_7d_prior"] == pytest.approx(150.0)
    assert second["training_density_7d_prior"] == pytest.approx(3.5)


def test_daily_high_zone_fraction_requires_complete_hr_coverage_for_every_session():
    from zoneinfo import ZoneInfo

    from metrics.compute import daily_high_zone_fraction

    workouts = [
        {"id": "quality", "start_at": "2026-01-01T08:00:00Z", "duration_s": 1200},
        {"id": "mixed-quality", "start_at": "2026-01-02T08:00:00Z", "duration_s": 1200},
        {"id": "mixed-poor", "start_at": "2026-01-02T12:00:00Z", "duration_s": 1200},
    ]
    computed = {
        "quality": {
            "trimp": 30.0,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 300, "z4": 200, "z5": 100},
        },
        "mixed-quality": {
            "trimp": 30.0,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 300, "z4": 200, "z5": 100},
        },
        "mixed-poor": {
            "trimp": 15.0,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 0, "z4": 0, "z5": 0},
        },
    }

    by_day = daily_high_zone_fraction(workouts, computed, ZoneInfo("UTC"))

    assert by_day == {date(2026, 1, 1): pytest.approx(0.25)}


def test_workout_frame_short_sessions_keep_duration_but_not_hr_outcomes():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_workout_insight_frame

    workouts = [
        {
            "id": "eligible-first",
            "type": "rowing",
            "start_at": "2026-01-01T08:00:00Z",
            "duration_s": 1200,
        },
        {
            "id": "short-history-only",
            "type": "rowing",
            "start_at": "2026-01-02T10:00:00Z",
            "duration_s": 240,
        },
        {
            "id": "eligible-second",
            "type": "rowing",
            "start_at": "2026-01-02T12:00:00Z",
            "duration_s": 1200,
        },
    ]
    computed = {
        "eligible-first": {
            "trimp": 20.0,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 300, "z4": 200, "z5": 100},
        },
        "short-history-only": {
            "trimp": 5.0,
            "time_in_zones": {"z1": 175, "z2": 65, "z3": 0, "z4": 0, "z5": 0},
        },
        "eligible-second": {
            "trimp": 30.0,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 300, "z4": 200, "z5": 100},
        },
    }

    frame = build_workout_insight_frame(
        workouts, computed, pd.DataFrame(), ZoneInfo("UTC")
    )

    assert len(frame) == 3
    short = frame.iloc[1]
    second = frame.iloc[2]
    assert short["workout_duration"] == pytest.approx(4.0)
    assert pd.isna(short["workout_load"])
    assert pd.isna(short["workout_intensity"])
    assert second["hours_since_prev_workout"] == pytest.approx(2.0)
    assert second["days_since_prev_modality"] == pytest.approx(2.0 / 24.0)
    assert second["same_day_prior_load"] == pytest.approx(5.0)
    # HR-derived histories stay on HR-eligible rows, while duration uses the
    # four-minute session because duration does not depend on HR measurement.
    assert second["load_prev_modality"] == pytest.approx(20.0)
    assert second["duration_prev_modality"] == pytest.approx(4.0)


def test_workout_frame_never_attaches_sleep_that_ends_after_the_workout():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_workout_insight_frame

    daily = pd.DataFrame(
        {
            "wake_hour": [8.0],
            "sleep_shortfall": [30.0],
            "sleep_shortfall_3d": [20.0],
            "sleep_midpoint_dev": [1.0],
            "sleep_awake_fraction": [0.1],
            "respiratory_rate_dev": [0.5],
            "rhr_dev_prior": [2.0],
            "hrv_dev_prior": [-3.0],
            "ctl_prior": [10.0],
            "atl_prior": [12.0],
            "trimp_prior": [5.0],
        },
        index=pd.to_datetime(["2026-01-02"]),
    )
    workouts = [
        {
            "id": "before-wake",
            "type": "rowing",
            "start_at": "2026-01-02T04:00:00Z",
            "duration_s": 1200,
        }
    ]
    computed = {
        "before-wake": {
            "trimp": 20.0,
            "time_in_zones": {"z1": 300, "z2": 300, "z3": 300, "z4": 200, "z5": 100},
        }
    }

    row = build_workout_insight_frame(
        workouts, computed, daily, ZoneInfo("UTC")
    ).iloc[0]

    assert pd.isna(row["hours_since_wake"])
    for column in (
        "sleep_shortfall",
        "sleep_shortfall_3d",
        "sleep_midpoint_dev",
        "sleep_awake_fraction",
        "respiratory_rate_dev",
    ):
        assert pd.isna(row[column])
    assert row["rhr_dev_prior"] == pytest.approx(2.0)
    assert row["hrv_dev_prior"] == pytest.approx(-3.0)
    assert row["atl_prior"] == pytest.approx(12.0)


def test_workout_frame_uses_recorded_clock_but_instant_elapsed_since_wake():
    from zoneinfo import ZoneInfo

    from metrics.compute import build_workout_insight_frame

    daily = pd.DataFrame(
        {
            # Wake was 08:00 at the travel destination / 09:00 in configured Berlin time.
            "wake_hour": [9.0],
            "wake_at_epoch": [pd.Timestamp("2026-06-10T07:00:00Z").timestamp()],
        },
        index=pd.to_datetime(["2026-06-10"]),
    )
    workouts = [{
        "id": "travel", "type": "outdoor_run",
        "start_at": "2026-06-10T10:30:00Z", "duration_s": 1200,
        "raw": {"start": "2026-06-10 11:30:00 +0100"},
    }]
    computed = {"travel": {
        "trimp": 30.0,
        "time_in_zones": {"z1": 300, "z2": 300, "z3": 300, "z4": 200, "z5": 100},
    }}

    row = build_workout_insight_frame(
        workouts, computed, daily, ZoneInfo("Europe/Berlin")
    ).iloc[0]

    assert row["start_hour"] == pytest.approx(11.5)
    assert row["hours_since_wake"] == pytest.approx(3.5)
    assert row.name == pd.Timestamp("2026-06-10T11:30:00")


def test_nightly_insights_retires_legacy_ef_model(monkeypatch):
    from zoneinfo import ZoneInfo

    from metrics import compute

    written_models = []
    deleted_models = []
    expected_versions = []
    monkeypatch.setattr(compute.db, "fetch_computed_workouts", lambda _sb: [])
    monkeypatch.setattr(compute.db, "replace_insight_correlations", lambda _sb, _rows: None)
    monkeypatch.setattr(compute.db, "fetch_insight_model", lambda _sb, _name: None)
    monkeypatch.setattr(compute.db, "upsert_insight_model", lambda _sb, row: written_models.append(row))
    monkeypatch.setattr(compute.db, "delete_insight_model", lambda _sb, name: deleted_models.append(name))
    monkeypatch.setattr(
        compute,
        "insight_prior_state",
        lambda _prior, expected_version: expected_versions.append(expected_version),
    )

    compute.run_insights(
        object(),
        all_workouts=[],
        daily_metrics=[],
        daily_rows=[
            {
                "date": "2026-08-01",
                "rhr_dev": 0.0,
                "hrv_dev": 0.0,
                "ctl": 0.0,
                "atl": 0.0,
                "trimp_total": 0.0,
            }
        ],
        tz=ZoneInfo("UTC"),
    )

    assert [model["name"] for model in written_models] == [
        "daily_adjusted_finder",
        "workout_context_finder",
    ]
    assert deleted_models == ["ef_on_sleep_dlm"]
    assert expected_versions == [9, 15]


def test_persistence_state_never_crosses_model_versions():
    from metrics.compute import insight_prior_state

    prior = {
        "diagnostics": {
            "model_version": 1,
            "persistence": {"state": {"candidate": {"streak": 7}}},
        }
    }

    assert insight_prior_state(prior, expected_version=1) == {"candidate": {"streak": 7}}
    assert insight_prior_state(prior, expected_version=2) is None
    assert insight_prior_state(None, expected_version=1) is None


def test_sleep_midpoint_uses_actual_instant_on_local_clock_across_dst():
    from zoneinfo import ZoneInfo

    from metrics.compute import sleep_midpoint_hours

    # 23:00 CET → 07:00 CEST is seven elapsed hours. Its actual midpoint is
    # 03:30 CEST, not 03:00 (the midpoint of the two wall-clock labels).
    row = {
        "sleep_start": "2026-03-28T22:00:00Z",
        "sleep_end": "2026-03-29T05:00:00Z",
    }
    assert sleep_midpoint_hours(row, ZoneInfo("Europe/Berlin")) == pytest.approx(3.5)


def test_sleep_clock_uses_recorded_offset_when_travelling():
    from zoneinfo import ZoneInfo

    from metrics.compute import sleep_midpoint_hours, wake_clock_hours

    row = {
        "date": "2026-06-08",
        "sleep_start": "2026-06-08T00:00:00Z",
        "sleep_end": "2026-06-08T08:00:00Z",
        "sleep_stages": {"_sleep_end_timezone_offset_min": 60},
    }

    # The travel destination was UTC+1 while the configured home zone (Berlin) was UTC+2.
    assert sleep_midpoint_hours(row, ZoneInfo("Europe/Berlin")) == pytest.approx(5.0)
    assert wake_clock_hours(row, ZoneInfo("Europe/Berlin")) == pytest.approx(9.0)


def test_sleep_clock_keeps_configured_zone_when_recorded_offset_matches_wake():
    from zoneinfo import ZoneInfo

    from metrics.compute import sleep_midpoint_hours

    row = {
        "date": "2026-03-29",
        "sleep_start": "2026-03-28T22:00:00Z",
        "sleep_end": "2026-03-29T05:00:00Z",
        "sleep_stages": {"_sleep_end_timezone_offset_min": 120},
    }

    # Matching the configured wake offset preserves IANA-zone DST arithmetic.
    assert sleep_midpoint_hours(row, ZoneInfo("Europe/Berlin")) == pytest.approx(3.5)


def test_wake_hour_preserves_day_offset_from_daily_row():
    from zoneinfo import ZoneInfo

    from metrics.compute import wake_clock_hours

    row = {
        "date": "2026-01-02",
        "sleep_end": "2026-01-03T08:00:00Z",
    }
    assert wake_clock_hours(row, ZoneInfo("UTC")) == pytest.approx(32.0)
