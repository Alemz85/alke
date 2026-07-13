"""Insights layer tests (SPEC §5.4): correlations with lags + the EF
distributed-lag model."""

import numpy as np
import pandas as pd
import pytest

from metrics.insights import (
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


def test_adjusted_finder_recovers_stable_signal_and_drops_collinear_control():
    n = 240
    dates = pd.date_range("2025-01-01", periods=n, freq="D")
    rng = np.random.default_rng(85)
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

    model = discover_adjusted_insights(frame, specs=specs, min_n=60)
    candidate = model["diagnostics"]["candidates"][0]
    assert candidate["status"] == "signal"
    assert candidate["partial_r"] > 0.4
    assert candidate["q_value"] < 0.1
    assert candidate["stable"] is True
    assert "confound_copy" in candidate["dropped_controls"]


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
    model = discover_adjusted_insights(frame, specs=specs, min_n=60)
    assert model["diagnostics"]["candidates"][0]["status"] == "no_clear_signal"


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


def test_perfs_constant_includes_weight_slope():
    from metrics.insights import PERFS

    assert "weight_7d_slope" in PERFS


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
