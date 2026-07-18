"""Exploratory + confirmatory insights (SPEC §5.4). Pure functions over a
daily analysis frame; compute.py builds the frame and writes the results."""

from __future__ import annotations

import math
import zlib
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy.stats import pearsonr, spearmanr, t as student_t

MIN_CORR_N = 20
MIN_DLM_N = 40
MIN_ADJUSTED_N = 60

DRIVERS = ["sleep_duration", "sleep_midpoint_dev", "rhr_dev", "hrv_dev", "trimp_prior", "steps_prior"]
PERFS = ["ef", "decoupling", "hrr60", "trimp_total", "weight_7d_slope"]

# Pairs the exploratory sweep must skip: trimp_prior IS trimp_total shifted one
# day, so correlating the two only measures training-schedule autocorrelation.
EXCLUDED_SWEEP_PAIRS = {("trimp_prior", "trimp_total")}

# Adjusted-finder gates beyond raw n. All fixed [PRIOR]-style knobs, declared in
# code before seeing results (same pre-registration discipline as the specs).
MIN_ADJUSTED_N_EFF = 30.0  # min EFFECTIVE n of the control-residualized pair
BOOT_REPS = 200            # moving-block bootstrap replicates per candidate
BOOT_BLOCK_LEN = 14        # days per block — preserves within-block autocorrelation
BOOT_SIGN_AGREE = 0.80     # replicate sign-agreement required for "stable"
PROMOTE_AFTER = 7          # consecutive raw-signal nights before surfacing "signal"
DEMOTE_AFTER = 7           # consecutive raw-miss nights before a surfaced signal drops
PLACEBO_SHIFTS = (61, 91, 122)  # circular driver shifts for the null-calibration suite

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
    # NEAT / ambient activity: does yesterday's movement predict recovery and
    # sleep BEYOND training load? trimp_prior is a control so big-step days
    # don't merely proxy long workouts; lag:outcome absorbs autocorrelation.
    {"name": "steps_to_rhr", "label": "Prior-day steps → RHR deviation", "driver": "steps_prior", "outcome": "rhr_dev", "controls": ["lag:rhr_dev", "trimp_prior", "ctl"], "direction": "lagged"},
    {"name": "steps_to_hrv", "label": "Prior-day steps → HRV deviation", "driver": "steps_prior", "outcome": "hrv_dev", "controls": ["lag:hrv_dev", "trimp_prior", "ctl"], "direction": "lagged"},
    {"name": "steps_to_sleep", "label": "Prior-day steps → sleep duration", "driver": "steps_prior", "outcome": "sleep_duration", "controls": ["lag:sleep_duration", "trimp_prior"], "direction": "lagged"},
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


def _residualize(df: pd.DataFrame, controls: list[str]) -> tuple[pd.Series, pd.Series]:
    """x and y with the controls (plus intercept) regressed out."""
    matrix = sm.add_constant(df[controls].astype(float), has_constant="add")
    x_resid = sm.OLS(df["x"], matrix).fit().resid
    y_resid = sm.OLS(df["y"], matrix).fit().resid
    return x_resid, y_resid


def _partial_r(df: pd.DataFrame, controls: list[str]) -> float:
    if not controls:
        return float(pearsonr(df["x"], df["y"])[0])
    x_resid, y_resid = _residualize(df, controls)
    return float(pearsonr(x_resid, y_resid)[0])


def _nw_maxlags(n: int) -> int:
    """Newey-West rule-of-thumb truncation lag ⌊4·(n/100)^(2/9)⌋ for HAC errors."""
    return max(1, int(4.0 * (n / 100.0) ** (2.0 / 9.0)))


