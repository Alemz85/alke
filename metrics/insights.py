"""Exploratory + confirmatory insights (SPEC §5.4). Pure functions over a
daily analysis frame; compute.py builds the frame and writes the results."""

from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy.stats import pearsonr, t as student_t

MIN_CORR_N = 20
MIN_DLM_N = 40
MIN_ADJUSTED_N = 60

DRIVERS = ["sleep_duration", "sleep_midpoint_dev", "rhr_dev", "hrv_dev", "trimp_prior", "steps_prior"]
PERFS = ["ef", "decoupling", "hrr60", "trimp_total", "weight_7d_slope"]

WEIGHT_FFILL_LIMIT_DAYS = 3
WEIGHT_ROLLING_WINDOW_DAYS = 7
WEIGHT_ROLLING_MIN_PERIODS = 4

DEFAULT_ADJUSTED_SPECS = [
    {"name": "prior_load_to_sleep", "label": "Prior-day load → sleep duration", "driver": "trimp_prior", "outcome": "sleep_duration", "controls": ["lag:sleep_duration", "ctl"], "direction": "lagged"},
    {"name": "prior_load_to_rhr", "label": "Prior-day load → RHR deviation", "driver": "trimp_prior", "outcome": "rhr_dev", "controls": ["lag:rhr_dev", "ctl"], "direction": "lagged"},
    {"name": "prior_load_to_hrv", "label": "Prior-day load → HRV deviation", "driver": "trimp_prior", "outcome": "hrv_dev", "controls": ["lag:hrv_dev", "ctl"], "direction": "lagged"},
    {"name": "sleep_to_rhr", "label": "Sleep duration ↔ RHR deviation", "driver": "sleep_duration", "outcome": "rhr_dev", "controls": ["lag:rhr_dev", "atl"], "direction": "co-measured"},
    {"name": "sleep_to_hrv", "label": "Sleep duration ↔ HRV deviation", "driver": "sleep_duration", "outcome": "hrv_dev", "controls": ["lag:hrv_dev", "atl"], "direction": "co-measured"},
    {"name": "timing_to_sleep", "label": "Sleep timing drift ↔ duration", "driver": "sleep_midpoint_dev", "outcome": "sleep_duration", "controls": ["lag:sleep_duration"], "direction": "co-measured"},
    {"name": "timing_to_rhr", "label": "Sleep timing drift ↔ RHR deviation", "driver": "sleep_midpoint_dev", "outcome": "rhr_dev", "controls": ["lag:rhr_dev", "atl"], "direction": "co-measured"},
    {"name": "timing_to_hrv", "label": "Sleep timing drift ↔ HRV deviation", "driver": "sleep_midpoint_dev", "outcome": "hrv_dev", "controls": ["lag:hrv_dev", "atl"], "direction": "co-measured"},
    {"name": "rhr_to_load", "label": "RHR deviation → same-day load", "driver": "rhr_dev", "outcome": "trimp_total", "controls": ["lag:trimp_total", "ctl"], "direction": "training-choice"},
    {"name": "hrv_to_load", "label": "HRV deviation → same-day load", "driver": "hrv_dev", "outcome": "trimp_total", "controls": ["lag:trimp_total", "ctl"], "direction": "training-choice"},
    # Performance candidates stay dormant until enough swim EF observations
    # accumulate. EF is swim-only in compute.py, avoiding cross-modality units.
    {"name": "sleep_prev_to_ef", "label": "Previous-night sleep → swim efficiency", "driver": "sleep_duration", "driver_lag": 1, "outcome": "ef", "controls": ["ctl", "atl"], "direction": "lagged"},
    {"name": "timing_to_ef", "label": "Sleep timing drift → swim efficiency", "driver": "sleep_midpoint_dev", "outcome": "ef", "controls": ["ctl", "atl"], "direction": "sleep-before-workout"},
    {"name": "rhr_to_ef", "label": "RHR deviation → swim efficiency", "driver": "rhr_dev", "outcome": "ef", "controls": ["ctl", "atl"], "direction": "pre-workout-marker"},
    {"name": "hrv_to_ef", "label": "HRV deviation → swim efficiency", "driver": "hrv_dev", "outcome": "ef", "controls": ["ctl", "atl"], "direction": "pre-workout-marker"},
    {"name": "prior_load_to_ef", "label": "Prior-day load → swim efficiency", "driver": "trimp_prior", "outcome": "ef", "controls": ["ctl"], "direction": "lagged"},
]


