"""Exploratory + confirmatory insights (SPEC §5.4). Pure functions over a
daily analysis frame; compute.py builds the frame and writes the results."""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy.stats import pearsonr

MIN_CORR_N = 20
MIN_DLM_N = 40

DRIVERS = ["sleep_duration", "sleep_midpoint_dev", "rhr_dev", "hrv_dev", "trimp_prior"]
PERFS = ["ef", "decoupling", "hrr60", "trimp_total"]


def zscore_trailing(frame: pd.DataFrame, days: int = 180) -> pd.DataFrame:
    """Restrict to the trailing `days` rows by date and z-score each column
    within-person over that window. Zero-variance columns become NaN."""
    window = frame.loc[frame.index >= frame.index.max() - pd.Timedelta(days=days - 1)]
    sd = window.std(ddof=0)
    return (window - window.mean()) / sd.replace(0, np.nan)


def compute_correlations(
    frame: pd.DataFrame,
    drivers: list[str] | None = None,
    perfs: list[str] | None = None,
    max_lag: int = 3,
) -> list[dict]:
    """Pearson r for each (driver at t−lag, perf at t) pair with n and p.
    Pairs with n < 20 are skipped. Overwrites the table each nightly run."""
    computed_at = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []
    for x in drivers if drivers is not None else DRIVERS:
        if x not in frame.columns:
            continue
        for y in perfs if perfs is not None else PERFS:
            if y not in frame.columns or x == y:
                continue
            for lag in range(0, max_lag + 1):
                paired = pd.DataFrame({"x": frame[x].shift(lag), "y": frame[y]}).dropna()
                if len(paired) < MIN_CORR_N or paired["x"].std() == 0 or paired["y"].std() == 0:
                    continue
                r, p = pearsonr(paired["x"], paired["y"])
                rows.append(
                    {
                        "computed_at": computed_at,
                        "var_x": x,
                        "var_y": y,
                        "lag_days": lag,
                        "r": round(float(r), 4),
                        "n": int(len(paired)),
                        "p_value": float(p),
                    }
                )
    return rows


def ef_dlm(frame: pd.DataFrame) -> dict | None:
    """OLS: EF_t ~ sleep_{t−1} + sleep_7d_mean + rhr_dev_t + CTL_t + ATL_t with
    HC3 robust SEs. Runs only at ≥40 EF observations; returns an insight_models
    row for `ef_on_sleep_dlm`."""
    df = pd.DataFrame(
        {
            "ef": frame.get("ef"),
            "sleep_prev": frame.get("sleep_duration").shift(1) if "sleep_duration" in frame else np.nan,
            "sleep_7d_mean": (
                frame.get("sleep_duration").rolling(7, min_periods=4).mean()
                if "sleep_duration" in frame
                else np.nan
            ),
            "rhr_dev": frame.get("rhr_dev"),
            "ctl": frame.get("ctl"),
            "atl": frame.get("atl"),
        }
    ).dropna()
    if len(df) < MIN_DLM_N:
        return None

    X = sm.add_constant(df[["sleep_prev", "sleep_7d_mean", "rhr_dev", "ctl", "atl"]])
    fit = sm.OLS(df["ef"], X).fit(cov_type="HC3")
    ci = fit.conf_int(alpha=0.05)
    coefficients = {
        name: {
            "coef": float(fit.params[name]),
            "ci_low": float(ci.loc[name, 0]),
            "ci_high": float(ci.loc[name, 1]),
            "p_value": float(fit.pvalues[name]),
        }
        for name in fit.params.index
    }
    n = int(len(df))
    return {
        "name": "ef_on_sleep_dlm",
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "spec": "OLS: EF_t ~ sleep_{t-1} + sleep_7d_mean + rhr_dev_t + CTL_t + ATL_t (HC3 robust SEs)",
        "coefficients": coefficients,
        "diagnostics": {
            "n": n,
            "r2": float(fit.rsquared),
            "caveat": (
                f"Exploratory model on n={n} swim-day observations from a single person — "
                "coefficients describe associations, not causes, and will shift as data accumulates."
            ),
        },
    }