def _block_bootstrap_stability(
    data: pd.DataFrame,
    controls: list[str],
    point: float,
    seed_name: str,
    reps: int = BOOT_REPS,
    block_len: int = BOOT_BLOCK_LEN,
    agree_min: float = BOOT_SIGN_AGREE,
) -> dict:
    """Sign-stability of a partial correlation under a MOVING-BLOCK bootstrap.

    Replaces the old contiguous split-half gate, which was fragile to regime
    changes (a relocation or injury block sitting in one half could flip a real
    effect's sign there, or a shared drift could fake agreement). Resampling
    contiguous `block_len`-day blocks preserves the series' short-range
    autocorrelation, so the spread of replicate partial-r values is an honest
    picture of the estimate's instability. `stable` requires ≥ `agree_min` of
    valid replicates to match the point estimate's sign. Deterministic: the rng
    is seeded from the candidate name (crc32), so nightly reruns on the same
    data reproduce identical verdicts."""
    n = len(data)
    if n < 2 * block_len or point == 0 or not np.isfinite(point):
        return {"stable": False, "agree": 0.0, "n_valid": 0}
    rng = np.random.default_rng(zlib.crc32(seed_name.encode("utf-8")))
    n_blocks = int(math.ceil(n / block_len))
    values: list[float] = []
    for _ in range(reps):
        starts = rng.integers(0, n - block_len + 1, size=n_blocks)
        idx = np.concatenate([np.arange(s, s + block_len) for s in starts])[:n]
        sample = data.iloc[idx].reset_index(drop=True)
        if sample["x"].std(ddof=0) == 0 or sample["y"].std(ddof=0) == 0:
            continue
        try:
            value = _partial_r(sample, controls)
        except (ValueError, np.linalg.LinAlgError):
            continue
        if np.isfinite(value):
            values.append(value)
    if len(values) < reps // 2:
        return {"stable": False, "agree": 0.0, "n_valid": len(values)}
    agree = float(np.mean([np.sign(v) == np.sign(point) for v in values]))
    return {"stable": bool(agree >= agree_min), "agree": agree, "n_valid": len(values)}


def _evaluate_spec(
    frame: pd.DataFrame,
    spec: dict,
    min_n: int,
    boot_reps: int = BOOT_REPS,
    name: str | None = None,
) -> dict | None:
    """Run one predeclared candidate through the full gate chain and return its
    result row (without q-value/status, which need the whole pool). Returns None
    when the driver or outcome column is absent from the frame entirely."""
    driver, outcome = spec["driver"], spec["outcome"]
    if driver not in frame or outcome not in frame:
        return None
    name = name or spec["name"]
    driver_lag = int(spec.get("driver_lag", 0))
    data = pd.DataFrame({"x": frame[driver].shift(driver_lag), "y": frame[outcome]}, index=frame.index)
    raw_controls: list[str] = []
    for control in spec.get("controls", []):
        if control.startswith("lag:"):
            source = control[4:]
            if source in frame:
                cname = f"{source}_prev"
                data[cname] = frame[source].shift(1)
                raw_controls.append(cname)
        elif control in frame:
            data[control] = frame[control]
            raw_controls.append(control)

    data["time_trend"] = np.arange(len(data), dtype=float)
    weekdays = pd.get_dummies(pd.DatetimeIndex(data.index).dayofweek, prefix="dow", drop_first=True, dtype=float)
    weekdays.index = data.index
    data = pd.concat([data, weekdays], axis=1).dropna()
    base = {
        "name": name, "label": spec["label"], "driver": driver, "outcome": outcome,
        "direction": spec.get("direction", "co-measured"), "n": int(len(data)),
    }
    if len(data) < min_n or data["x"].std() == 0 or data["y"].std() == 0:
        return {**base, "raw_status": "insufficient", "reason": "raw_n", "required_n": min_n}

    kept, dropped = _drop_collinear_controls(data, raw_controls)
    controls = kept + ["time_trend", *weekdays.columns.tolist()]
    x_resid, y_resid = _residualize(data, controls)
    # Effective information AFTER the controls: with a lagged-outcome control the
    # residuals are near-iid and n_eff ≈ n; without one, smooth series can carry
    # far fewer independent days than rows, and the candidate must wait for data.
    n_eff = _effective_n(len(data), _lag1_autocorr(x_resid), _lag1_autocorr(y_resid))
    if n_eff < MIN_ADJUSTED_N_EFF:
        return {
            **base, "raw_status": "insufficient", "reason": "effective_n",
            "n_eff": round(float(n_eff), 1), "required_n_eff": MIN_ADJUSTED_N_EFF,
            "dropped_controls": dropped,
        }

    partial = float(pearsonr(x_resid, y_resid)[0])
    X = sm.add_constant(pd.concat([_zscore(data["x"]).rename("x"), data[controls]], axis=1), has_constant="add")
    fit = sm.OLS(_zscore(data["y"]), X).fit(cov_type="HAC", cov_kwds={"maxlags": _nw_maxlags(len(data))})
    ci = fit.conf_int().loc["x"]
    boot = _block_bootstrap_stability(data, controls, partial, name, reps=boot_reps)
    return {
        **base, "n_eff": round(float(n_eff), 1),
        "partial_r": partial, "beta": float(fit.params["x"]),
        "ci_low": float(ci.iloc[0]), "ci_high": float(ci.iloc[1]),
        "p_value": float(fit.pvalues["x"]), "stable": boot["stable"],
        "boot_sign_agree": round(boot["agree"], 3), "boot_n_valid": boot["n_valid"],
        "dropped_controls": dropped,
    }