def _zscore(series: pd.Series) -> pd.Series:
    sd = series.std(ddof=0)
    return (series - series.mean()) / sd if sd and np.isfinite(sd) else series * np.nan


def _drop_collinear_controls(df: pd.DataFrame, controls: list[str], threshold: float = 0.85) -> tuple[list[str], list[str]]:
    """Deterministically retain the first control in each correlated cluster."""
    kept: list[str] = []
    dropped: list[str] = []
    for control in controls:
        if any(abs(df[[control, prior]].corr().iloc[0, 1]) >= threshold for prior in kept):
            dropped.append(control)
        else:
            kept.append(control)
    return kept, dropped


def _partial_r(df: pd.DataFrame, controls: list[str]) -> float:
    if not controls:
        return float(pearsonr(df["x"], df["y"])[0])
    matrix = sm.add_constant(df[controls].astype(float), has_constant="add")
    x_resid = sm.OLS(df["x"], matrix).fit().resid
    y_resid = sm.OLS(df["y"], matrix).fit().resid
    return float(pearsonr(x_resid, y_resid)[0])


def discover_adjusted_insights(
    frame: pd.DataFrame,
    specs: list[dict] | None = None,
    min_n: int = MIN_ADJUSTED_N,
) -> dict:
    """Predeclared, confound-adjusted daily insight finder.

    It deliberately does not sweep arbitrary lags. Each candidate declares its
    temporal interpretation and controls before seeing results. Calendar trend
    and weekday are always adjusted; highly collinear controls are collapsed;
    HC3 robust intervals, BH false-discovery correction, and split-half sign
    stability gate promotion. This reduces common false positives but does not
    make single-person observational data causal.
    """
    candidate_specs = specs if specs is not None else DEFAULT_ADJUSTED_SPECS
    results: list[dict] = []

    for spec in candidate_specs:
        driver, outcome = spec["driver"], spec["outcome"]
        if driver not in frame or outcome not in frame:
            continue
        driver_lag = int(spec.get("driver_lag", 0))
        data = pd.DataFrame({"x": frame[driver].shift(driver_lag), "y": frame[outcome]}, index=frame.index)
        raw_controls: list[str] = []
        for control in spec.get("controls", []):
            if control.startswith("lag:"):
                source = control[4:]
                if source in frame:
                    name = f"{source}_prev"
                    data[name] = frame[source].shift(1)
                    raw_controls.append(name)
            elif control in frame:
                data[control] = frame[control]
                raw_controls.append(control)

        data["time_trend"] = np.arange(len(data), dtype=float)
        weekdays = pd.get_dummies(pd.DatetimeIndex(data.index).dayofweek, prefix="dow", drop_first=True, dtype=float)
        weekdays.index = data.index
        data = pd.concat([data, weekdays], axis=1).dropna()
        if len(data) < min_n or data["x"].std() == 0 or data["y"].std() == 0:
            results.append({"name": spec["name"], "label": spec["label"], "status": "insufficient", "n": int(len(data)), "required_n": min_n, "direction": spec.get("direction", "co-measured")})
            continue

        kept, dropped = _drop_collinear_controls(data, raw_controls)
        controls = kept + ["time_trend", *weekdays.columns.tolist()]
        partial = _partial_r(data, controls)
        X = sm.add_constant(pd.concat([_zscore(data["x"]).rename("x"), data[controls]], axis=1), has_constant="add")
        fit = sm.OLS(_zscore(data["y"]), X).fit(cov_type="HC3")
        ci = fit.conf_int().loc["x"]

        half_values: list[float] = []
        midpoint = len(data) // 2
        for half in (data.iloc[:midpoint], data.iloc[midpoint:]):
            if len(half) >= max(20, min_n // 3) and half["x"].std() > 0 and half["y"].std() > 0:
                half_values.append(_partial_r(half, controls))
        stable = len(half_values) == 2 and all(np.sign(value) == np.sign(partial) and abs(value) >= 0.05 for value in half_values)
        results.append({
            "name": spec["name"], "label": spec["label"], "driver": driver, "outcome": outcome,
            "direction": spec.get("direction", "co-measured"), "n": int(len(data)),
            "partial_r": float(partial), "beta": float(fit.params["x"]),
            "ci_low": float(ci.iloc[0]), "ci_high": float(ci.iloc[1]),
            "p_value": float(fit.pvalues["x"]), "stable": bool(stable),
            "half_r": [float(value) for value in half_values], "dropped_controls": dropped,
        })

    tested = [result for result in results if "p_value" in result]
    if tested:
        order = np.argsort([result["p_value"] for result in tested])
        running = 1.0
        for reverse_index in range(len(order) - 1, -1, -1):
            item_index = int(order[reverse_index])
            rank = reverse_index + 1
            running = min(running, tested[item_index]["p_value"] * len(tested) / rank)
            tested[item_index]["q_value"] = float(running)
        for result in tested:
            effect = abs(result["partial_r"])
            result["status"] = (
                "signal" if result["q_value"] <= 0.10 and effect >= 0.15 and result["stable"]
                else "watch" if result["q_value"] <= 0.20 and effect >= 0.15 and result["stable"]
                else "no_clear_signal"
            )

    # Avoid presenting two near-duplicate drivers for one outcome. Keep the
    # lower-q candidate and explicitly record which candidate suppressed the other.
    promoted = [r for r in tested if r["status"] in ("signal", "watch")]
    for i, left in enumerate(promoted):
        for right in promoted[i + 1:]:
            if left["outcome"] != right["outcome"] or left["driver"] not in frame or right["driver"] not in frame:
                continue
            corr = frame[[left["driver"], right["driver"]]].corr().iloc[0, 1]
            if np.isfinite(corr) and abs(corr) >= 0.75:
                keep, suppress = sorted((left, right), key=lambda item: item["q_value"])
                suppress["status"] = "suppressed_collinear"
                suppress["suppressed_by"] = keep["name"]

    coefficients = {
        result["name"]: {
            "coef": result["beta"], "ci_low": result["ci_low"],
            "ci_high": result["ci_high"], "p_value": result["p_value"],
        }
        for result in tested
    }
    return {
        "name": "daily_adjusted_finder",
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "spec": "Predeclared partial associations; weekday + time trend + candidate-specific prior-state/load controls; HC3 CI; BH FDR; split-half stability; collinear-driver suppression",
        "coefficients": coefficients,
        "diagnostics": {
            "n": max((result.get("n", 0) for result in results), default=0),
            "candidate_count": len(results),
            "signal_count": sum(result.get("status") == "signal" for result in results),
            "watch_count": sum(result.get("status") == "watch" for result in results),
            "candidates": results,
            "caveat": "Exploratory single-person associations, not causal effects. No result is promoted without multiplicity correction and split-half sign stability.",
        },
    }


def zscore_trailing(frame: pd.DataFrame, days: int = 180) -> pd.DataFrame:
    """Restrict to the trailing `days` rows by date and z-score each column
    within-person over that window. Zero-variance columns become NaN."""
    window = frame.loc[frame.index >= frame.index.max() - pd.Timedelta(days=days - 1)]
    sd = window.std(ddof=0)
    return (window - window.mean()) / sd.replace(0, np.nan)


def weight_series(raw: pd.Series | None) -> tuple[pd.Series | None, pd.Series | None]:
    """Build the two derived weight series for the analysis frame from a raw
    daily (possibly gappy, possibly string-typed) body-weight column.

    Returns `(weight, weight_7d_slope)`:
    - `weight`: raw daily weight, coerced to float, forward-filled up to
      `WEIGHT_FFILL_LIMIT_DAYS` days to bridge sparse weigh-ins. Gaps longer
      than the limit stay NaN rather than carrying a stale reading forward
      indefinitely.
    - `weight_7d_slope`: trend in kg/week — the 7-day rolling mean of the
      ffilled weight minus that same rolling mean 7 days prior. Weight is an
      OUTCOME (slow-moving), not a daily driver, so downstream correlation
      tests treat this slope as a PERF variable regressed against same/lagged
      drivers (sleep, rhr_dev, hrv_dev, trimp_prior).

    Returns `(None, None)` when `raw` is None (column absent from the source
    frame) so callers can skip attaching weight columns without special-casing.
    """
    if raw is None:
        return None, None

    weight = pd.to_numeric(raw, errors="coerce").ffill(limit=WEIGHT_FFILL_LIMIT_DAYS)
    rolling_mean = weight.rolling(WEIGHT_ROLLING_WINDOW_DAYS, min_periods=WEIGHT_ROLLING_MIN_PERIODS).mean()
    weight_7d_slope = rolling_mean - rolling_mean.shift(WEIGHT_ROLLING_WINDOW_DAYS)
    return weight, weight_7d_slope


def _lag1_autocorr(series: pd.Series) -> float:
    """Lag-1 autocorrelation of a series, clamped to (−1, 1). NaN/degenerate → 0
    (treat as iid, i.e. no effective-n penalty)."""
    s = pd.Series(series).astype(float).reset_index(drop=True)
    if len(s) < 3 or s.std(ddof=0) == 0:
        return 0.0
    r1 = s.autocorr(lag=1)
    if r1 is None or not np.isfinite(r1):
        return 0.0
    return float(max(-0.999, min(0.999, r1)))


def _effective_n(n: int, r1_x: float, r1_y: float) -> float:
    """Bartlett/Bayley-Hammersley effective sample size for a correlation between
    two AUTOCORRELATED series (F3): n_eff = n·(1 − r1_x·r1_y)/(1 + r1_x·r1_y).
    rhr_dev/hrv_dev/ctl/atl are rolling/EWMA series (lag-1 autocorr ~0.9), so the
    nominal n badly overstates independent information; this shrinks it. Clamped to
    [3, n] so a t-test always has ≥1 df and n_eff never exceeds the raw n."""
    prod = r1_x * r1_y
    factor = (1.0 - prod) / (1.0 + prod) if (1.0 + prod) > 1e-9 else 1.0
    return float(min(n, max(3.0, n * factor)))


def _p_from_r(r: float, n_eff: float) -> float:
    """Two-sided p-value for Pearson r under an EFFECTIVE sample size n_eff,
    via the t-statistic t = r·√((n_eff−2)/(1−r²)) on n_eff−2 df. Continuous in
    n_eff (fractional df is fine for the t-distribution)."""
    df = n_eff - 2.0
    if df <= 0 or abs(r) >= 1.0:
        return 0.0 if abs(r) >= 1.0 else 1.0
    t_stat = r * math.sqrt(df / (1.0 - r * r))
    return float(2.0 * student_t.sf(abs(t_stat), df))


def _bh_qvalues(pvals: list[float]) -> list[float]:
    """Benjamini-Hochberg q-values for a list of p-values, returned in the INPUT
    order (monotone-enforced, clamped to ≤1). Empty input → empty list."""
    m = len(pvals)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvals[i])
    q = [0.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        idx = order[rank - 1]
        running = min(running, pvals[idx] * m / rank)
        q[idx] = running
    return q


def compute_correlations(
    frame: pd.DataFrame,
    drivers: list[str] | None = None,
    perfs: list[str] | None = None,
    max_lag: int = 3,
) -> list[dict]:
    """Pearson r for each (driver at t−lag, perf at t) pair. Pairs with n < 20 are
    skipped. Overwrites the table each nightly run.

    F3 fix — these series are autocorrelated (rolling/EWMA; lag-1 ~0.9), so a
    pearsonr p-value computed on the nominal n is overconfident, and the ~100-pair
    sweep has no multiplicity control. Each pair's p is recomputed under an
    EFFECTIVE sample size n_eff = n·(1−r1·r2)/(1+r1·r2) (r1/r2 = the two series'
    lag-1 autocorrs), and a BH q_value is attached across the whole sweep.
    `p_value` is the corrected (n_eff) p; `p_value_naive` keeps the iid p for
    reference; `q_value` is the FDR-adjusted value the UI should prefer."""
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
                r, p_naive = pearsonr(paired["x"], paired["y"])
                n = int(len(paired))
                n_eff = _effective_n(n, _lag1_autocorr(paired["x"]), _lag1_autocorr(paired["y"]))
                p_corr = _p_from_r(float(r), n_eff)
                rows.append(
                    {
                        "computed_at": computed_at,
                        "var_x": x,
                        "var_y": y,
                        "lag_days": lag,
                        "r": round(float(r), 4),
                        "n": n,
                        "n_eff": round(n_eff, 1),
                        "p_value": p_corr,
                        "p_value_naive": float(p_naive),
                    }
                )
    for row, q in zip(rows, _bh_qvalues([row["p_value"] for row in rows])):
        row["q_value"] = float(q)
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
