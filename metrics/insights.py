"""Exploratory + confirmatory insights (SPEC §5.4). Pure functions over a
daily analysis frame; compute.py builds the frame and writes the results.

Swim EF is deliberately absent from the default inference surfaces. It is a
useful descriptive measure, but for a returning swimmer it combines technique
reacquisition with aerobic state; sample size alone cannot identify which
latent factor moved it.
"""

from __future__ import annotations

import math
import zlib
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy.stats import pearsonr, spearmanr, t as student_t

MIN_CORR_N = 20
MIN_ADJUSTED_N = 60

DRIVERS = [
    "sleep_shortfall", "sleep_midpoint_dev", "sleep_awake_fraction",
    "rhr_dev", "hrv_dev", "respiratory_rate_dev", "trimp_prior", "steps_prior",
    "flights_prior",
]
PERFS = ["decoupling", "hrr60", "trimp_total", "weight_7d_slope"]

# Pairs the exploratory sweep must skip: trimp_prior IS trimp_total shifted one
# day, so correlating the two only measures training-schedule autocorrelation.
EXCLUDED_SWEEP_PAIRS = {("trimp_prior", "trimp_total")}
FULL_DAY_AGGREGATE_DRIVERS = {"rhr_dev", "hrv_dev"}

# Adjusted-finder gates beyond raw n. All fixed [PRIOR]-style knobs, declared in
# code before seeing results (same pre-registration discipline as the specs).
MIN_ADJUSTED_N_EFF = 30.0  # min EFFECTIVE n of the control-residualized pair
BOOT_REPS = 200            # moving-block bootstrap replicates per candidate
BOOT_BLOCK_LEN = 14        # days per block — preserves within-block autocorrelation
BOOT_SIGN_AGREE = 0.80     # replicate sign-agreement required for "stable"
BOOT_PHASE_WITHIN_HOURS = 6.0
BOOT_PHASE_AGREE = 0.80
MIN_CYCLIC_BIN_N = 10
PROMOTE_AFTER = 7          # consecutive raw-signal nights before surfacing "signal"
DEMOTE_AFTER = 7           # consecutive raw-miss nights before a surfaced signal drops
PLACEBO_SHIFTS = (61, 91, 122)  # circular driver shifts for the null-calibration suite

WEIGHT_FFILL_LIMIT_DAYS = 3
WEIGHT_ROLLING_WINDOW_DAYS = 7
WEIGHT_ROLLING_MIN_PERIODS = 4

_PRE_WORKOUT_RECOVERY_OUTCOMES = (
    ("sleep_shortfall", "sleep shortfall"),
    ("sleep_awake_fraction", "sleep awake fraction"),
    ("respiratory_rate_dev", "respiratory-rate deviation"),
)
_CO_MEASURED_PHYSIOLOGY_OUTCOMES = (
    ("rhr_dev", "daily RHR aggregate deviation"),
    ("hrv_dev", "daily HRV aggregate deviation"),
    ("respiratory_rate_dev", "respiratory-rate deviation"),
)

DEFAULT_ADJUSTED_SPECS = [
    *[
        {
            "name": f"prior_load_to_{'sleep_continuity' if outcome == 'sleep_awake_fraction' else 'respiration' if outcome == 'respiratory_rate_dev' else outcome.removesuffix('_dev').removesuffix('_shortfall')}",
            "label": f"Prior-day load → {label}",
            "driver": "trimp_prior", "outcome": outcome,
            "controls": [f"lag:{outcome}", "ctl_pre_exposure", "steps_prior"],
            "direction": "lagged",
        }
        for outcome, label in _PRE_WORKOUT_RECOVERY_OUTCOMES
    ],
    *[
        {
            "name": f"steps_to_{'sleep_continuity' if outcome == 'sleep_awake_fraction' else 'respiration' if outcome == 'respiratory_rate_dev' else outcome.removesuffix('_dev').removesuffix('_shortfall')}",
            "label": f"Prior-day steps → {label}",
            "driver": "steps_prior", "outcome": outcome,
            "controls": [f"lag:{outcome}", "trimp_prior", "ctl_pre_exposure"],
            "direction": "lagged",
        }
        for outcome, label in _PRE_WORKOUT_RECOVERY_OUTCOMES
    ],
    *[
        {
            "name": f"flights_to_{'sleep_continuity' if outcome == 'sleep_awake_fraction' else 'respiration' if outcome == 'respiratory_rate_dev' else outcome.removesuffix('_dev').removesuffix('_shortfall')}",
            "label": f"Prior-day flights climbed → {label}",
            "driver": "flights_prior",
            "outcome": outcome,
            "controls": [
                f"lag:{outcome}", "trimp_prior", "steps_prior", "ctl_pre_exposure",
            ],
            "direction": "lagged",
        }
        for outcome, label in _PRE_WORKOUT_RECOVERY_OUTCOMES
    ],
    *[
        {
            "name": f"prior_high_zones_to_{'sleep_continuity' if outcome == 'sleep_awake_fraction' else 'respiration' if outcome == 'respiratory_rate_dev' else outcome.removesuffix('_dev').removesuffix('_shortfall')}",
            "label": f"Prior-day high-zone fraction → {label}",
            "driver": "high_zone_fraction_prior",
            "outcome": outcome,
            "controls": [
                f"lag:{outcome}", "trimp_prior", "steps_prior", "ctl_pre_exposure",
            ],
            "direction": "lagged",
        }
        for outcome, label in _PRE_WORKOUT_RECOVERY_OUTCOMES
    ],
    *[
        {
            "name": f"sleep_shortfall_to_{'respiration' if outcome == 'respiratory_rate_dev' else outcome.removesuffix('_dev')}",
            "label": f"Sleep shortfall ↔ {label}",
            "driver": "sleep_shortfall", "outcome": outcome,
            "controls": [f"lag:{outcome}", "atl_prior"],
            "direction": "co-measured",
        }
        for outcome, label in _CO_MEASURED_PHYSIOLOGY_OUTCOMES
    ],
    {
        "name": "timing_to_sleep_shortfall", "label": "Sleep timing drift ↔ shortfall",
        "driver": "sleep_midpoint_dev", "outcome": "sleep_shortfall",
        "controls": ["lag:sleep_shortfall", "atl_prior"], "direction": "co-measured",
    },
    *[
        {
            "name": f"timing_to_{'respiration' if outcome == 'respiratory_rate_dev' else outcome.removesuffix('_dev')}",
            "label": f"Sleep timing drift ↔ {label}",
            "driver": "sleep_midpoint_dev", "outcome": outcome,
            "controls": [f"lag:{outcome}", "atl_prior"],
            "direction": "co-measured",
        }
        for outcome, label in _CO_MEASURED_PHYSIOLOGY_OUTCOMES
    ],
    *[
        {
            "name": f"sleep_continuity_to_{'respiration' if outcome == 'respiratory_rate_dev' else outcome.removesuffix('_dev')}",
            "label": f"Sleep awake fraction ↔ {label}",
            "driver": "sleep_awake_fraction", "outcome": outcome,
            "controls": [f"lag:{outcome}", "atl_prior"],
            "direction": "co-measured",
        }
        for outcome, label in _CO_MEASURED_PHYSIOLOGY_OUTCOMES
    ],
    {
        "name": "prior_rhr_to_workout_load", "label": "Previous-day RHR deviation → workout-day load",
        "driver": "rhr_dev_prior", "outcome": "trimp_total",
        "controls": ["lag:trimp_total", "ctl_prior"],
        "direction": "workout-day-dose", "outcome_positive_only": True,
    },
    {
        "name": "prior_hrv_to_workout_load", "label": "Previous-day HRV deviation → workout-day load",
        "driver": "hrv_dev_prior", "outcome": "trimp_total",
        "controls": ["lag:trimp_total", "ctl_prior"],
        "direction": "workout-day-dose", "outcome_positive_only": True,
    },
]