def _assign_statuses(tested: list[dict]) -> None:
    """BH q-values across the pool, then the promotion gate chain → `raw_status`
    on each tested candidate (in place)."""
    for result, q in zip(tested, _bh_qvalues([r["p_value"] for r in tested])):
        result["q_value"] = float(q)
    for result in tested:
        effect = abs(result["partial_r"])
        result["raw_status"] = (
            "signal" if result["q_value"] <= 0.10 and effect >= 0.15 and result["stable"]
            else "watch" if result["q_value"] <= 0.20 and effect >= 0.15 and result["stable"]
            else "no_clear_signal"
        )


_MISS_STATUSES = ("no_clear_signal", "insufficient", "suppressed_collinear")


def apply_persistence(
    candidates: list[dict],
    prior_state: dict | None,
    promote_after: int = PROMOTE_AFTER,
    demote_after: int = DEMOTE_AFTER,
) -> dict:
    """Anti-flicker hysteresis: map each candidate's `raw_status` to the surfaced
    `status` (in place) and return the persistence state for the next run.

    Re-evaluating nightly on accruing data is sequential testing — a noisy
    candidate gets unlimited looks at the q threshold, so promoting on the first
    dip inflates the false-positive rate far past nominal (optional stopping).
    Promotion therefore requires `promote_after` CONSECUTIVE raw-signal nights;
    a raw signal still pending surfaces as "watch". Symmetrically, an already-
    surfaced signal survives transient misses and demotes only after
    `demote_after` consecutive raw misses (raw "watch" nights don't count as
    misses). State round-trips through insight_models.diagnostics.persistence."""
    carried = dict(prior_state or {})
    new_state: dict[str, dict] = {}
    for cand in candidates:
        raw = cand["raw_status"]
        prev = carried.pop(cand["name"], None) or {}
        streak = int(prev.get("streak", 0)) + 1 if raw == "signal" else 0
        miss_streak = int(prev.get("miss_streak", 0)) + 1 if raw in _MISS_STATUSES else 0
        if prev.get("surfaced") == "signal" and miss_streak < demote_after:
            status = "signal"
        elif streak >= promote_after:
            status = "signal"
        elif raw == "signal":
            status = "watch"  # cleared tonight's gates; persistence still pending
        else:
            status = raw
        cand["status"] = status
        cand["persistence"] = {"streak": streak, "miss_streak": miss_streak}
        new_state[cand["name"]] = {"streak": streak, "miss_streak": miss_streak, "surfaced": status}
    # Candidates absent tonight (column missing upstream) carry state unchanged
    # rather than being demoted by a pipeline hiccup.
    new_state.update(carried)
    return new_state


