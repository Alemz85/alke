"""Nightly metrics job (SPEC §5). Run: `python -m metrics.compute [--full]`.

Per-workout metrics recompute over the last 60 days by default (--full for
everything). The daily CTL/ATL/ACWR chain is always recomputed over full
history: it is a few hundred rows, and the EWMA chain is only exact when
seeded from day one."""

from __future__ import annotations

import argparse
import math
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from metrics import db
from metrics.models import (
    acwr,
    classify_zone,
    ctl_atl_series,
    ef,
    ef_eligibility,
    flags_for_day,
    hr_drift_pct,
    hrr60,
    rolling_median,
    swim_active_ef,
    swim_active_hr_drift_pct,
    swim_ef_eligibility,
    time_in_zones,
    trimp_edwards,
    z2_trimp_from_zones,
    zone_bounds,
)

RECOMPUTE_DAYS = 60

# weekly_min_sessions goal keys -> workout-type substring matching, mirroring
# the desktop app's modality matcher (app/src/renderer/src/lib/modality.ts).
GOAL_SYNONYMS = {
    "lift": ["strength", "weight"],
    "swim": ["swim"],
    "bike": ["cycling", "biking"],
    "row": ["rowing"],
    "cardio": ["swim", "run", "cycling", "biking", "rowing", "elliptical", "walk", "hiking"],
}


def goal_matches(workout_type: str | None, goal: str) -> bool:
    if not workout_type:
        return False
    t, g = workout_type.lower(), goal.lower()
    return g in t or any(s in t for s in GOAL_SYNONYMS.get(g, []))


def local_date(ts_iso: str, tz: ZoneInfo) -> date:
    return datetime.fromisoformat(ts_iso.replace("Z", "+00:00")).astimezone(tz).date()


def goal_progress_rows(goal_id: str, result: list[dict]) -> list[dict]:
    """Normalize exec_readonly_sql output (agent-authored metric_sql, one row
    per day) into goal_progress upsert rows. Tolerant of schema drift: rows
    missing a parseable date or a numeric value are dropped rather than
    failing the goal. ISO timestamps are truncated to date; later rows for a
    duplicate date win."""
    by_date: dict[str, float] = {}
    for row in result:
        raw_date = row.get("date")
        raw_value = row.get("value")
        if raw_date is None or raw_value is None:
            continue
        try:
            day = datetime.fromisoformat(str(raw_date).replace("Z", "+00:00")).date()
        except ValueError:
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        if value != value:  # NaN
            continue
        by_date[day.isoformat()] = round(value, 4)

    return [
        {"goal_id": goal_id, "date": d, "value": v}
        for d, v in sorted(by_date.items())
    ]


def rhr_recent_for(day: date, rhr_by_date: dict[date, float]) -> float:
    """7-day median resting HR ending `day`; fallback 60-day median; fallback 60."""
    for window in (7, 60):
        values = [rhr_by_date[d] for i in range(window) if (d := day - timedelta(days=i)) in rhr_by_date]
        med = rolling_median(values)
        if med is not None:
            return med
    return 60.0


def configured_float(config: dict, key: str, default: float) -> float:
    """Read a numeric setting, defaulting only for a missing/NULL value."""
    value = config.get(key)
    return float(default if value is None else value)


def run(full: bool) -> None:
    sb = db.client()
    config = db.fetch_user_config(sb)
    tz = ZoneInfo(config.get("timezone") or "UTC")
    now = datetime.now(timezone.utc)

    daily_metrics = db.fetch_daily_metrics(sb)
    rhr_by_date = {
        date.fromisoformat(r["date"]): float(r["resting_hr"])
        for r in daily_metrics
        if r["resting_hr"] is not None
    }
    hrv_by_date = {
        date.fromisoformat(r["date"]): float(r["hrv_sdnn_ms"])
        for r in daily_metrics
        if r["hrv_sdnn_ms"] is not None
    }

    # ---- hr_max: init from observed history, raise when exceeded ----
    all_workouts = db.fetch_workouts(sb, None)
    if not all_workouts:
        print("no workouts; nothing to compute")
        return
    observed_max = max((int(w["max_hr"]) for w in all_workouts if w["max_hr"] is not None), default=0)
    configured_hr_max = config.get("hr_max")
    hr_max = int(configured_hr_max) if configured_hr_max is not None else None
    if (hr_max is None or hr_max <= 0) and observed_max <= 0:
        print("no valid hr_max; deferring metrics until a positive setting or observation exists")
        return
    if hr_max is None or hr_max <= 0 or observed_max > hr_max:
        action = "initialized" if hr_max is None or hr_max <= 0 else "raised"
        print(f"hr_max {action} to {observed_max}")
        hr_max = observed_max
        db.update_hr_max(sb, hr_max)

    # ---- per-workout metrics (window) ----
    since = None if full else (now - timedelta(days=RECOMPUTE_DAYS)).isoformat()
    window_workouts = db.fetch_workouts(sb, since)
    window_workout_ids = [w["id"] for w in window_workouts]
    samples_by_workout = db.fetch_hr_samples(sb, window_workout_ids)
    swim_sets_by_workout = db.fetch_swim_sets(sb, window_workout_ids)
    swim_offset = configured_float(config, "swim_hr_offset", -10)
    z2_low = configured_float(config, "zone2_low_frac", 0.60)
    z2_high = configured_float(config, "zone2_high_frac", 0.70)

    computed_rows = []
    for w in window_workouts:
        samples = samples_by_workout.get(w["id"], [])
        day = local_date(w["start_at"], tz)
        bounds = zone_bounds(hr_max, rhr_recent_for(day, rhr_by_date), z2_low, z2_high)
        is_swim = bool(w["type"]) and "swim" in w["type"].lower()
        tiz = time_in_zones(samples, bounds, swim_hr_offset=swim_offset if is_swim else 0.0)
        swim_sets = swim_sets_by_workout.get(w["id"], []) if is_swim else []
        eligible = (
            swim_ef_eligibility(w["type"], swim_sets, samples, bounds, swim_offset)
            if is_swim
            else ef_eligibility(w["type"], tiz, w["duration_s"])
        )
        efficiency = None
        drift = None
        if eligible:
            if is_swim:
                efficiency = swim_active_ef(swim_sets, samples)
                drift = swim_active_hr_drift_pct(swim_sets, samples)
            else:
                efficiency = ef(w["distance_m"], w["duration_s"], w["avg_hr"])
                drift = hr_drift_pct(samples)
        computed_rows.append(
            {
                "workout_id": w["id"],
                "time_in_zones": {f"z{z}": s for z, s in tiz.items()},
                "trimp": round(trimp_edwards(tiz), 2),
                "ef": efficiency,
                "decoupling_pct": drift,
                "hrr60": hrr60(samples, w["duration_s"]),
                "computed_at": now.isoformat(),
            }
        )
    db.upsert_computed_workouts(sb, computed_rows)
    print(f"computed_workout: {len(computed_rows)} rows")

    # ---- daily chain (always full history) ----
    # The daily CTL/ATL/ACWR chain spans ALL history, but per-workout metrics only
    # recompute over the RECOMPUTE_DAYS window (unless --full). Seed trimp from the
    # STORED computed_workout.trimp for every workout, then overlay this run's fresh
    # window on top. Seeding only from `computed_rows` (the window) zeroed every
    # pre-window workout's TRIMP each nightly run — silently rewriting all older
    # computed_daily rows (and their CTL/ATL/ACWR) to 0. (Regression:
    # test_incremental_chain_preserves_prewindow_trimp.)
    trimp_by_id = {
        r["workout_id"]: float(r["trimp"])
        for r in db.fetch_computed_workouts(sb)
        if r.get("trimp") is not None
    }
    trimp_by_id.update({r["workout_id"]: r["trimp"] for r in computed_rows})
    trimp_by_date: dict[date, float] = defaultdict(float)
    workouts_by_week: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for w in all_workouts:
        day = local_date(w["start_at"], tz)
        trimp_by_date[day] += trimp_by_id.get(w["id"], 0.0)
        iso = day.isocalendar()
        workouts_by_week[(iso.year, iso.week)].append(w)

    first_day = min(min(trimp_by_date), min(rhr_by_date, default=min(trimp_by_date)))
    today = now.astimezone(tz).date()
    days = [first_day + timedelta(days=i) for i in range((today - first_day).days + 1)]
    trimps = [trimp_by_date.get(d, 0.0) for d in days]
    load_series = ctl_atl_series(trimps)

    weekly_min = config.get("weekly_min_sessions") or {}

    def week_missed(day: date) -> bool:
        if not weekly_min:
            return False
        prev = (day - timedelta(days=7)).isocalendar()
        prev_workouts = workouts_by_week.get((prev.year, prev.week), [])
        if (day - timedelta(days=7)) < first_day:
            return False  # no data for that week at all — not a miss
        return any(
            sum(1 for w in prev_workouts if goal_matches(w["type"], goal)) < int(minimum)
            for goal, minimum in weekly_min.items()
            if int(minimum) > 0
        )

    daily_rows = []
    rhr_dev_history: dict[date, float | None] = {}
    for i, day in enumerate(days):
        rhr_baseline = rolling_median(
            [rhr_by_date[d] for j in range(60) if (d := day - timedelta(days=j)) in rhr_by_date]
        )
        rhr_recent = rolling_median(
            [rhr_by_date[d] for j in range(7) if (d := day - timedelta(days=j)) in rhr_by_date]
        )
        rhr_dev = (rhr_recent - rhr_baseline) if rhr_recent is not None and rhr_baseline is not None else None
        rhr_dev_history[day] = rhr_dev
        hrv_baseline = rolling_median(
            [hrv_by_date[d] for j in range(60) if (d := day - timedelta(days=j)) in hrv_by_date]
        )
        hrv_recent = rolling_median(
            [hrv_by_date[d] for j in range(7) if (d := day - timedelta(days=j)) in hrv_by_date]
        )
        hrv_dev = (hrv_recent - hrv_baseline) if hrv_recent is not None and hrv_baseline is not None else None

        ctl, atl = load_series[i]
        acwr_value = acwr(trimps, i)
        flags = flags_for_day(
            acwr_value,
            [rhr_dev_history.get(day - timedelta(days=j)) for j in (2, 1, 0)],
            week_missed(day),
        )
        daily_rows.append(
            {
                "date": day.isoformat(),
                "trimp_total": round(trimps[i], 2),
                "ctl": round(ctl, 3),
                "atl": round(atl, 3),
                "tsb": round(ctl - atl, 3),
                "acwr": round(acwr_value, 3) if acwr_value is not None else None,
                "rhr_baseline_60d": rhr_baseline,
                "rhr_dev": rhr_dev,
                "hrv_baseline_60d": hrv_baseline,
                "hrv_dev": hrv_dev,
                "flags": flags,
                "computed_at": now.isoformat(),
            }
        )
    db.upsert_computed_daily(sb, daily_rows)
    print(f"computed_daily: {len(daily_rows)} rows ({days[0]} → {days[-1]})")

    # ---- insights (SPEC §5.4) ----
    run_insights(sb, all_workouts, daily_metrics, daily_rows, tz)

    # ---- Zone 2 fitness model (docs/zone2-fitness-model.md) ----
    run_zone2_fitness(sb, all_workouts, daily_metrics, daily_rows, days, tz, now)

    # ---- goal progress (AI-authored metric_sql, evaluated read-only) ----
    run_goals(sb)

    # ---- reverse-geocode workout start coordinates (offline, idempotent) ----
    run_geocoding(sb)