WORKOUT_MODALITY_CONTROLS = [
    "modality_cycling", "modality_other", "modality_rowing",
    "modality_running", "modality_strength", "modality_surfing",
    "modality_swim", "modality_walking",
]
_WORKOUT_BASE_CONTROLS = [
    "ctl_prior", "atl_prior", "trimp_prior", "same_day_prior_load",
    "log_hours_since_prev_workout", "log_days_since_prev_modality",
    *WORKOUT_MODALITY_CONTROLS,
]
_WORKOUT_READINESS = (
    ("sleep_shortfall", "Sleep shortfall"),
    ("sleep_shortfall_3d", "Three-night mean sleep shortfall"),
    ("sleep_midpoint_dev", "Sleep timing drift"),
    ("sleep_awake_fraction", "Sleep awake fraction"),
    ("rhr_dev_prior", "Previous-day RHR deviation"),
    ("hrv_dev_prior", "Previous-day HRV deviation"),
    ("respiratory_rate_dev", "Respiratory-rate deviation"),
    ("high_zone_fraction_prior", "Previous-day high-zone fraction"),
)
_WORKOUT_PRE_STATE = (
    ("atl_prior", "Prior acute load"),
    ("log_hours_since_prev_workout", "Time since previous workout"),
)

DEFAULT_WORKOUT_SPECS = [
    *[
        {
            "name": f"{driver}_to_workout_duration",
            "label": f"{label} → workout duration",
            "driver": driver, "outcome": "workout_duration",
            "controls": [*_WORKOUT_BASE_CONTROLS, "duration_prev_modality"],
            "direction": (
                "prior-day-to-workout" if driver.endswith("_prior")
                else "morning-to-workout"
            ),
            "kind": "scalar",
        }
        for driver, label in _WORKOUT_READINESS
    ],
    *[
        {
            "name": f"{driver}_to_workout_duration",
            "label": f"{label} → workout duration",
            "driver": driver,
            "outcome": "workout_duration",
            "controls": [
                *[control for control in _WORKOUT_BASE_CONTROLS if control != driver],
                "duration_prev_modality",
            ],
            "direction": "pre-workout-state",
            "kind": "scalar",
        }
        for driver, label in _WORKOUT_PRE_STATE
    ],
    {
        "name": "hours_awake_to_workout_duration",
        "label": "Hours awake before workout → duration",
        "driver": "hours_since_wake", "outcome": "workout_duration",
        "controls": [*_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "duration_prev_modality"],
        "direction": "same-day-context", "kind": "scalar",
    },
    {
        "name": "hours_awake_to_workout_intensity",
        "label": "Hours awake before workout → recorded intensity",
        "driver": "hours_since_wake", "outcome": "workout_intensity",
        "controls": [
            *_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "log_duration",
            "intensity_prev_modality",
        ],
        "direction": "same-day-context", "kind": "scalar",
    },
    {
        "name": "hours_awake_to_energy_intensity",
        "label": "Hours awake before workout → Apple energy intensity",
        "driver": "hours_since_wake", "outcome": "energy_intensity",
        "controls": [
            *_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "log_duration",
            "energy_intensity_prev_modality",
        ],
        "direction": "same-day-context", "kind": "scalar",
    },
    {
        "name": "hours_awake_to_high_zone_fraction",
        "label": "Hours awake before workout → high-zone fraction",
        "driver": "hours_since_wake", "outcome": "high_zone_fraction",
        "controls": [
            *_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "log_duration",
            "high_zone_prev_modality",
        ],
        "direction": "same-day-context", "kind": "scalar",
    },
    *[
        {
            "name": f"{driver}_to_workout_intensity",
            "label": f"{label} → recorded intensity",
            "driver": driver, "outcome": "workout_intensity",
            "controls": [*_WORKOUT_BASE_CONTROLS, "log_duration", "intensity_prev_modality"],
            "direction": (
                "prior-day-to-workout" if driver.endswith("_prior")
                else "morning-to-workout"
            ),
            "kind": "scalar",
        }
        for driver, label in _WORKOUT_READINESS
    ],
    *[
        {
            "name": f"{driver}_to_high_zone_fraction",
            "label": f"{label} → high-zone fraction",
            "driver": driver, "outcome": "high_zone_fraction",
            "controls": [
                *_WORKOUT_BASE_CONTROLS, "log_duration", "high_zone_prev_modality",
            ],
            "direction": (
                "prior-day-to-workout" if driver.endswith("_prior")
                else "morning-to-workout"
            ),
            "kind": "scalar",
        }
        for driver, label in _WORKOUT_READINESS
    ],
    *[
        {
            "name": f"{driver}_to_energy_intensity",
            "label": f"{label} → Apple energy intensity",
            "driver": driver, "outcome": "energy_intensity",
            "controls": [
                *_WORKOUT_BASE_CONTROLS, "log_duration",
                "energy_intensity_prev_modality",
            ],
            "direction": (
                "prior-day-to-workout" if driver.endswith("_prior")
                else "morning-to-workout"
            ),
            "kind": "scalar",
        }
        for driver, label in _WORKOUT_READINESS
    ],
    *[
        {
            "name": f"{driver}_to_workout_intensity",
            "label": f"{label} → recorded intensity",
            "driver": driver,
            "outcome": "workout_intensity",
            "controls": [
                *[control for control in _WORKOUT_BASE_CONTROLS if control != driver],
                "log_duration",
                "intensity_prev_modality",
            ],
            "direction": "pre-workout-state",
            "kind": "scalar",
        }
        for driver, label in _WORKOUT_PRE_STATE
    ],
    *[
        {
            "name": f"{driver}_to_high_zone_fraction",
            "label": f"{label} → high-zone fraction",
            "driver": driver,
            "outcome": "high_zone_fraction",
            "controls": [
                *[control for control in _WORKOUT_BASE_CONTROLS if control != driver],
                "log_duration",
                "high_zone_prev_modality",
            ],
            "direction": "pre-workout-state",
            "kind": "scalar",
        }
        for driver, label in _WORKOUT_PRE_STATE
    ],
    *[
        {
            "name": f"{driver}_to_energy_intensity",
            "label": f"{label} → Apple energy intensity",
            "driver": driver,
            "outcome": "energy_intensity",
            "controls": [
                *[control for control in _WORKOUT_BASE_CONTROLS if control != driver],
                "log_duration",
                "energy_intensity_prev_modality",
            ],
            "direction": "pre-workout-state",
            "kind": "scalar",
        }
        for driver, label in _WORKOUT_PRE_STATE
    ],
    {
        "name": "workout_time_to_load", "label": "Workout time → scheduled load",
        "outcome": "workout_load",
        "controls": [
            *_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "hours_since_wake",
            "load_prev_modality",
        ],
        "direction": "circadian", "kind": "cyclic",
    },
    {
        "name": "workout_time_to_duration", "label": "Workout time → duration",
        "outcome": "workout_duration",
        "controls": [
            *_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "hours_since_wake",
            "duration_prev_modality",
        ],
        "direction": "circadian", "kind": "cyclic",
    },
    {
        "name": "workout_time_to_intensity", "label": "Workout time → recorded intensity",
        "outcome": "workout_intensity",
        "controls": [
            *_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "hours_since_wake", "log_duration",
            "intensity_prev_modality",
        ],
        "direction": "circadian", "kind": "cyclic",
    },
    {
        "name": "workout_time_to_energy_intensity",
        "label": "Workout time → Apple energy intensity",
        "outcome": "energy_intensity",
        "controls": [
            *_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "hours_since_wake",
            "log_duration", "energy_intensity_prev_modality",
        ],
        "direction": "circadian", "kind": "cyclic",
    },
    {
        "name": "workout_time_to_high_zones", "label": "Workout time → high-zone fraction",
        "outcome": "high_zone_fraction",
        "controls": [
            *_WORKOUT_BASE_CONTROLS, "sleep_shortfall", "hours_since_wake", "log_duration",
            "high_zone_prev_modality",
        ],
        "direction": "circadian", "kind": "cyclic",
    },
]