def _run_placebo_suite(
    frame: pd.DataFrame,
    specs: list[dict],
    min_n: int,
    boot_reps: int = BOOT_REPS,
    shifts: tuple[int, ...] = PLACEBO_SHIFTS,
) -> list[dict]:
    """Null-calibration suite: rerun every candidate with its DRIVER circularly
    shifted by ~2-4 months. The shift preserves each series' own autocorrelation
    and the real outcome/controls but destroys any true driver-outcome coupling,
    so these should essentially never promote — the rate at which they DO clear
    the identical gates (own BH pool, same thresholds) is a direct estimate of
    the pipeline's false-fire rate on this data's correlation structure.
    Placebos are diagnostics only and never surface as insights."""
    if len(frame) == 0:
        return []
    rows: list[dict] = []
    for spec in specs:
        driver, outcome = spec["driver"], spec["outcome"]
        if driver not in frame or outcome not in frame:
            continue
        for shift in shifts:
            effective = shift % len(frame)
            # keep the null honest: a wrap that lands within two weeks of zero
            # would leave the placebo nearly aligned with the real driver
            if effective < 14 or effective > len(frame) - 14:
                continue
            placebo = frame.copy()
            placebo[driver] = np.roll(frame[driver].to_numpy(), shift)
            result = _evaluate_spec(placebo, spec, min_n, boot_reps, name=f"{spec['name']}__placebo{shift}")
            if result is not None:
                result["shift"] = shift
                rows.append(result)
    _assign_statuses([r for r in rows if "p_value" in r])
    return rows