def perf_series_by_date(all_workouts, perf_by_id, tz) -> dict[date, dict[str, list[float]]]:
    """Per-day decoupling / HRR60 readings collected over that day's workouts.

    EF stays descriptive at workout level. In addition to having incomparable
    units across sports, swim EF confounds technique reacquisition with aerobic
    state; a larger n does not resolve that identification problem. Decoupling
    and HRR60 are relative/HR-domain quantities and remain cross-sport."""
    perf_by_date: dict[date, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for w in all_workouts:
        perf = perf_by_id.get(w["id"])
        if not perf:
            continue
        day = local_date(w["start_at"], tz)
        for key, col in (("decoupling_pct", "decoupling"), ("hrr60", "hrr60")):
            if perf[key] is None:
                continue
            perf_by_date[day][col].append(float(perf[key]))
    return perf_by_date


def sleep_midpoint_hours(row: dict, tz) -> float | None:
    """Actual sleep midpoint expressed as hours on the wake-date local clock.

    Compute the midpoint on the UTC timeline first. Arithmetic between two
    datetimes carrying the same ZoneInfo object uses wall-clock semantics across
    a DST transition, which can shift this value by 30 minutes.
    """
    if not row.get("sleep_start") or not row.get("sleep_end"):
        return None
    start = datetime.fromisoformat(row["sleep_start"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(row["sleep_end"].replace("Z", "+00:00"))
    if end.timestamp() <= start.timestamp():
        return None
    midpoint_ts = start.timestamp() + (end.timestamp() - start.timestamp()) / 2
    midpoint_local = datetime.fromtimestamp(midpoint_ts, tz)
    wake_local = end.astimezone(tz)
    day_offset = (midpoint_local.date() - wake_local.date()).days
    clock_hours = (
        midpoint_local.hour
        + midpoint_local.minute / 60
        + midpoint_local.second / 3600
        + midpoint_local.microsecond / 3_600_000_000
    )
    return day_offset * 24 + clock_hours


def sleep_awake_fraction(row: dict) -> float | None:
    """Apple sleep-stage awake time divided by total staged time."""
    stages = row.get("sleep_stages") or {}
    try:
        values = [float(stages[name]) for name in ("awake", "core", "deep", "rem")]
    except (KeyError, TypeError, ValueError):
        return None
    total = sum(values)
    return values[0] / total if total > 0 else None


def wake_clock_hours(row: dict, tz) -> float | None:
    if not row.get("sleep_end"):
        return None
    wake = datetime.fromisoformat(row["sleep_end"].replace("Z", "+00:00")).astimezone(tz)
    return wake.hour + wake.minute / 60 + wake.second / 3600


def build_daily_insight_frame(daily_metrics, daily_rows, tz):
    """Build the temporal-contract daily frame without database writes."""
    import pandas as pd

    from metrics.insights import prior_rolling_deviation, weight_series

    dm_by_date = {date.fromisoformat(row["date"]): row for row in daily_metrics}
    index = [date.fromisoformat(row["date"]) for row in daily_rows]
    frame = pd.DataFrame(
        {
            "sleep_duration": [
                (dm_by_date.get(day) or {}).get("sleep_duration_min") for day in index
            ],
            "sleep_midpoint": [
                sleep_midpoint_hours(dm_by_date[day], tz) if day in dm_by_date else None
                for day in index
            ],
            "sleep_awake_fraction": [
                sleep_awake_fraction(dm_by_date[day]) if day in dm_by_date else None
                for day in index
            ],
            "wake_hour": [
                wake_clock_hours(dm_by_date[day], tz) if day in dm_by_date else None
                for day in index
            ],
            "respiratory_rate": [
                (dm_by_date.get(day) or {}).get("respiratory_rate") for day in index
            ],
            # computed_daily carries rolling deviations across missing sensor
            # days. A carried value is useful for display/flags but is not a new
            # inferential observation, so require the underlying measurement.
            "rhr_dev": [
                row["rhr_dev"]
                if (dm_by_date.get(day) or {}).get("resting_hr") is not None else None
                for day, row in zip(index, daily_rows)
            ],
            "hrv_dev": [
                row["hrv_dev"]
                if (dm_by_date.get(day) or {}).get("hrv_sdnn_ms") is not None else None
                for day, row in zip(index, daily_rows)
            ],
            "ctl": [row["ctl"] for row in daily_rows],
            "atl": [row["atl"] for row in daily_rows],
            "trimp_total": [row["trimp_total"] for row in daily_rows],
            "steps": [(dm_by_date.get(day) or {}).get("steps") for day in index],
        },
        index=pd.DatetimeIndex([pd.Timestamp(day) for day in index]),
    ).apply(pd.to_numeric, errors="coerce")

    # These controls contain only load state available before the modeled
    # exposure/outcome; same-day ATL/CTL includes a later workout and leaks.
    frame["trimp_prior"] = frame["trimp_total"].shift(1)
    frame["steps_prior"] = frame["steps"].shift(1)
    frame["ctl_prior"] = frame["ctl"].shift(1)
    frame["atl_prior"] = frame["atl"].shift(1)
    frame["ctl_pre_exposure"] = frame["ctl"].shift(2)
    # HAE's midnight-stamped RHR/HRV values are finalized full-day aggregates:
    # later exports revise them after same-day workouts. Only yesterday's
    # finalized aggregate is temporally available before today's session.
    frame["rhr_dev_prior"] = frame["rhr_dev"].shift(1)
    frame["hrv_dev_prior"] = frame["hrv_dev"].shift(1)

    frame["sleep_shortfall"] = -prior_rolling_deviation(frame["sleep_duration"])
    frame["sleep_midpoint_dev"] = prior_rolling_deviation(frame["sleep_midpoint"]).abs()
    frame["respiratory_rate_dev"] = prior_rolling_deviation(frame["respiratory_rate"])

    if any("weight_kg" in (row or {}) for row in daily_metrics):
        raw_weight = pd.Series(
            [(dm_by_date.get(day) or {}).get("weight_kg") for day in index],
            index=frame.index,
        )
        weight, weight_7d_slope = weight_series(raw_weight)
        frame["weight"] = weight
        frame["weight_7d_slope"] = weight_7d_slope
    return frame


def workout_modality(workout_type: str | None) -> str:
    value = (workout_type or "").lower()
    if "strength" in value or "weight" in value or "core" in value:
        return "strength"
    if "swim" in value:
        return "swim"
    if "row" in value:
        return "rowing"
    if "cycl" in value or "bik" in value:
        return "cycling"
    if "run" in value:
        return "running"
    if "walk" in value or "hik" in value:
        return "walking"
    if "surf" in value:
        return "surfing"
    return "other"


def build_workout_insight_frame(all_workouts, perf_by_id, daily_frame, tz):
    """One row per workout with measured HR load and pre-workout context."""
    import numpy as np
    import pandas as pd

    rows: list[dict] = []
    context_columns = (
        "sleep_shortfall", "sleep_midpoint_dev", "sleep_awake_fraction",
        "rhr_dev_prior", "hrv_dev_prior", "respiratory_rate_dev",
        "ctl_prior", "atl_prior", "trimp_prior",
    )
    for workout in all_workouts:
        computed = perf_by_id.get(workout["id"]) or {}
        try:
            trimp = float(computed.get("trimp"))
            duration_s = float(workout.get("duration_s"))
            zones = computed.get("time_in_zones") or {}
            zone_seconds = sum(float(zones.get(f"z{zone}") or 0.0) for zone in range(1, 6))
        except (TypeError, ValueError):
            continue
        # Tiny/zero-HR sessions make ratios unstable. Positive TRIMP also
        # excludes legacy workouts whose duration exists without measured HR.
        if trimp <= 0 or duration_s <= 0 or zone_seconds < 300:
            continue
        start = datetime.fromisoformat(workout["start_at"].replace("Z", "+00:00")).astimezone(tz)
        day_key = pd.Timestamp(start.date())
        context = daily_frame.loc[day_key] if day_key in daily_frame.index else None
        hour = start.hour + start.minute / 60 + start.second / 3600
        theta = 2.0 * math.pi * hour / 24.0
        duration_min = duration_s / 60.0
        row = {
            "start_at": pd.Timestamp(start),
            "start_hour": hour,
            "start_sin": math.sin(theta),
            "start_cos": math.cos(theta),
            "modality": workout_modality(workout.get("type")),
            "workout_load": trimp,
            "workout_duration": duration_min,
            "log_duration": math.log(duration_min),
            "workout_intensity": trimp / duration_min,
            "high_zone_fraction": (
                float(zones.get("z4") or 0.0) + float(zones.get("z5") or 0.0)
            ) / zone_seconds,
        }
        for column in context_columns:
            row[column] = context.get(column) if context is not None else np.nan
        wake_hour = context.get("wake_hour") if context is not None else np.nan
        hours_since_wake = hour - wake_hour if pd.notna(wake_hour) else np.nan
        row["hours_since_wake"] = (
            hours_since_wake if pd.notna(hours_since_wake) and 0 <= hours_since_wake <= 20
            else np.nan
        )
        rows.append(row)
    if not rows:
        return pd.DataFrame()

    frame = pd.DataFrame(rows).sort_values("start_at").set_index("start_at")
    timestamps = pd.Series(frame.index, index=frame.index)
    frame["hours_since_prev_workout"] = timestamps.diff().dt.total_seconds() / 3600.0
    frame["days_since_prev_modality"] = (
        timestamps.groupby(frame["modality"], sort=False).diff().dt.total_seconds() / 86_400.0
    )
    frame["log_hours_since_prev_workout"] = np.log1p(frame["hours_since_prev_workout"])
    frame["log_days_since_prev_modality"] = np.log1p(frame["days_since_prev_modality"])
    local_days = pd.Series([stamp.date() for stamp in frame.index], index=frame.index)
    frame["same_day_prior_load"] = (
        frame.groupby(local_days, sort=False)["workout_load"].cumsum() - frame["workout_load"]
    )
    for outcome, prior_name in (
        ("workout_load", "load_prev_modality"),
        ("workout_duration", "duration_prev_modality"),
        ("workout_intensity", "intensity_prev_modality"),
        ("high_zone_fraction", "high_zone_prev_modality"),
    ):
        frame[prior_name] = frame.groupby("modality", sort=False)[outcome].shift(1)
    modality_dummies = pd.get_dummies(
        frame["modality"], prefix="modality", drop_first=True, dtype=float
    )
    return pd.concat([frame, modality_dummies], axis=1)


def insight_prior_state(prior: dict | None, expected_version: int) -> dict | None:
    """Reuse persistence only within the exact same statistical contract."""
    diagnostics = (prior or {}).get("diagnostics") or {}
    if diagnostics.get("model_version") != expected_version:
        return None
    return ((diagnostics.get("persistence") or {}).get("state"))


def run_insights(sb, all_workouts, daily_metrics, daily_rows, tz) -> None:
    import pandas as pd

    from metrics.insights import (
        compute_correlations,
        discover_adjusted_insights,
        discover_workout_context_insights,
        zscore_trailing,
    )

    # Per-day inferential outcomes. EF remains descriptive because swim EF
    # cannot distinguish technique reacquisition from aerobic change.
    perf_by_id = {r["workout_id"]: r for r in db.fetch_computed_workouts(sb)}
    perf_by_date = perf_series_by_date(all_workouts, perf_by_id, tz)

    index = [date.fromisoformat(row["date"]) for row in daily_rows]
    frame = build_daily_insight_frame(daily_metrics, daily_rows, tz)
    frame["decoupling"] = [
        pd.Series(perf_by_date[day]["decoupling"]).mean()
        if perf_by_date[day]["decoupling"] else None
        for day in index
    ]
    frame["hrr60"] = [
        pd.Series(perf_by_date[day]["hrr60"]).mean()
        if perf_by_date[day]["hrr60"] else None
        for day in index
    ]

    correlations = compute_correlations(zscore_trailing(frame))
    db.replace_insight_correlations(sb, correlations)
    print(f"insight_correlations: {len(correlations)} pairs")

    # The finder's persistence hysteresis (promotion needs N consecutive raw-signal
    # nights) round-trips its state through the previous night's diagnostics.
    prior = db.fetch_insight_model(sb, "daily_adjusted_finder")
    prior_state = insight_prior_state(prior, expected_version=3)
    finder = discover_adjusted_insights(frame, prior_state=prior_state)
    db.upsert_insight_model(sb, finder)
    diag = finder["diagnostics"]
    print(
        "insight_models: daily_adjusted_finder "
        f"({diag['signal_count']} signals, {diag['watch_count']} watch, "
        f"{diag['raw_signal_count']} raw-signal; "
        f"placebo fired {diag['placebo']['signal_count']}/{diag['placebo']['tested']})"
    )

    workout_frame = build_workout_insight_frame(all_workouts, perf_by_id, frame, tz)
    workout_prior = db.fetch_insight_model(sb, "workout_context_finder")
    workout_prior_state = insight_prior_state(workout_prior, expected_version=3)
    workout_finder = discover_workout_context_insights(
        workout_frame, prior_state=workout_prior_state
    )
    db.upsert_insight_model(sb, workout_finder)
    workout_diag = workout_finder["diagnostics"]
    print(
        "insight_models: workout_context_finder "
        f"({workout_diag['signal_count']} signals, {workout_diag['watch_count']} watch, "
        f"{workout_diag['raw_signal_count']} raw-signal; "
        f"placebo fired {workout_diag['placebo']['signal_count']}/"
        f"{workout_diag['placebo']['tested']})"
    )

    # Retire the old EF-on-sleep row as well as stopping future computation;
    # upserts alone would otherwise leave a stale model visible indefinitely.
    db.delete_insight_model(sb, "ef_on_sleep_dlm")


def iso_weeks_spanning(days: list[date]) -> list[tuple[int, int]]:
    """Every ISO (year, week) key from the week containing days[0] through the
    week containing days[-1] — INCLUDING workout-free weeks. Feeding only weeks
    that had workouts into base_consolidation froze B across gaps (the exact bug
    class v3 was written to kill); empty weeks must contribute 0.0 minutes so B
    decays through a fully-off stretch."""
    if not days:
        return []
    monday = days[0] - timedelta(days=days[0].isocalendar().weekday - 1)
    keys: list[tuple[int, int]] = []
    d = monday
    while d <= days[-1]:
        iso = d.isocalendar()
        keys.append((iso.year, iso.week))
        d += timedelta(days=7)
    return keys


def causal_latest(
    series: list[tuple[date, float]], days: list[date]
) -> list[tuple[date, float] | None]:
    """For each day, the most recent (date, value) observation ON OR BEFORE that
    day, or None when none exists yet. `series` must be date-ascending. Keeps
    historical rows CAUSAL — a row never reads a signal from its own future, and
    a days-since-signal age can never go negative."""
    out: list[tuple[date, float] | None] = []
    j = -1
    for d in days:
        while j + 1 < len(series) and series[j + 1][0] <= d:
            j += 1
        out.append(series[j] if j >= 0 else None)
    return out


def _uncapped(horizon_days: float) -> float | None:
    """A projection horizon that hit the bisection search cap
    (Z2_DECAY_ONSET_MAX_DAYS) means "no meaningful drop inside the window"
    (state already at/near floor) — that is a STATE, not a calendar date.
    Stored as NULL so the renderer omits the marker instead of drawing a
    fake-precise day-120 date."""
    from metrics import models

    if horizon_days >= models.Z2_DECAY_ONSET_MAX_DAYS - 1e-9:
        return None
    return round(horizon_days, 2)


def run_zone2_fitness(sb, all_workouts, daily_metrics, daily_rows, days, tz, now) -> None:
    """Zone 2 fitness model v3 DYNAMIC (docs/zone2-fitness-model.md "v3 — locked
    amendments"). The headline index I = D + F, two FIXED-ceiling components:
      - D = durable base ∈ [floor_t, C_D]. LOAD-DRIVEN + DECAYING (v3 pt1): D
        tracks the slow load EWMA (builds with AEROBIC Z2 load, decays toward the
        training-age floor during gaps). The x-intercept ELEVATION signals — each
        scored as elevation above the USER'S OWN detrained baseline (v3 pt2/pt5),
        variance-inflated continuously with staleness — only CALIBRATE the
        load→score height; they do NOT pin D flat.
      - F = fast layer ∈ [0, C_F], a SATURATING map of the fast-EWMA load.
    Guidance (v3 pt6): decay_onset, maintain_horizon and build_interval are all
    PROJECTION-DERIVED from the model's own forward projection + the user's data.

    Everything time-varying is PER-DAY CAUSAL: B_t, τ_slow_t, floor_t,
    days_since_vo2max, the fusion signals and the confidence band are computed
    from data on-or-before each row's day — no historical row is stamped with
    today's state (v3 dynamic principle: no fictional history).

    ── DATA-DERIVED-CONTINUOUS vs LITERATURE PRIOR (v3 DYNAMIC principle) ──
    Data-derived-continuous: B_t (weekly aerobic Z2 minutes over ALL weeks, empty
    ones included), τ_slow(B_t), floor(B_t), the two-pass load track + calibration
    abscissa (max of the floorless track over the signal window, EWMA units),
    every x-intercept baseline (blended pop prior → personal by valid-day count),
    the fused elevation height, per-day staleness variance inflation, the
    posterior-SD confidence + band, SWC (residuals vs 7-day rolling mean), and
    all three horizons. Literature priors (marked at their constants): τ_fast,
    C_D/C_F, f_max, fast_sat, the SWC floor, staleness τ, the pop-prior baselines
    (thin-history only), rhr_top_amateur/ef_top_factor targets, the Hickson
    fallback session dose, and the 2.0 d build-cadence cap."""
    from metrics import models

    params = db.fetch_zone2_fitness_params(sb)

    def param(key: str, default):
        val = params.get(key) if params else None
        return float(val) if val is not None else default

    tau_fast = param("tau_fast_days", models.Z2_TAU_FAST_DAYS)  # [LITERATURE PRIOR]
    tau_slow_min = param("tau_slow_min_days", models.Z2_TAU_SLOW_MIN_DAYS)
    tau_slow_max = param("tau_slow_max_days", models.Z2_TAU_SLOW_MAX_DAYS)
    f_max = param("f_max", models.Z2_F_MAX)
    floor_p = param("floor_p", models.Z2_FLOOR_P)
    b_ref = param("b_ref_min_per_wk", models.Z2_B_REF_MIN_PER_WK)
    if b_ref <= 0:  # a corrupted params row must not crash/poison the nightly job
        b_ref = models.Z2_B_REF_MIN_PER_WK
    # fixed ceilings + fast saturation reference (fall back to 70/30/26).
    c_durable = param("durable_ceiling", models.ZONE2_DURABLE_CEILING)  # [LITERATURE PRIOR]
    c_fast = param("fast_ceiling", models.ZONE2_FAST_CEILING)           # [LITERATURE PRIOR]
    fast_sat = param("fast_sat", models.ZONE2_FAST_SAT)
    vo2_top = param("anchor_vo2_100", models.Z2_ANCHOR_VO2_100)  # FRIEND 90th pct
    # Top-amateur elevation targets — real params columns now; code defaults as
    # fallback (citations at the constants in models.py).
    rhr_top_amateur = param("rhr_top_amateur", models.Z2_RHR_TOP_AMATEUR)
    ef_top_factor = param("ef_top_factor", models.Z2_EF_TOP_FACTOR)
    run_ef_variance = param("run_ef_variance", models.Z2_RUN_EF_VARIANCE)
    stage = (params.get("stage") if params else None) or "literature"

    # ---- daily Zone-2 load w(t) from computed_workout.time_in_zones (spec §1),
    # AEROBIC MODALITIES ONLY. Strength/core (and yoga/pilates) sessions push HR
    # into the Z2 band via the pressor response and sympathetic drive, not via
    # sustained cardiac output + muscle O2 flux — no capillary/mitochondrial
    # stimulus, so they must not feed w(t), the intensity-correct session count,
    # or B's weekly minutes (weight-room time can otherwise dominate "Z2 minutes"). ----
    zones_by_id = db.fetch_computed_workout_zones(sb)
    w_by_date: dict[date, float] = defaultdict(float)
    # intensity-correct Z2 session dates for maintenance accounting (spec §1/§5a)
    z2_session_dates: dict[date, int] = defaultdict(int)
    weekly_z2_min: dict[tuple[int, int], float] = defaultdict(float)
    for wk in all_workouts:
        if not models.is_aerobic_modality(wk.get("type")):
            continue
        tiz = zones_by_id.get(wk["id"])
        if not tiz:
            continue
        day = local_date(wk["start_at"], tz)
        w_by_date[day] += z2_trimp_from_zones(tiz)
        # INTENTIONAL weighting difference (F8, do-not-change): B's weekly minutes
        # (aerobic_sec) count z3 at FULL weight, whereas the graded stimulus w(t)
        # (z2_trimp_from_zones) HALF-credits z3. These measure different things and
        # are calibrated as such: B = total AEROBIC VOLUME including tempo (b_ref was
        # calibrated against z2+z3 minutes), so a tempo minute is a minute of base;
        # w(t) = the GRADED build stimulus, where a z3 minute is discounted because
        # above the Z2 band it stops being a pure Zone-2 stimulus. Do not "unify"
        # them — b_ref and the w(t) map are each calibrated to their own definition.
        aerobic_sec = float(tiz.get("z2", 0) or 0) + float(tiz.get("z3", 0) or 0)
        # Intensity gate (spec §1): ≥20 min in the aerobic band. The spec's second
        # clause (≥20 min at/above the Z2 lower bound) is the SAME quantity — all
        # z2+z3 time is by construction at/above the Z2 lower bound.
        if aerobic_sec >= 20 * 60:
            z2_session_dates[day] += 1
        iso = day.isocalendar()
        weekly_z2_min[(iso.year, iso.week)] += aerobic_sec / 60.0

    daily_z2_load = [w_by_date.get(d, 0.0) for d in days]

    # ---- per-day CAUSAL B_t, τ_slow_t, floor_t (spec §3 + v3) over the FULL
    # weekly axis: every ISO week in range contributes (0.0 when workout-free) so
    # B decays through an off-gap. Each day is stamped with B as of the PREVIOUS
    # COMPLETED week (b_by_week[i-1] for a day in week i). Stamping the day's OWN
    # week (b_by_week[i]) was intra-week LOOKAHEAD: that week's B already contains
    # minutes from workouts LATER in the same week, so a Monday read Saturday's
    # session — a causal-track violation (the module's "no fictional history"
    # contract). The first week (i=0) has no completed predecessor → B seeds at 0.0
    # (brand-new, exactly as base_consolidation_series seeds). ----
    week_keys = iso_weeks_spanning(days)
    weekly_series = [weekly_z2_min.get(k, 0.0) for k in week_keys]
    b_by_week = models.base_consolidation_series(weekly_series, b_ref=b_ref)
    week_index = {k: i for i, k in enumerate(week_keys)}
    b_t: list[float] = []
    for d in days:
        iso = d.isocalendar()
        wi = week_index[(iso.year, iso.week)]
        b_t.append(b_by_week[wi - 1] if wi > 0 else 0.0)
    tau_slow_t = [models.tau_slow(b, tau_min=tau_slow_min, tau_max=tau_slow_max) for b in b_t]

    # ---- v4.2 NEAT floor: a per-day CAUSAL EWMA of daily steps raises the durable
    # FLOOR (ambient activity MAINTAINS the base, it doesn't build it — so it feeds
    # the floor, never w(t)). Missing-steps days carry the EWMA forward rather than
    # faking a sedentary day; the EWMA seeds at the first real reading (no 0-ramp). ----
    steps_by_date = {
        date.fromisoformat(r["date"]): float(r["steps"])
        for r in daily_metrics if r.get("steps") is not None
    }
    alpha_neat = 1.0 - math.exp(-1.0 / models.Z2_NEAT_STEPS_TAU_DAYS)
    steps_ewma = 0.0
    seeded = False
    neat_pct_t: list[float] = []
    for d in days:
        s = steps_by_date.get(d)
        if s is not None:
            steps_ewma = s if not seeded else steps_ewma + alpha_neat * (s - steps_ewma)
            seeded = True
        neat_pct_t.append(models.neat_floor_score(steps_ewma) if seeded else 0.0)

    # floor as a [0,100] share = training-age floor (from B) + NEAT activity floor,
    # capped at 100; the D-space floor is the same share of C_D.
    floor_pct_t = [
        min(100.0, models.durable_floor_score(b, f_max=f_max, p=floor_p) + neat)
        for b, neat in zip(b_t, neat_pct_t)
    ]
    floor_d_t = [
        models.durable_score_from_percentile(fp, durable_ceiling=c_durable) for fp in floor_pct_t
    ]

    # ---- two-pass calibration abscissa (EWMA units) + the two EWMA compartments
    # (spec §2). Pass 1: a provisional FLOORLESS track; calib_load = its MAX over
    # the trailing 180 d (the signal window) — "at your most-recently-trained
    # SMOOTHED load, your height is what the signals imply." (The old 90th-pctile
    # SINGLE-DAY load is a level the EWMA only reaches by training that load every
    # day; a steady 3×/wk trainer permanently read under half of their signals.) The floor
    # is then a share of the SAME EWMA-unit reference, so a maintenance dose can
    # actually sustain it. Pass 2: the real track with per-day causal floors. ----
    provisional = models.z2_durable_sharpness_series(
        daily_z2_load, tau_fast=tau_fast, tau_slow_days=tau_slow_t, floor_load=0.0
    )
    calib_load = max((d for d, _ in provisional[-180:]), default=0.0)
    calib_load = max(calib_load, 1e-6)  # guard: zero-history slope degenerates
    floor_load_t = [fp / 100.0 * calib_load for fp in floor_pct_t]
    series = models.z2_durable_sharpness_series(
        daily_z2_load, tau_fast=tau_fast, tau_slow_days=tau_slow_t, floor_load=floor_load_t
    )
    durable_load_track = [d for d, _ in series]

    # =====================================================================
    # v3 X-INTERCEPT ELEVATION with PERSONAL baselines (v3 pt2 + pt5).
    # Each signal scored as elevation above the USER'S OWN detrained baseline,
    # blending toward a population prior ONLY while personal history is thin.
    # baseline → 0, top-amateur → C_D. Aerobic-specific signals lead (v3 pt3).
    # Per-day CAUSAL: each row fuses the signals known on-or-before its day,
    # variance-inflated continuously with each signal's age (spec §4c).
    # =====================================================================
    perf_by_id = {r["workout_id"]: r for r in db.fetch_computed_workouts(sb)}
    # Bike and RUN EF as two SEPARATE aerobic-specific signals (each its own
    # baseline/top/variance — running and cycling EF are incomparable units). Swim
    # EF stays WITHHELD: active-set filtering removes rest bias, but returning
    # technique can still dominate pace/HR even with a large N (docs §6). Both remain
    # fully wired whatever today's data holds — signals are built for data the user
    # may START producing, never trimmed to what currently exists: bike EF lights
    # up with the first outdoor GPS ride, run EF with the first ≥20-min HR-bearing
    # Z1–Z2 run (v5: rides so far are indoor/no-distance, runs are the nearer signal).
    bike_ef_obs: list[tuple[date, float]] = []
    run_ef_obs: list[tuple[date, float]] = []
    for wk in all_workouts:
        perf = perf_by_id.get(wk["id"])
        if not perf or perf.get("ef") is None:
            continue
        wtype = (wk.get("type") or "").lower()
        if "cycl" in wtype or "bik" in wtype:
            bike_ef_obs.append((local_date(wk["start_at"], tz), float(perf["ef"])))
        elif "run" in wtype:
            run_ef_obs.append((local_date(wk["start_at"], tz), float(perf["ef"])))
    bike_ef_obs.sort()
    run_ef_obs.sort()

    # Raw per-date RHR / VO2max for personal detrained extremes (trailing ~180d).
    rhr_series = [
        (date.fromisoformat(r["date"]), float(r["resting_hr"]))
        for r in daily_metrics if r.get("resting_hr") is not None
    ]
    vo2_series = [
        (date.fromisoformat(r["date"]), float(r["vo2max"]))
        for r in daily_metrics if r.get("vo2max") is not None
    ]
    today = days[-1]
    window_start = today - timedelta(days=180)
    rhr_window = [v for d, v in rhr_series if d >= window_start]
    vo2_window = [v for d, v in vo2_series if d >= window_start]

    # PERSONAL baselines = the user's OWN most-detrained extreme (v3 pt5):
    #   RHR baseline  = MAX resting HR (highest = most detrained)
    #   VO2max baseline = MIN VO2max   (lowest  = most detrained)
    #   EF baseline   = earliest/most-detrained EF (first observed)
    #
    # F4 fix — RATCHET (only widen, never shrink): the trailing-180d window forgets
    # the true detrained extreme once the user sustains training, so max/min drift
    # trained-ward and the elevation score self-deflates. Persist LIFETIME extremes
    # in the params row's `fitted_from` jsonb (a widen-only store): the baseline is
    # the more-detrained of {stored lifetime extreme, this window's extreme}, and
    # the blend's valid-day count likewise ratchets (max of stored/window) so it
    # never re-inflates the population prior after a season of data.
    stored = (params.get("fitted_from") if params else None) or {}
    rhr_window_max = max(rhr_window) if rhr_window else None
    vo2_window_min = min(vo2_window) if vo2_window else None

    def _widen(stored_val, window_val, wider):
        vals = [v for v in (stored_val, window_val) if v is not None]
        return wider(vals) if vals else None

    rhr_personal_baseline = _widen(stored.get("rhr_lifetime_max"), rhr_window_max, max)
    vo2_personal_baseline = _widen(stored.get("vo2_lifetime_min"), vo2_window_min, min)
    bike_ef_personal_baseline = bike_ef_obs[0][1] if bike_ef_obs else None
    run_ef_personal_baseline = run_ef_obs[0][1] if run_ef_obs else None

    # valid-day counts ratchet too (widen-only) so the personal baseline's weight
    # never falls back toward the population prior once a season of data exists.
    rhr_valid_days = max(int(stored.get("rhr_valid_days") or 0), len(rhr_window))
    vo2_valid_days = max(int(stored.get("vo2_valid_days") or 0), len(vo2_window))

    # Persist the widened lifetime store (skip when nothing changed to avoid a
    # needless write). Guarded — a params-write failure must never fail the job.
    new_fitted = dict(stored)
    if rhr_personal_baseline is not None:
        new_fitted["rhr_lifetime_max"] = rhr_personal_baseline
    if vo2_personal_baseline is not None:
        new_fitted["vo2_lifetime_min"] = vo2_personal_baseline
    new_fitted["rhr_valid_days"] = rhr_valid_days
    new_fitted["vo2_valid_days"] = vo2_valid_days
    if new_fitted != stored:
        try:
            db.update_zone2_fitted_from(sb, new_fitted)
        except Exception as e:  # noqa: BLE001 — a params write must not fail the job
            print(f"zone2_fitness_params.fitted_from: skipped ({e})")

    # Population priors, used ONLY to seed the baseline while history is thin; their
    # weight → 0 as valid days accrue (v3 pt5: no fixed 68/32 once own data exists).
    rhr_baseline = models.blended_baseline(
        rhr_personal_baseline, models.Z2_RHR_POP_BASELINE, valid_days=rhr_valid_days
    )
    vo2_baseline = models.blended_baseline(
        vo2_personal_baseline, models.Z2_VO2MAX_POP_BASELINE, valid_days=vo2_valid_days
    )
    # Top-amateur EF ≈ ef_top_factor × the user's own detrained baseline (economy
    # improves ~40-60% baseline→trained; a personal, not fixed, target). Bike and
    # run each get their OWN top from their OWN baseline (incomparable units).
    ef_top_amateur = (
        bike_ef_personal_baseline * ef_top_factor if bike_ef_personal_baseline else None
    )
    run_ef_top_amateur = (
        run_ef_personal_baseline * ef_top_factor if run_ef_personal_baseline else None
    )

    # Last-known observation per signal ON OR BEFORE each day (None before the first).
    rhr_latest_t = causal_latest(rhr_series, days)
    vo2_latest_t = causal_latest(vo2_series, days)
    bike_latest_t = causal_latest(bike_ef_obs, days)
    run_latest_t = causal_latest(run_ef_obs, days)

    # ---- the LEVEL fusion (v4 redesign) — absolute D-space variances, each ×
    # per-day staleness inflation (documented derivations at the constants in
    # models.py):
    #   run EF (var 22)      — the aerobic-specific calibration signal that ACTUALLY
    #     fires (v5): runs carry distance + HR. The trusted LEAD in practice.
    #   bike EF (var 22)     — the DOCUMENTED aerobic LEAD (v3 pt3), but structurally
    #     unobtainable without ride distance (indoor rides → 0 observations). Kept
    #     wired IF distance ever appears; run EF is what leads today.
    #   watch VO2max (196)   — low-weight occasional calibration.
    #   B-prior (C_D·B_t, (C_D/4)²) — ALWAYS present: the load history itself is
    #     the default level-setter (B=1 ≡ the consolidated club-level base the
    #     C_D anchor describes; B=0 ≡ nothing banked), so with no trusted aerobic
    #     signal a sparse Zone-2 trainer reads LOW (v3 pt1), with an honest wide
    #     band. Any fresh bike EF dominates it (22 ≪ 306).
    #   RHR — deliberately EXCLUDED from the level: corroborator, not
    #     level-setter (v3 pt3: strength-training-confounded; it must never
    #     anchor the height). Still computed per-day for provenance and it still
    #     feeds evidence_state via rhr_dev as before.
    var_b_prior = (c_durable * models.Z2_B_PRIOR_SD_FRACTION) ** 2

    def level_estimates(i: int) -> dict[str, tuple[float, float]]:
        """{signal: (level estimate in D-space, variance)} fused for day i."""
        out: dict[str, tuple[float, float]] = {}
        obs = run_latest_t[i]
        if obs is not None and run_ef_top_amateur is not None:
            elev = models.signal_elevation_score(
                obs[1], run_ef_personal_baseline, run_ef_top_amateur, ceiling=c_durable
            )
            if elev is not None:
                age = (days[i] - obs[0]).days
                out["run_ef"] = (
                    elev,
                    models.staleness_inflated_variance(run_ef_variance, age),
                )
        obs = bike_latest_t[i]
        if obs is not None and ef_top_amateur is not None:
            elev = models.signal_elevation_score(
                obs[1], bike_ef_personal_baseline, ef_top_amateur, ceiling=c_durable
            )
            if elev is not None:
                age = (days[i] - obs[0]).days
                out["bike_ef"] = (
                    elev,
                    models.staleness_inflated_variance(models.Z2_BIKE_EF_VARIANCE, age),
                )
        obs = vo2_latest_t[i]
        if obs is not None:
            elev = models.signal_elevation_score(obs[1], vo2_baseline, vo2_top, ceiling=c_durable)
            if elev is not None:
                age = (days[i] - obs[0]).days
                out["vo2max"] = (
                    elev,
                    models.staleness_inflated_variance(models.Z2_VO2MAX_VARIANCE, age),
                )
        # the B-prior needs no staleness term: B_t is recomputed from the load
        # history every day, so it is always exactly as fresh as the data.
        out["b_prior"] = (c_durable * b_t[i], var_b_prior)
        return out

    def rhr_elevation(i: int) -> float | None:
        """RHR elevation in D-space — corroborator, NOT level-setter (v3 pt3:
        strength-confounded). Computed for provenance only; never fused."""
        obs = rhr_latest_t[i]
        if obs is None:
            return None
        return models.signal_elevation_score(
            obs[1], rhr_baseline, rhr_top_amateur, ceiling=c_durable, higher_is_fitter=False
        )

    # ---- v3 pt1: DURABLE D as a LOAD-DRIVEN, DECAYING series. TODAY's fusion
    # CALIBRATES the load→score height (the slope is a current-state scale);
    # motion is load-driven, so a gap decays D toward floor_d even with the
    # elevation signals held favorable. The B-prior makes the fusion always
    # non-empty, so the calibration-less fallback (slope 0 → D reads the earned
    # floor track) is now an unreachable guard — kept as a guard. ----
    fused_today = models.fuse_inverse_variance(list(level_estimates(len(days) - 1).values()))
    calib_score = fused_today[0] if fused_today is not None else None  # D-space height
    durable_base_track = models.durable_base_series(
        durable_load_track,
        floor_d=floor_d_t,
        ceiling=c_durable,
        calib_load=calib_load if calib_score is not None else None,
        calib_score=calib_score,
        floor_load=floor_load_t,  # load track's floor maps to the earned D-floor
    )
    calib_slope = models.durable_calibration_slope(
        floor_d_t[-1],
        floor_load_t[-1],
        calib_load=calib_load if calib_score is not None else None,
        calib_score=calib_score,
    )

    # ---- injury / plan hold suppression (spec §5c.4) ----
    holds = db.fetch_active_injury_holds(sb)
    hold_active = holds["active_injuries"] > 0 or holds["active_constraints"] > 0

    # maintenance_met per day: ≥2 intensity-correct Z2 sessions in trailing 7d (spec §5a)
    def maintenance_met_for(day: date) -> bool:
        return sum(z2_session_dates.get(day - timedelta(days=j), 0) for j in range(7)) >= 2

    # SD of a flat prior over [0, C_D] — the "knowing nothing" spread the fused
    # posterior is measured against (uniform-distribution SD = range/√12).
    prior_sd = c_durable / math.sqrt(12.0)

    # ---- per-day rows ----
    rows = []
    unmet_run = 0  # consecutive maintenance-unmet days ending at each day
    for i, day in enumerate(days):
        durable_load, sharp_load = series[i]
        durable_base = durable_base_track[i]

        met = maintenance_met_for(day)
        unmet_run = 0 if met else unmet_run + 1

        # ---- FAST F ∈ [0, C_F]: saturating map of the fast-EWMA load. ----
        sharpness = models.fast_score_from_load(sharp_load, fast_ceiling=c_fast, fast_sat=fast_sat)
        index = durable_base + sharpness  # I = D + F ∈ [0, 100]

        # ---- confidence + band from THIS day's staleness-inflated fusion (§6c):
        # posterior SD vs the flat prior — continuous, data-derived. Computed
        # FIRST because the v4 "eases" horizon is GATED by this band (erosion is
        # only flagged once it exceeds what the model can resolve). With only the
        # soft B-prior in the fusion, posterior_sd ≈ C_D/4 → LOW confidence + WIDE
        # band — the honesty: no aerobic-specific anchor exists yet. ----
        ests = level_estimates(i)
        rhr_elev = rhr_elevation(i)  # corroborator, never fused (v3 pt3)
        fused = models.fuse_inverse_variance(list(ests.values()))
        # a fusion that includes the flat prior can never exceed the prior's SD
        posterior_sd = min(fused[1], prior_sd) if fused is not None else prior_sd
        confidence = models.confidence_from_posterior(posterior_sd, prior_sd)
        half_width = min(1.96 * posterior_sd, models.ZONE2_INDEX_CEILING)  # 95% band
        band_lo = max(0.0, index - half_width)
        band_hi = min(models.ZONE2_INDEX_CEILING, index + half_width)

        # ---- v4 "eases" horizon: erosion of the DURABLE BASE (not the fast
        # layer), flagged only once projected loss exceeds the confidence band
        # (docs v4). This removes the v3 inversion where the horizon was SHORTEST
        # right after training (a big fast layer to shed) and blanked out when
        # detrained. durable_erosion_onset returns the search cap when the base
        # cannot lose a full band → _uncapped() → NULL, no marker (the thin-base
        # "nothing banked to protect yet, just build" state). ----
        eases_onset = models.durable_erosion_onset_days(
            durable=durable_base,
            floor=floor_d_t[i],
            tau_slow_days=tau_slow_t[i],
            band_half_width=half_width,
        )
        in_building_phase = eases_onset >= models.Z2_DECAY_ONSET_MAX_DAYS - 1e-9

        # ---- v4 build cadence: CONTINUOUS in B (docs v4), replacing the v3
        # min(fast-decay, 2.0) whose 2.0 cap always bound for a detrained user.
        # B=novice → ~2.3 d (3×/wk); shortens as B banks; floored at the 24 h
        # molecular re-stimulation window. ----
        build_interval = models.build_cadence_days(b_t[i])

        # ---- maintain horizon: the last day one expected session still holds
        # today's level (index drop ≥ one session's build increment ΔI). w̄ =
        # median stimulus of qualifying-session days in the trailing τ_slow(B_t)
        # window (data-linked); Hickson fallback inside. ----
        horizon_window = max(1, int(round(tau_slow_t[i])))
        qualifying_loads = [
            daily_z2_load[j]
            for j in range(max(0, i - horizon_window + 1), i + 1)
            if z2_session_dates.get(days[j], 0) > 0
        ]
        w_bar = models.expected_session_stimulus(qualifying_loads)
        delta_i, _delta_f = models.expected_session_build(
            durable_load,
            sharp_load,
            w_bar,
            slope=calib_slope,
            floor_d=floor_d_t[i],
            floor_load=floor_load_t[i],
            tau_slow_days=tau_slow_t[i],
            tau_fast=tau_fast,
            durable_ceiling=c_durable,
            fast_ceiling=c_fast,
            fast_sat=fast_sat,
        )
        maintain_horizon = models.decay_onset_days(
            durable=durable_base,
            fast=sharpness,
            floor=floor_d_t[i],
            tau_slow_days=tau_slow_t[i],
            swc=max(0.0, delta_i),
            tau_fast=tau_fast,
        )

        # per-day CAUSAL vo2 provenance: most recent reading on-or-before this day
        # (None before the first — never negative days-since).
        vo2_obs = vo2_latest_t[i]
        days_since = (day - vo2_obs[0]).days if vo2_obs is not None else None
        vo2max_anchor_score = (
            models.vo2max_to_score(vo2_obs[1]) if vo2_obs is not None else None
        )

        # ---- evidence_state (spec §6d) — a categorical LABEL (the numbers stay
        # continuous); counts corroborating signals present around this day.
        # RHR still feeds this exactly as before (via rhr_dev) — demoted from the
        # LEVEL, not from the evidence accounting. ----
        drow = daily_rows[i]
        load_moved = any(w > 0 for w in daily_z2_load[max(0, i - 6): i + 1])
        valid_signals = 0
        if load_moved:
            valid_signals += 1
        if "run_ef" in ests or "bike_ef" in ests:
            valid_signals += 1  # aerobic-specific efficiency present (leads)
        if drow.get("rhr_dev") is not None:
            valid_signals += 1
        if drow.get("hrv_dev") is not None:
            valid_signals += 1

        # measured level signals = the fusion minus the always-present B-prior.
        # §6d low_confidence = the watch is the ONLY measured level signal AND
        # no autonomic corroboration exists that day ("only mover is watch
        # VO2max with no RHR/HRV/EF corroboration"). With RHR/HRV present the
        # state is 'ok' — the wide band + low confidence NUMBER carry the
        # honesty continuously; the label is only for the uncorroborated case.
        level_signals = set(ests) - {"b_prior"}
        corroborated = drow.get("rhr_dev") is not None or drow.get("hrv_dev") is not None
        if valid_signals < 2:
            evidence_state = "insufficient"
        elif level_signals == {"vo2max"} and not corroborated:
            evidence_state = "low_confidence"  # watch-only, uncorroborated (§6d)
        else:
            evidence_state = "ok"

        # ---- zone2_maintenance flag (spec §5c): only meaningful in the
        # MAINTENANCE PHASE — a base worth protecting exists (eases_onset is a real
        # horizon, not the search cap). In the building phase there is nothing
        # banked to erode, so no flag. Persistence threshold is the erosion horizon
        # itself; the fire rule still reads F/C_F vs D/C_D, never the sum. ----
        if in_building_phase:
            flags = []
        else:
            flags = models.zone2_maintenance_flag(
                maintenance_met=met,
                consecutive_unmet_days=unmet_run,
                warn_after_days=eases_onset,
                sharpness=sharpness,
                durable_base=durable_base,
                hold_active=hold_active,
                fast_ceiling=c_fast,
                durable_ceiling=c_durable,
            )

        rows.append(
            {
                "date": day.isoformat(),
                "durable_base": round(durable_base, 2),   # D ∈ [floor_t, C_D]
                "durable_band_lo": round(band_lo, 2),     # INDEX band
                "durable_band_hi": round(band_hi, 2),
                "sharpness": round(sharpness, 2),         # F ∈ [0, C_F]
                "vo2max_anchor_score": round(vo2max_anchor_score, 2) if vo2max_anchor_score is not None else None,
                "days_since_vo2max": days_since,          # per-day causal, never negative
                "durable_load": round(durable_load, 4),
                "sharp_load": round(sharp_load, 4),
                "base_accum_b": round(b_t[i], 4),         # CAUSAL B of this day's week
                "tau_slow_days": round(tau_slow_t[i], 2),
                "floor_score": round(floor_d_t[i], 2),    # floor in D-space [0, C_D]
                "confidence": round(confidence, 3),
                "evidence_state": evidence_state,
                "contributing": {
                    # effective inverse-variance weights actually fused THIS day
                    # (staleness-inflated; 0 when the signal is absent).
                    "run_ef": round(1.0 / ests["run_ef"][1], 3) if "run_ef" in ests else 0.0,
                    "bike_ef": round(1.0 / ests["bike_ef"][1], 3) if "bike_ef" in ests else 0.0,
                    # corroborator, not level-setter (v3 pt3: strength-confounded)
                    # — the elevation is computed (rhr_elev) for provenance but
                    # its level weight is 0.0 BY DESIGN.
                    "rhr": 0.0,
                    "vo2max": round(1.0 / ests["vo2max"][1], 3) if "vo2max" in ests else 0.0,
                    "b_prior": round(1.0 / ests["b_prior"][1], 4),  # always present
                    # Active-set swim EF still blends technique and aerobic response;
                    # it is not a durable level signal, so its fusion weight stays zero.
                    "swim_ef": 0.0,
                    "hrv": 0.0,      # weak corroborator; not in the durable calibration
                    "load": 1.0 if load_moved else 0.0,
                    # NEAT floor bonus this day (% of C_D added to the durable floor
                    # from smoothed daily steps) — maintenance, not build (v4.2).
                    "neat": round(neat_pct_t[i], 2),
                },
                "stage": stage,
                "maintenance_met": met,
                # Coaching horizons — all CONTINUOUS, per-day. A horizon at the
                # projection-search cap means "no meaningful move within the
                # window", stored NULL so the renderer omits that marker.
                #  warn_after_days = v4 durable-erosion-vs-band "eases" horizon;
                #    NULL in the building phase (base too thin to erode by a band).
                #  build_interval_days = v4 B-scaled cadence (days between sessions).
                "warn_after_days": _uncapped(eases_onset),
                "maintain_horizon_days": _uncapped(maintain_horizon),
                "build_interval_days": round(build_interval, 2),
                "expected_session_build": round(delta_i, 3),
                "flags": flags,
                "computed_at": now.isoformat(),
            }
        )

    db.upsert_computed_zone2_fitness(sb, rows)
    last = rows[-1]

    def _fmt_days(v) -> str:
        return f"{v:.1f}d" if v is not None else "holds"

    print(
        f"computed_zone2_fitness: {len(rows)} rows "
        f"(B={b_t[-1]:.2f}, τ_slow={tau_slow_t[-1]:.0f}d, floor={floor_d_t[-1]:.1f} "
        f"(neat +{neat_pct_t[-1]:.1f}%), calib_load={calib_load:.1f}, "
        f"calib_score={f'{calib_score:.1f}' if calib_score is not None else 'none'}, "
        f"conf={last['confidence']:.2f}, eases={_fmt_days(last['warn_after_days'])}, "
        f"maintain={_fmt_days(last['maintain_horizon_days'])}, build={last['build_interval_days']:.1f}d, "
        f"hold={hold_active})"
    )


def run_goals(sb) -> None:
    """Materialize each active goal's AI-authored metric_sql into
    goal_progress. A goal with broken SQL (schema drift, etc.) is skipped
    with a warning — it must never fail the nightly job."""
    goals = db.fetch_active_goals(sb)
    points_written = 0
    for goal in goals:
        try:
            result = db.exec_readonly(sb, goal["metric_sql"])
            rows = goal_progress_rows(goal["id"], result)
            db.upsert_goal_progress(sb, rows)
            points_written += len(rows)
        except Exception as e:  # noqa: BLE001 — one bad goal must not fail the job
            print(f"goal {goal['id']}: skipped ({e})")
    print(f"goal_progress: {len(goals)} goals evaluated, {points_written} points written")


def run_geocoding(sb) -> None:
    """Reverse-geocode workout start coordinates offline (City/Admin/Country)
    into workout_geo. Idempotent: fetch_workouts_needing_geo already excludes
    workouts with an existing row, so re-runs cost ~0. DEFENSIVE by design —
    a geocoding failure (bad coord, library hiccup, etc.) must never fail the
    nightly job, matching how run_goals isolates a single bad goal."""
    from metrics import geo

    try:
        rows = db.fetch_workouts_needing_geo(sb)
        if not rows:
            print("workout_geo: 0 workouts need geocoding")
            return
        results = geo.reverse_geocode([(r["lat"], r["lon"]) for r in rows])
        geo_rows = [
            {
                "workout_id": r["workout_id"],
                "lat": r["lat"],
                "lon": r["lon"],
                "city": res["city"],
                "admin": res["admin"],
                "country": res["country"],
            }
            for r, res in zip(rows, results)
        ]
        db.upsert_workout_geo(sb, geo_rows)
        print(f"workout_geo: {len(geo_rows)} rows geocoded")
    except Exception as e:  # noqa: BLE001 — geocoding must never fail the nightly job
        print(f"workout_geo: skipped ({e})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Nightly health metrics job")
    parser.add_argument("--full", action="store_true", help="recompute all history")
    args = parser.parse_args()
    try:
        run(full=args.full)
    except Exception as e:  # noqa: BLE001 — fail loudly for Actions
        print(f"metrics job failed: {e}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