def prior_rolling_deviation(
    series: pd.Series,
    days: int = 28,
    min_periods: int = 14,
) -> pd.Series:
    """Current value minus a calendar-day rolling median of PRIOR values.

    ``closed='left'`` is the important semantic: today's measurement cannot
    pull its own baseline toward itself, and gaps do not turn "28 days" into
    "the last 28 observations".
    """
    numeric = pd.to_numeric(series, errors="coerce")
    baseline = numeric.rolling(f"{days}D", min_periods=min_periods, closed="left").median()
    return numeric - baseline


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


def _calendar_covariates(index: pd.Index) -> pd.DataFrame:
    """Secular trend, annual harmonic, and weekday controls for an index."""
    dates = pd.DatetimeIndex(index)
    elapsed_days = (dates.normalize() - dates.normalize().min()) / pd.Timedelta(days=1)
    annual_angle = 2.0 * math.pi * dates.dayofyear.to_numpy(dtype=float) / 365.2425
    calendar = pd.DataFrame(
        {
            "time_trend": elapsed_days.to_numpy(dtype=float),
            "annual_sin": np.sin(annual_angle),
            "annual_cos": np.cos(annual_angle),
        },
        index=index,
    )
    weekdays = pd.get_dummies(
        dates.dayofweek, prefix="dow", drop_first=True, dtype=float
    )
    weekdays.index = index
    return pd.concat([calendar, weekdays], axis=1)