def discover_adjusted_insights(
    frame: pd.DataFrame,
    specs: list[dict] | None = None,
    min_n: int = MIN_ADJUSTED_N,
    prior_state: dict | None = None,
    promote_after: int = PROMOTE_AFTER,
    demote_after: int = DEMOTE_AFTER,
    boot_reps: int = BOOT_REPS,
    run_placebos: bool = True,
) -> dict:
    """Predeclared, confound-adjusted daily insight finder.

    It deliberately does not sweep arbitrary lags. Each candidate declares its
    temporal interpretation and controls before seeing results. Calendar trend
    and weekday are always adjusted; highly collinear controls are collapsed.
    Promotion gates: HAC (Newey-West) robust intervals — these daily series are
    serially correlated, which heteroskedasticity-only errors understate — an
    effective-n floor on the control-residualized pair, BH false-discovery
    correction, and moving-block bootstrap sign stability. `raw_status` is
    tonight's statistical verdict; the surfaced `status` additionally passes
    persistence hysteresis (see apply_persistence) so nightly re-testing on
    accruing data can't promote a lucky dip. A circular-shift placebo suite
    runs the same gates on null drivers to report the pipeline's false-fire
    rate. None of this makes single-person observational data causal.
    """
    candidate_specs = specs if specs is not None else DEFAULT_ADJUSTED_SPECS
    results = [
        result
        for spec in candidate_specs
        if (result := _evaluate_spec(frame, spec, min_n, boot_reps)) is not None
    ]
    tested = [result for result in results if "p_value" in result]
    _assign_statuses(tested)

    # Avoid presenting two near-duplicate drivers for one outcome. Keep the
    # lower-q candidate and explicitly record which candidate suppressed the
    # other. Runs on raw statuses, before persistence.
    promoted = [r for r in tested if r["raw_status"] in ("signal", "watch")]
    for i, left in enumerate(promoted):
        for right in promoted[i + 1:]:
            if left["outcome"] != right["outcome"] or left["driver"] not in frame or right["driver"] not in frame:
                continue
            corr = frame[[left["driver"], right["driver"]]].corr().iloc[0, 1]
            if np.isfinite(corr) and abs(corr) >= 0.75:
                keep, suppress = sorted((left, right), key=lambda item: item["q_value"])
                suppress["raw_status"] = "suppressed_collinear"
                suppress["suppressed_by"] = keep["name"]

    persistence_state = apply_persistence(results, prior_state, promote_after, demote_after)

    placebo_rows = _run_placebo_suite(frame, candidate_specs, min_n, boot_reps) if run_placebos else []
    placebo_tested = [r for r in placebo_rows if "p_value" in r]

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
        "spec": (
            "Predeclared partial associations; weekday + time trend + candidate-specific "
            "prior-state/load controls; HAC (Newey-West) CI; effective-n floor; BH FDR; "
            "moving-block bootstrap sign stability; collinear-driver suppression; "
            f"{promote_after}-night persistence hysteresis; circular-shift placebo calibration"
        ),
        "coefficients": coefficients,
        "diagnostics": {
            "n": max((result.get("n", 0) for result in results), default=0),
            "candidate_count": len(results),
            "signal_count": sum(result.get("status") == "signal" for result in results),
            "watch_count": sum(result.get("status") == "watch" for result in results),
            "raw_signal_count": sum(result.get("raw_status") == "signal" for result in results),
            "raw_watch_count": sum(result.get("raw_status") == "watch" for result in results),
            "candidates": results,
            "persistence": {
                "state": persistence_state,
                "promote_after": promote_after,
                "demote_after": demote_after,
            },
            "placebo": {
                "shifts": list(PLACEBO_SHIFTS),
                "tested": len(placebo_tested),
                "signal_count": sum(r["raw_status"] == "signal" for r in placebo_tested),
                "watch_count": sum(r["raw_status"] == "watch" for r in placebo_tested),
                "candidates": [
                    {k: r.get(k) for k in ("name", "shift", "n", "n_eff", "partial_r", "q_value", "stable", "raw_status")}
                    for r in placebo_rows
                ],
                "note": "Null drivers (circularly shifted) run the identical gates; any promotion here estimates the pipeline's false-fire rate.",
            },
            "caveat": "Exploratory single-person associations, not causal effects. No result is promoted without multiplicity correction, bootstrap sign stability, and multi-night persistence.",
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
    reference; `q_value` is the FDR-adjusted value the UI should prefer.

    Robustness columns: `spearman_r` (rank correlation, immune to single outlier
    days and monotone nonlinearity) and `rank_disagree`, flagged when Pearson and
    Spearman tell materially different stories — the disagreement itself is
    diagnostic (outlier-driven or nonlinear pair). Shifted-copy pairs listed in
    EXCLUDED_SWEEP_PAIRS are skipped as trivial self-correlation."""
    computed_at = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []
    for x in drivers if drivers is not None else DRIVERS:
        if x not in frame.columns:
            continue
        for y in perfs if perfs is not None else PERFS:
            if y not in frame.columns or x == y or (x, y) in EXCLUDED_SWEEP_PAIRS:
                continue
            for lag in range(0, max_lag + 1):
                paired = pd.DataFrame({"x": frame[x].shift(lag), "y": frame[y]}).dropna()
                if len(paired) < MIN_CORR_N or paired["x"].std() == 0 or paired["y"].std() == 0:
                    continue
                r, p_naive = pearsonr(paired["x"], paired["y"])
                rho = float(spearmanr(paired["x"], paired["y"])[0])
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
                        "spearman_r": round(rho, 4),
                        "rank_disagree": bool(
                            abs(float(r) - rho) > 0.15
                            or (float(r) * rho < 0 and abs(float(r)) >= 0.1)
                        ),
                    }
                )
    for row, q in zip(rows, _bh_qvalues([row["p_value"] for row in rows])):
        row["q_value"] = float(q)
    return rows


def ef_dlm(frame: pd.DataFrame) -> dict | None:
    """OLS: EF_t ~ sleep_{t−1} + sleep_7d_mean + rhr_dev_t + CTL_t + ATL_t with
    HC3 robust SEs. Runs only at ≥40 EF observations; returns an insight_models
    row for `ef_on_sleep_dlm`. CTL and ATL are both EWMA of the same load and
    routinely correlate >0.9 — robust SEs don't fix the variance inflation that
    puts on their coefficients, so collinear regressors (|r| ≥ 0.85) are dropped
    deterministically keep-first, same rule as the adjusted finder's controls."""
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

    kept, dropped = _drop_collinear_controls(df, ["sleep_prev", "sleep_7d_mean", "rhr_dev", "ctl", "atl"])
    X = sm.add_constant(df[kept])
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
        "spec": "OLS: EF_t ~ sleep_{t-1} + sleep_7d_mean + rhr_dev_t + CTL_t + ATL_t (HC3 robust SEs; collinear regressors |r|≥0.85 dropped keep-first)",
        "coefficients": coefficients,
        "diagnostics": {
            "n": n,
            "r2": float(fit.rsquared),
            "dropped_regressors": dropped,
            "caveat": (
                f"Exploratory model on n={n} swim-day observations from a single person — "
                "coefficients describe associations, not causes, and will shift as data accumulates."
            ),
        },
    }
