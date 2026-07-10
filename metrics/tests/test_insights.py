"""Insights layer tests (SPEC §5.4): correlations with lags + the EF
distributed-lag model."""

import numpy as np
import pandas as pd
import pytest

from metrics.insights import compute_correlations, ef_dlm, zscore_trailing

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