def _calendar_block_bootstrap_sample(
    data: pd.DataFrame,
    rng: np.random.Generator,
    block_len: int = BOOT_BLOCK_LEN,
) -> pd.DataFrame:
    """Sample contiguous calendar-day blocks while keeping date clusters whole."""
    if data.empty:
        return data.copy()
    normalized = pd.DatetimeIndex(data.index).normalize()
    calendar = pd.date_range(normalized.min(), normalized.max(), freq="D")
    actual_block_len = min(block_len, len(calendar))
    n_blocks = int(math.ceil(len(calendar) / actual_block_len))
    starts = rng.integers(
        0,
        len(calendar) - actual_block_len + 1,
        size=n_blocks,
    )
    sampled_days = np.concatenate(
        [calendar[start : start + actual_block_len].to_numpy() for start in starts]
    )[: len(calendar)]
    positions_by_day = {
        day: np.flatnonzero(normalized == day)
        for day in pd.DatetimeIndex(normalized.unique())
    }
    pieces = [
        data.iloc[positions_by_day[pd.Timestamp(day)]]
        for day in sampled_days
        if pd.Timestamp(day) in positions_by_day
    ]
    return pd.concat(pieces) if pieces else data.iloc[0:0].copy()


def _block_bootstrap_stability(
    data: pd.DataFrame,
    controls: list[str],
    point: float,
    seed_name: str,
    reps: int = BOOT_REPS,
    block_len: int = BOOT_BLOCK_LEN,
    agree_min: float = BOOT_SIGN_AGREE,
    cluster_dates: bool = False,
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
    normalized = pd.DatetimeIndex(data.index).normalize()
    span_days = (
        int((normalized.max() - normalized.min()).days) + 1
        if cluster_dates and n else n
    )
    if span_days < 2 * block_len or point == 0 or not np.isfinite(point):
        return {"stable": False, "agree": 0.0, "n_valid": 0}
    rng = np.random.default_rng(zlib.crc32(seed_name.encode("utf-8")))
    values: list[float] = []
    for _ in range(reps):
        if cluster_dates:
            sample = _calendar_block_bootstrap_sample(data, rng, block_len)
        else:
            n_blocks = int(math.ceil(n / block_len))
            starts = rng.integers(0, n - block_len + 1, size=n_blocks)
            idx = np.concatenate([np.arange(s, s + block_len) for s in starts])[:n]
            sample = data.iloc[idx]
        sample = sample.reset_index(drop=True)
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


def _circular_distance_hours(left: float, right: float) -> float:
    difference = abs(left - right) % 24.0
    return min(difference, 24.0 - difference)


def _cyclic_peak_hour(beta_sin: float, beta_cos: float) -> float:
    """Peak of beta_sin*sin(theta) + beta_cos*cos(theta), as local hour."""
    theta = math.atan2(beta_sin, beta_cos) % (2.0 * math.pi)
    return theta * 24.0 / (2.0 * math.pi)


def _fit_cyclic(data: pd.DataFrame, controls: list[str]):
    X = sm.add_constant(data[["start_sin", "start_cos", *controls]].astype(float), has_constant="add")
    return sm.OLS(_zscore(data["y"]), X).fit()


def _cyclic_bootstrap_stability(
    data: pd.DataFrame,
    controls: list[str],
    peak_hour: float,
    seed_name: str,
    reps: int = BOOT_REPS,
    block_len: int = BOOT_BLOCK_LEN,
    cluster_dates: bool = False,
) -> dict:
    """Moving-block stability for a cosinor phase.

    A cyclic effect has no meaningful sign. Stability therefore means that at
    least 80% of valid bootstrap peaks remain within six clock hours of the
    fitted peak. Circular resultant length is retained as a second, continuous
    diagnostic of phase concentration.
    """
    n = len(data)
    normalized = pd.DatetimeIndex(data.index).normalize()
    span_days = (
        int((normalized.max() - normalized.min()).days) + 1
        if cluster_dates and n else n
    )
    if span_days < 2 * block_len:
        return {"stable": False, "within_6h": 0.0, "resultant": 0.0, "n_valid": 0}
    rng = np.random.default_rng(zlib.crc32(seed_name.encode("utf-8")))
    peaks: list[float] = []
    for _ in range(reps):
        if cluster_dates:
            sample = _calendar_block_bootstrap_sample(data, rng, block_len)
        else:
            n_blocks = int(math.ceil(n / block_len))
            starts = rng.integers(0, n - block_len + 1, size=n_blocks)
            idx = np.concatenate([np.arange(s, s + block_len) for s in starts])[:n]
            sample = data.iloc[idx]
        sample = sample.reset_index(drop=True)
        if sample["y"].std(ddof=0) == 0:
            continue
        try:
            fit = _fit_cyclic(sample, controls)
        except (ValueError, np.linalg.LinAlgError):
            continue
        beta_sin = float(fit.params.get("start_sin", np.nan))
        beta_cos = float(fit.params.get("start_cos", np.nan))
        if np.isfinite(beta_sin) and np.isfinite(beta_cos) and math.hypot(beta_sin, beta_cos) > 1e-9:
            peaks.append(_cyclic_peak_hour(beta_sin, beta_cos))
    if len(peaks) < reps // 2:
        return {"stable": False, "within_6h": 0.0, "resultant": 0.0, "n_valid": len(peaks)}
    within = float(np.mean([_circular_distance_hours(peak, peak_hour) <= BOOT_PHASE_WITHIN_HOURS for peak in peaks]))
    angles = np.asarray(peaks) * 2.0 * math.pi / 24.0
    resultant = float(math.hypot(np.mean(np.sin(angles)), np.mean(np.cos(angles))))
    return {
        "stable": bool(within >= BOOT_PHASE_AGREE),
        "within_6h": within,
        "resultant": resultant,
        "n_valid": len(peaks),
    }


def _evaluate_cyclic_spec(
    frame: pd.DataFrame,
    spec: dict,
    min_n: int,
    boot_reps: int = BOOT_REPS,
    name: str | None = None,
    cluster_dates: bool = False,
) -> dict | None:
    """Joint 24-hour sine/cosine test for a workout-time candidate."""
    outcome = spec["outcome"]
    if outcome not in frame or "start_sin" not in frame or "start_cos" not in frame:
        return None
    name = name or spec["name"]
    data = pd.DataFrame(
        {
            "start_sin": frame["start_sin"],
            "start_cos": frame["start_cos"],
            "y": frame[outcome],
        },
        index=frame.index,
    )
    raw_controls: list[str] = []
    for control in spec.get("controls", []):
        if control in frame:
            data[control] = frame[control]
            raw_controls.append(control)
    calendar = _calendar_covariates(data.index)
    data = pd.concat([data, calendar], axis=1).dropna()
    n_days = int(pd.DatetimeIndex(data.index).normalize().nunique())
    base = {
        "name": name,
        "label": spec["label"],
        "driver": "workout_start_time",
        "outcome": outcome,
        "direction": spec.get("direction", "circadian"),
        "kind": "cyclic",
        "n": int(len(data)),
    }
    if cluster_dates:
        base["n_days"] = n_days
    clock_hours = (
        np.arctan2(data["start_sin"].to_numpy(), data["start_cos"].to_numpy())
        % (2.0 * math.pi)
    ) * 24.0 / (2.0 * math.pi)
    normalized_dates = pd.DatetimeIndex(data.index).normalize()
    time_masks = {
        "morning": (clock_hours >= 5) & (clock_hours < 12),
        "afternoon": (clock_hours >= 12) & (clock_hours < 18),
        "evening_night": (clock_hours >= 18) | (clock_hours < 5),
    }
    time_bin_counts = {
        label: int(np.sum(mask)) for label, mask in time_masks.items()
    }
    time_bin_date_counts = {
        label: int(normalized_dates[mask].nunique())
        for label, mask in time_masks.items()
    }
    if (
        len(data) < min_n
        or data["y"].std(ddof=0) == 0
        or data["start_sin"].std(ddof=0) == 0
        or data["start_cos"].std(ddof=0) == 0
    ):
        return {**base, "raw_status": "insufficient", "reason": "raw_n", "required_n": min_n}
    if cluster_dates and n_days < min_n:
        return {
            **base,
            "raw_status": "insufficient",
            "reason": "independent_dates",
            "required_n_days": min_n,
        }
    coverage_counts = time_bin_date_counts if cluster_dates else time_bin_counts
    if min(coverage_counts.values()) < MIN_CYCLIC_BIN_N:
        return {
            **base,
            "raw_status": "insufficient",
            "reason": "time_coverage",
            "time_bin_counts": time_bin_counts,
            "time_bin_date_counts": time_bin_date_counts,
            "required_per_time_bin": MIN_CYCLIC_BIN_N,
        }

    kept, dropped = _drop_collinear_controls(data, raw_controls)
    controls = kept + calendar.columns.tolist()
    control_matrix = sm.add_constant(data[controls].astype(float), has_constant="add")
    y_resid = sm.OLS(data["y"], control_matrix).fit().resid
    sin_resid = sm.OLS(data["start_sin"], control_matrix).fit().resid
    cos_resid = sm.OLS(data["start_cos"], control_matrix).fit().resid
    n_eff = min(
        _effective_n(len(data), _lag1_autocorr(sin_resid), _lag1_autocorr(y_resid)),
        _effective_n(len(data), _lag1_autocorr(cos_resid), _lag1_autocorr(y_resid)),
    )
    if cluster_dates:
        n_eff = min(n_eff, float(n_days))
    if n_eff < MIN_ADJUSTED_N_EFF:
        return {
            **base,
            "raw_status": "insufficient",
            "reason": "effective_n",
            "n_eff": round(float(n_eff), 1),
            "required_n_eff": MIN_ADJUSTED_N_EFF,
            "dropped_controls": dropped,
        }

    ordinary = _fit_cyclic(data, controls)
    robust = ordinary.get_robustcov_results(
        cov_type="HAC", maxlags=_nw_maxlags(len(data)), use_correction=True
    )
    names = ordinary.model.exog_names
    sin_idx, cos_idx = names.index("start_sin"), names.index("start_cos")
    restriction = np.zeros((2, len(names)))
    restriction[0, sin_idx] = 1.0
    restriction[1, cos_idx] = 1.0
    joint = robust.wald_test(restriction, scalar=True)
    beta_sin = float(ordinary.params["start_sin"])
    beta_cos = float(ordinary.params["start_cos"])
    peak_hour = _cyclic_peak_hour(beta_sin, beta_cos)
    reduced = sm.OLS(_zscore(data["y"]), control_matrix).fit()
    partial_r2 = max(0.0, min(1.0, (reduced.ssr - ordinary.ssr) / reduced.ssr)) if reduced.ssr > 0 else 0.0
    effect_size = math.sqrt(partial_r2)
    boot = _cyclic_bootstrap_stability(
        data,
        controls,
        peak_hour,
        name,
        reps=boot_reps,
        cluster_dates=cluster_dates,
    )
    robust_ci = dict(zip(names, robust.conf_int()))
    uncertainty = {
        "sin_ci_low": float(robust_ci["start_sin"][0]),
        "sin_ci_high": float(robust_ci["start_sin"][1]),
        "cos_ci_low": float(robust_ci["start_cos"][0]),
        "cos_ci_high": float(robust_ci["start_cos"][1]),
        "p_value": float(joint.pvalue),
    }
    if cluster_dates:
        date_groups = pd.factorize(pd.DatetimeIndex(data.index).normalize())[0]
        clustered = ordinary.get_robustcov_results(
            cov_type="cluster", groups=date_groups, use_correction=True
        )
        clustered_joint = clustered.wald_test(restriction, scalar=True)
        clustered_ci = dict(zip(names, clustered.conf_int()))
        uncertainty = {
            "sin_ci_low": min(
                float(robust_ci["start_sin"][0]),
                float(clustered_ci["start_sin"][0]),
            ),
            "sin_ci_high": max(
                float(robust_ci["start_sin"][1]),
                float(clustered_ci["start_sin"][1]),
            ),
            "cos_ci_low": min(
                float(robust_ci["start_cos"][0]),
                float(clustered_ci["start_cos"][0]),
            ),
            "cos_ci_high": max(
                float(robust_ci["start_cos"][1]),
                float(clustered_ci["start_cos"][1]),
            ),
            "p_value": max(float(joint.pvalue), float(clustered_joint.pvalue)),
            "sin_ci_low_hac": float(robust_ci["start_sin"][0]),
            "sin_ci_high_hac": float(robust_ci["start_sin"][1]),
            "cos_ci_low_hac": float(robust_ci["start_cos"][0]),
            "cos_ci_high_hac": float(robust_ci["start_cos"][1]),
            "p_value_hac": float(joint.pvalue),
            "sin_ci_low_date_cluster": float(clustered_ci["start_sin"][0]),
            "sin_ci_high_date_cluster": float(clustered_ci["start_sin"][1]),
            "cos_ci_low_date_cluster": float(clustered_ci["start_cos"][0]),
            "cos_ci_high_date_cluster": float(clustered_ci["start_cos"][1]),
            "p_value_date_cluster": float(clustered_joint.pvalue),
        }
    return {
        **base,
        "n_eff": round(float(n_eff), 1),
        "effect_size": effect_size,
        "partial_r2": partial_r2,
        "amplitude_sd": math.hypot(beta_sin, beta_cos),
        "peak_hour": peak_hour,
        "beta_sin": beta_sin,
        "beta_cos": beta_cos,
        **uncertainty,
        "bootstrap_unit": "calendar_date" if cluster_dates else "row",
        "stable": boot["stable"],
        "phase_within_6h": round(boot["within_6h"], 3),
        "phase_resultant": round(boot["resultant"], 3),
        "boot_n_valid": boot["n_valid"],
        "time_bin_counts": time_bin_counts,
        "time_bin_date_counts": time_bin_date_counts,
        "dropped_controls": dropped,
    }


def _evaluate_spec(
    frame: pd.DataFrame,
    spec: dict,
    min_n: int,
    boot_reps: int = BOOT_REPS,
    name: str | None = None,
    cluster_dates: bool = False,
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

    calendar = _calendar_covariates(data.index)
    data = pd.concat([data, calendar], axis=1)
    if spec.get("outcome_positive_only"):
        data = data.loc[data["y"] > 0]
    data = data.dropna()
    n_days = int(pd.DatetimeIndex(data.index).normalize().nunique())
    base = {
        "name": name, "label": spec["label"], "driver": driver, "outcome": outcome,
        "direction": spec.get("direction", "co-measured"), "n": int(len(data)),
    }
    if cluster_dates:
        base["n_days"] = n_days
    if len(data) < min_n or data["x"].std() == 0 or data["y"].std() == 0:
        return {**base, "raw_status": "insufficient", "reason": "raw_n", "required_n": min_n}
    if cluster_dates and n_days < min_n:
        return {
            **base,
            "raw_status": "insufficient",
            "reason": "independent_dates",
            "required_n_days": min_n,
        }

    kept, dropped = _drop_collinear_controls(data, raw_controls)
    controls = kept + calendar.columns.tolist()
    x_resid, y_resid = _residualize(data, controls)
    # Effective information AFTER the controls: with a lagged-outcome control the
    # residuals are near-iid and n_eff ≈ n; without one, smooth series can carry
    # far fewer independent days than rows, and the candidate must wait for data.
    n_eff = _effective_n(len(data), _lag1_autocorr(x_resid), _lag1_autocorr(y_resid))
    if cluster_dates:
        n_eff = min(n_eff, float(n_days))
    if n_eff < MIN_ADJUSTED_N_EFF:
        return {
            **base, "raw_status": "insufficient", "reason": "effective_n",
            "n_eff": round(float(n_eff), 1), "required_n_eff": MIN_ADJUSTED_N_EFF,
            "dropped_controls": dropped,
        }

    partial = float(pearsonr(x_resid, y_resid)[0])
    ranked = data.copy()
    ranked["x"] = data["x"].rank(method="average")
    ranked["y"] = data["y"].rank(method="average")
    partial_spearman = _partial_r(ranked, controls)
    rank_disagree = bool(
        abs(partial - partial_spearman) > 0.15
        or (partial * partial_spearman < 0 and abs(partial) >= 0.1)
    )
    X = sm.add_constant(pd.concat([_zscore(data["x"]).rename("x"), data[controls]], axis=1), has_constant="add")
    model = sm.OLS(_zscore(data["y"]), X)
    fit = model.fit(cov_type="HAC", cov_kwds={"maxlags": _nw_maxlags(len(data))})
    ci = fit.conf_int().loc["x"]
    uncertainty = {
        "ci_low": float(ci.iloc[0]),
        "ci_high": float(ci.iloc[1]),
        "p_value": float(fit.pvalues["x"]),
    }
    if cluster_dates:
        date_groups = pd.factorize(pd.DatetimeIndex(data.index).normalize())[0]
        clustered = model.fit(
            cov_type="cluster",
            cov_kwds={"groups": date_groups, "use_correction": True},
        )
        clustered_ci = clustered.conf_int().loc["x"]
        uncertainty = {
            "ci_low": min(float(ci.iloc[0]), float(clustered_ci.iloc[0])),
            "ci_high": max(float(ci.iloc[1]), float(clustered_ci.iloc[1])),
            "p_value": max(float(fit.pvalues["x"]), float(clustered.pvalues["x"])),
            "ci_low_hac": float(ci.iloc[0]),
            "ci_high_hac": float(ci.iloc[1]),
            "p_value_hac": float(fit.pvalues["x"]),
            "ci_low_date_cluster": float(clustered_ci.iloc[0]),
            "ci_high_date_cluster": float(clustered_ci.iloc[1]),
            "p_value_date_cluster": float(clustered.pvalues["x"]),
        }
    boot = _block_bootstrap_stability(
        data,
        controls,
        partial,
        name,
        reps=boot_reps,
        cluster_dates=cluster_dates,
    )
    return {
        **base, "n_eff": round(float(n_eff), 1),
        "partial_r": partial, "partial_spearman": partial_spearman,
        "rank_disagree": rank_disagree, "beta": float(fit.params["x"]),
        **uncertainty, "stable": boot["stable"],
        "bootstrap_unit": "calendar_date" if cluster_dates else "row",
        "boot_sign_agree": round(boot["agree"], 3), "boot_n_valid": boot["n_valid"],
        "dropped_controls": dropped,
    }


def _assign_statuses(tested: list[dict]) -> None:
    """BH q-values across the pool, then the promotion gate chain → `raw_status`
    on each tested candidate (in place)."""
    for result, q in zip(tested, _bh_qvalues([r["p_value"] for r in tested])):
        result["q_value"] = float(q)
    for result in tested:
        effect = abs(result.get("partial_r", result.get("effect_size", 0.0)))
        robust = not result.get("rank_disagree", False)
        result["raw_status"] = (
            "signal" if result["q_value"] <= 0.10 and effect >= 0.15 and result["stable"] and robust
            else "watch" if result["q_value"] <= 0.20 and effect >= 0.15 and result["stable"] and robust
            else "no_clear_signal"
        )


_MISS_STATUSES = (
    "no_clear_signal", "insufficient", "suppressed_collinear", "suppressed_placebo",
)


def _suppress_placebo_sensitive(candidates: list[dict], placebo_rows: list[dict]) -> None:
    """Suppress a real candidate when its own shifted null also clears gates."""
    for candidate in candidates:
        if candidate.get("raw_status") not in ("signal", "watch"):
            continue
        prefix = f"{candidate['name']}__placebo"
        fired = [
            row for row in placebo_rows
            if row.get("name", "").startswith(prefix)
            and row.get("raw_status") in ("signal", "watch")
        ]
        if not fired:
            continue
        candidate["raw_status"] = "suppressed_placebo"
        candidate["placebo_sensitivity"] = {
            "fired": len(fired),
            "shifts": [row.get("shift") for row in fired],
            "note": "This candidate's gates also fired after its driver alignment was destroyed.",
        }


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

    placebo_rows = _run_placebo_suite(frame, candidate_specs, min_n, boot_reps) if run_placebos else []
    placebo_tested = [r for r in placebo_rows if "p_value" in r]
    _suppress_placebo_sensitive(results, placebo_rows)
    persistence_state = apply_persistence(results, prior_state, promote_after, demote_after)

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
            "Predeclared partial associations; weekday + annual season + time trend + candidate-specific "
            "prior-state/load controls; HAC (Newey-West) CI; effective-n floor; BH FDR; "
            "moving-block bootstrap sign stability; collinear-driver suppression; "
            f"{promote_after}-night persistence hysteresis; circular-shift placebo calibration"
        ),
        "coefficients": coefficients,
        "diagnostics": {
            "model_version": 7,
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
            "caveat": (
                "Exploratory single-person associations, not causal effects. RHR and HRV are "
                "finalized full-day aggregates, so same-date relationships are co-measured, "
                "never pre-workout readiness. Local sleep-clock features use Apple's recorded "
                "sleep offset when available, preventing travel from masquerading as timing drift. "
                "High-zone composition is defined only on training "
                "days whose every workout passes HR coverage, with total load adjusted. "
                "No result is promoted without multiplicity "
                "correction, bootstrap sign stability, and multi-night persistence."
            ),
        },
    }


def _run_workout_placebo_suite(
    frame: pd.DataFrame,
    specs: list[dict],
    min_n: int,
    boot_reps: int = BOOT_REPS,
    shifts: tuple[int, ...] = PLACEBO_SHIFTS,
) -> list[dict]:
    """Event-order circular-shift null calibration for workout candidates."""
    if len(frame) == 0:
        return []
    rows: list[dict] = []
    for spec in specs:
        outcome = spec["outcome"]
        if outcome not in frame:
            continue
        for shift in shifts:
            effective = shift % len(frame)
            if effective < 14 or effective > len(frame) - 14:
                continue
            placebo = frame.copy()
            if spec.get("kind") == "cyclic":
                if "start_sin" not in frame or "start_cos" not in frame:
                    continue
                placebo["start_sin"] = np.roll(frame["start_sin"].to_numpy(), shift)
                placebo["start_cos"] = np.roll(frame["start_cos"].to_numpy(), shift)
                result = _evaluate_cyclic_spec(
                    placebo,
                    spec,
                    min_n,
                    boot_reps,
                    name=f"{spec['name']}__placebo{shift}",
                    cluster_dates=True,
                )
            else:
                driver = spec["driver"]
                if driver not in frame:
                    continue
                placebo[driver] = np.roll(frame[driver].to_numpy(), shift)
                result = _evaluate_spec(
                    placebo,
                    spec,
                    min_n,
                    boot_reps,
                    name=f"{spec['name']}__placebo{shift}",
                    cluster_dates=True,
                )
            if result is not None:
                result["shift"] = shift
                rows.append(result)
    _assign_statuses([row for row in rows if "p_value" in row])
    return rows


def discover_workout_context_insights(
    frame: pd.DataFrame,
    specs: list[dict] | None = None,
    min_n: int = MIN_ADJUSTED_N,
    prior_state: dict | None = None,
    promote_after: int = PROMOTE_AFTER,
    demote_after: int = DEMOTE_AFTER,
    boot_reps: int = BOOT_REPS,
    run_placebos: bool = True,
) -> dict:
    """Predeclared workout-level readiness and circular timing finder."""
    candidate_specs = specs if specs is not None else DEFAULT_WORKOUT_SPECS
    results: list[dict] = []
    for spec in candidate_specs:
        if spec.get("kind") == "cyclic":
            result = _evaluate_cyclic_spec(
                frame, spec, min_n, boot_reps, cluster_dates=True
            )
        else:
            result = _evaluate_spec(frame, spec, min_n, boot_reps, cluster_dates=True)
        if result is not None:
            results.append(result)
    tested = [result for result in results if "p_value" in result]
    _assign_statuses(tested)

    # Readiness variables can be near-duplicates (notably RHR and HRV). As in
    # the daily family, do not surface two versions of the same outcome when
    # their drivers carry essentially the same information.
    promoted = [
        result for result in tested
        if result["raw_status"] in ("signal", "watch") and result.get("kind") != "cyclic"
    ]
    for i, left in enumerate(promoted):
        for right in promoted[i + 1:]:
            if (
                left["outcome"] != right["outcome"]
                or left["driver"] not in frame
                or right["driver"] not in frame
            ):
                continue
            corr = frame[[left["driver"], right["driver"]]].corr().iloc[0, 1]
            if np.isfinite(corr) and abs(corr) >= 0.75:
                keep, suppress = sorted((left, right), key=lambda item: item["q_value"])
                suppress["raw_status"] = "suppressed_collinear"
                suppress["suppressed_by"] = keep["name"]

    placebo_rows = (
        _run_workout_placebo_suite(frame, candidate_specs, min_n, boot_reps)
        if run_placebos else []
    )
    placebo_tested = [row for row in placebo_rows if "p_value" in row]
    _suppress_placebo_sensitive(results, placebo_rows)
    persistence_state = apply_persistence(results, prior_state, promote_after, demote_after)

    coefficients: dict[str, dict] = {}
    for result in tested:
        if result.get("kind") == "cyclic":
            coefficients[f"{result['name']}:sin"] = {
                "coef": result["beta_sin"],
                "ci_low": result["sin_ci_low"],
                "ci_high": result["sin_ci_high"],
                "p_value": result["p_value"],
            }
            coefficients[f"{result['name']}:cos"] = {
                "coef": result["beta_cos"],
                "ci_low": result["cos_ci_low"],
                "ci_high": result["cos_ci_high"],
                "p_value": result["p_value"],
            }
        else:
            coefficients[result["name"]] = {
                "coef": result["beta"],
                "ci_low": result["ci_low"],
                "ci_high": result["ci_high"],
                "p_value": result["p_value"],
            }

    return {
        "name": "workout_context_finder",
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "spec": (
            f"Predeclared workout-only associations; at least {min_n} distinct workout dates; modality + weekday + "
            "annual season + elapsed-day trend + acute/chronic prior-load controls; "
            "recorded-offset local clock + instant elapsed-since-wake; "
            "wake-ordered sleep context; outcome-specific HR completeness gates; "
            "measured-time HR intensity + Apple energy-intensity outcome; "
            "joint 24-hour sine/cosine timing tests; "
            "conservative maximum of HAC and date-clustered uncertainty; effective-n floor; "
            "BH FDR; calendar-date block sign/phase stability; collinearity collapse; "
            f"{promote_after}-night persistence hysteresis; circular-shift placebo calibration"
        ),
        "coefficients": coefficients,
        "diagnostics": {
            "model_version": 11,
            "n": max((result.get("n", 0) for result in results), default=0),
            "n_days": max((result.get("n_days", 0) for result in results), default=0),
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
                "signal_count": sum(row["raw_status"] == "signal" for row in placebo_tested),
                "watch_count": sum(row["raw_status"] == "watch" for row in placebo_tested),
                "candidates": [
                    {
                        key: row.get(key)
                        for key in (
                            "name", "shift", "n", "n_eff", "partial_r", "effect_size",
                            "q_value", "stable", "raw_status",
                        )
                    }
                    for row in placebo_rows
                ],
                "note": "Event-order circular shifts run the identical workout gates.",
            },
            "caveat": (
                "Workout-only single-person associations, not capacity tests or causal effects. "
                "Recorded intensity is TRIMP per measured HR minute. HR-derived load, intensity, "
                "and zone outcomes require at least 90% HR-time coverage; duration remains usable "
                "without HR. Apple energy intensity is a separate device-estimated kcal/(hour·kg) "
                "outcome, not measured power or fitness. Timing is adjusted for modality but may "
                "still reflect scheduling and unmeasured workout intent. RHR and HRV context uses "
                "the previous day's finalized aggregate, never a same-day value. Same-day sleep "
                "context is included only when its recorded wake instant precedes the workout. "
                "Clock time and calendar date use HAE's verified recorded offset when available, "
                "while recovery intervals use absolute instants. Local sleep-clock features "
                "likewise prefer the recorded sleep offset during travel. "
                "Previous-day high-zone composition exists only when every workout on that day "
                "passes HR coverage and is adjusted for total prior-day load. "
                "Recovery intervals and prior same-day load include workouts that are too short "
                "or too sparsely measured to serve as HR-derived outcome rows."
            ),
        },
    }


def zscore_trailing(frame: pd.DataFrame, days: int = 180) -> pd.DataFrame:
    """Restrict to the trailing `days` rows by date and z-score each column
    within-person over that window. Zero-variance columns become NaN."""
    window = frame.loc[frame.index >= frame.index.max() - pd.Timedelta(days=days - 1)]
    sd = window.std(ddof=0)
    return (window - window.mean()) / sd.mask(sd.eq(0), np.nan)


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
    skipped. Load outcomes are conditional on positive measured TRIMP days, so
    rest-day zeroes do not blend training occurrence with workout dose.
    Overwrites the table each nightly run.

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
                # HAE finalizes RHR/HRV after the day and can revise them after
                # a workout. They are valid prior-day predictors, never
                # same-day pre-workout drivers.
                if lag == 0 and x in FULL_DAY_AGGREGATE_DRIVERS:
                    continue
                paired = pd.DataFrame({"x": frame[x].shift(lag), "y": frame[y]}).dropna()
                if y == "trimp_total":
                    paired = paired.loc[paired["y"] > 0]
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
