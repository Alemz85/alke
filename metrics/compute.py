"""Nightly metrics job (SPEC §5). Run: `python -m metrics.compute [--full]`.

Per-workout metrics recompute over the last 60 days by default (--full for
everything). The daily CTL/ATL/ACWR chain is always recomputed over full
history: it is a few hundred rows, and the EWMA chain is only exact when
seeded from day one."""

from __future__ import annotations

import argparse
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
    "cardio": ["swim", "cycling", "elliptical", "rowing"],
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


def run(full: bool) -> None:
    sb = db.client()
    config = db.fetch_user_config(sb)
    tz = ZoneInfo(config.get("timezone") or "Europe/Berlin")
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
    hr_max = config.get("hr_max")
    if hr_max is None or observed_max > hr_max:
        print(f"hr_max {'initialized' if hr_max is None else 'raised'} to {observed_max}")
        hr_max = observed_max
        db.update_hr_max(sb, hr_max)

    # ---- per-workout metrics (window) ----
    since = None if full else (now - timedelta(days=RECOMPUTE_DAYS)).isoformat()
    window_workouts = db.fetch_workouts(sb, since)
    samples_by_workout = db.fetch_hr_samples(sb, [w["id"] for w in window_workouts])
    swim_offset = float(config.get("swim_hr_offset") or -10)
    z2_low = float(config.get("zone2_low_frac") or 0.60)
    z2_high = float(config.get("zone2_high_frac") or 0.70)

    computed_rows = []
    for w in window_workouts:
        samples = samples_by_workout.get(w["id"], [])
        day = local_date(w["start_at"], tz)
        bounds = zone_bounds(hr_max, rhr_recent_for(day, rhr_by_date), z2_low, z2_high)
        is_swim = bool(w["type"]) and "swim" in w["type"].lower()
        tiz = time_in_zones(samples, bounds, swim_hr_offset=swim_offset if is_swim else 0.0)
        eligible = ef_eligibility(w["type"], tiz, w["duration_s"])
        computed_rows.append(
            {
                "workout_id": w["id"],
                "time_in_zones": {f"z{z}": s for z, s in tiz.items()},
                "trimp": round(trimp_edwards(tiz), 2),
                "ef": ef(w["distance_m"], w["duration_s"], w["avg_hr"]) if eligible else None,
                "decoupling_pct": hr_drift_pct(samples) if eligible else None,
                "hrr60": hrr60(samples, w["duration_s"]),
                "computed_at": now.isoformat(),
            }
        )
    db.upsert_computed_workouts(sb, computed_rows)
    print(f"computed_workout: {len(computed_rows)} rows")

    # ---- daily chain (always full history) ----
    trimp_by_id = {r["workout_id"]: r["trimp"] for r in computed_rows}
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


def run_insights(sb, all_workouts, daily_metrics, daily_rows, tz) -> None:
    import pandas as pd

    from metrics.insights import compute_correlations, ef_dlm, weight_series, zscore_trailing

    # per-day performance: EF / decoupling / HRR60 averaged over that day's workouts
    perf_by_id = {r["workout_id"]: r for r in db.fetch_computed_workouts(sb)}
    perf_by_date: dict[date, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for w in all_workouts:
        perf = perf_by_id.get(w["id"])
        if not perf:
            continue
        day = local_date(w["start_at"], tz)
        for key, col in (("ef", "ef"), ("decoupling_pct", "decoupling"), ("hrr60", "hrr60")):
            if perf[key] is not None:
                perf_by_date[day][col].append(float(perf[key]))

    def midpoint_hours(row: dict) -> float | None:
        if not row.get("sleep_start") or not row.get("sleep_end"):
            return None
        start = datetime.fromisoformat(row["sleep_start"].replace("Z", "+00:00")).astimezone(tz)
        end = datetime.fromisoformat(row["sleep_end"].replace("Z", "+00:00")).astimezone(tz)
        mid = start + (end - start) / 2
        # hours from the previous local midnight of the wake date, so pre- and
        # post-midnight midpoints stay comparable
        return (mid - datetime.combine(end.date(), datetime.min.time(), tz)).total_seconds() / 3600

    dm_by_date = {date.fromisoformat(r["date"]): r for r in daily_metrics}
    index = [date.fromisoformat(r["date"]) for r in daily_rows]
    frame = pd.DataFrame(
        {
            "sleep_duration": [
                (dm_by_date.get(d) or {}).get("sleep_duration_min") for d in index
            ],
            "sleep_midpoint": [
                midpoint_hours(dm_by_date[d]) if d in dm_by_date else None for d in index
            ],
            "rhr_dev": [r["rhr_dev"] for r in daily_rows],
            "hrv_dev": [r["hrv_dev"] for r in daily_rows],
            "ctl": [r["ctl"] for r in daily_rows],
            "atl": [r["atl"] for r in daily_rows],
            "trimp_total": [r["trimp_total"] for r in daily_rows],
            "ef": [pd.Series(perf_by_date[d]["ef"]).mean() if perf_by_date[d]["ef"] else None for d in index],
            "decoupling": [
                pd.Series(perf_by_date[d]["decoupling"]).mean() if perf_by_date[d]["decoupling"] else None
                for d in index
            ],
            "hrr60": [
                pd.Series(perf_by_date[d]["hrr60"]).mean() if perf_by_date[d]["hrr60"] else None for d in index
            ],
        },
        index=pd.DatetimeIndex([pd.Timestamp(d) for d in index]),
    ).astype(float)
    frame["trimp_prior"] = frame["trimp_total"].shift(1)
    # consistency: absolute deviation from the 14-day rolling median midpoint
    frame["sleep_midpoint_dev"] = (
        frame["sleep_midpoint"] - frame["sleep_midpoint"].rolling(14, min_periods=5).median()
    ).abs()

    # weight is a slow OUTCOME, not a daily driver: raw (ffilled) weight is kept
    # for reference/plotting, and weight_7d_slope (kg/week trend) is the PERF
    # variable correlations test against sleep/rhr/hrv/training-load drivers.
    if any("weight_kg" in (r or {}) for r in daily_metrics):
        raw_weight = pd.Series(
            [(dm_by_date.get(d) or {}).get("weight_kg") for d in index],
            index=frame.index,
        )
        weight, weight_7d_slope = weight_series(raw_weight)
        frame["weight"] = weight
        frame["weight_7d_slope"] = weight_7d_slope

    correlations = compute_correlations(zscore_trailing(frame))
    db.replace_insight_correlations(sb, correlations)
    print(f"insight_correlations: {len(correlations)} pairs")

    model = ef_dlm(frame)
    if model is not None:
        db.upsert_insight_model(sb, model)
        print(f"insight_models: ef_on_sleep_dlm (n={model['diagnostics']['n']})")
    else:
        print("insight_models: skipped (fewer than 40 EF observations)")


def _percentile_of(value: float | None, sorted_pool: list[float], invert: bool = False) -> float | None:
    """Percentile-style [0,100] rank of `value` within a sorted reference pool.
    invert=True ranks LOWER values higher (e.g. RHR: a lower resting HR is better).
    Returns None on missing value / empty pool. Used to put each own-sports signal
    on the common percentile scale the level blend expects (docs v2 Re-anchoring)."""
    if value is None or not sorted_pool:
        return None
    below = sum(1 for x in sorted_pool if x < value)
    equal = sum(1 for x in sorted_pool if x == value)
    pct = (below + 0.5 * equal) / len(sorted_pool) * 100.0
    return (100.0 - pct) if invert else max(0.0, min(100.0, pct))


def run_zone2_fitness(sb, all_workouts, daily_metrics, daily_rows, days, tz, now) -> None:
    """Zone 2 fitness model v2 (docs/zone2-fitness-model.md "v2 — locked amendments").
    The headline index I = D + F, two FIXED-ceiling components summed:
      - D = durable base ∈ [0, C_D] (C_D=durable_ceiling, default 70), re-anchored
        to the user's OWN swim/bike efficiency + RHR/HRV, NOT the watch VO2max.
      - F = fast layer ∈ [0, C_F] (C_F=fast_ceiling, default 30), a SATURATING map
        of the fast-EWMA load.
    D is stored in durable_base, F in sharpness; the band cols are the INDEX band.
    Uses only existing columns (spec §8) and does NOT touch the computed_daily chain."""
    from metrics import models

    params = db.fetch_zone2_fitness_params(sb)

    def param(key: str, default):
        val = params.get(key) if params else None
        return float(val) if val is not None else default

    tau_fast = param("tau_fast_days", models.Z2_TAU_FAST_DAYS)
    tau_slow_min = param("tau_slow_min_days", models.Z2_TAU_SLOW_MIN_DAYS)
    tau_slow_max = param("tau_slow_max_days", models.Z2_TAU_SLOW_MAX_DAYS)
    f_max = param("f_max", models.Z2_F_MAX)
    floor_p = param("floor_p", models.Z2_FLOOR_P)
    b_ref = param("b_ref_min_per_wk", models.Z2_B_REF_MIN_PER_WK)
    # v2 fixed ceilings + fast saturation reference (fall back to 70/30/26).
    c_durable = param("durable_ceiling", models.ZONE2_DURABLE_CEILING)
    c_fast = param("fast_ceiling", models.ZONE2_FAST_CEILING)
    fast_sat = param("fast_sat", models.ZONE2_FAST_SAT)
    stage = (params.get("stage") if params else None) or "literature"

    # ---- daily Zone-2 load w(t) from computed_workout.time_in_zones (spec §1) ----
    zones_by_id = db.fetch_computed_workout_zones(sb)
    w_by_date: dict[date, float] = defaultdict(float)
    # intensity-correct Z2 session dates for maintenance accounting (spec §1/§5a)
    z2_session_dates: dict[date, int] = defaultdict(int)
    weekly_z2_min: dict[tuple[int, int], float] = defaultdict(float)
    for wk in all_workouts:
        tiz = zones_by_id.get(wk["id"])
        if not tiz:
            continue
        day = local_date(wk["start_at"], tz)
        w_by_date[day] += z2_trimp_from_zones(tiz)
        z2_sec = float(tiz.get("z2", 0) or 0)
        z3_sec = float(tiz.get("z3", 0) or 0)
        aerobic_sec = z2_sec + z3_sec
        # ≥20 min in the aerobic band, with ≥20 min at/above Z2 lower bound (spec §1)
        if aerobic_sec >= 20 * 60 and z2_sec + z3_sec >= 20 * 60:
            z2_session_dates[day] += 1
        iso = day.isocalendar()
        weekly_z2_min[(iso.year, iso.week)] += aerobic_sec / 60.0

    daily_z2_load = [w_by_date.get(d, 0.0) for d in days]

    # ---- B, tau_slow, floor (spec §3) — resolved from full weekly history ----
    weekly_series = [weekly_z2_min[k] for k in sorted(weekly_z2_min)]
    b = models.base_consolidation(weekly_series, b_ref=b_ref)
    tau_slow_days = models.tau_slow(b, tau_min=tau_slow_min, tau_max=tau_slow_max)
    # floor as a percentile-style share; the D-space floor is the same share of C_D.
    floor_pct = models.durable_floor_score(b, f_max=f_max, p=floor_p)
    floor_d = models.durable_score_from_percentile(floor_pct, durable_ceiling=c_durable)

    # ---- v2 re-anchored durable LEVEL (Thread 2): own swim/bike EF + RHR/HRV;
    # watch VO2max is low-weight, refresh-day-only calibration, NEVER the cap. ----
    perf_by_id = {r["workout_id"]: r for r in db.fetch_computed_workouts(sb)}
    swim_efs: list[float] = []
    bike_efs: list[float] = []
    for wk in all_workouts:
        perf = perf_by_id.get(wk["id"])
        if not perf or perf.get("ef") is None:
            continue
        wtype = (wk.get("type") or "").lower()
        if "swim" in wtype:
            swim_efs.append(float(perf["ef"]))
        elif "cycl" in wtype or "bik" in wtype:
            bike_efs.append(float(perf["ef"]))
    swim_ef_sorted = sorted(swim_efs)
    bike_ef_sorted = sorted(bike_efs)
    latest_swim_ef = swim_efs[-1] if swim_efs else None  # workouts arrive time-ordered
    latest_bike_ef = bike_efs[-1] if bike_efs else None

    # RHR / HRV levels: rank the latest deviation against its own trailing pool.
    # rhr_dev up = worse (invert); hrv_dev up = better (higher = fitter).
    rhr_devs = [r["rhr_dev"] for r in daily_rows if r.get("rhr_dev") is not None]
    hrv_devs = [r["hrv_dev"] for r in daily_rows if r.get("hrv_dev") is not None]
    rhr_dev_sorted = sorted(rhr_devs)
    hrv_dev_sorted = sorted(hrv_devs)
    latest_rhr_dev = rhr_devs[-1] if rhr_devs else None
    latest_hrv_dev = hrv_devs[-1] if hrv_devs else None

    swim_ef_pct = _percentile_of(latest_swim_ef, swim_ef_sorted)
    bike_ef_pct = _percentile_of(latest_bike_ef, bike_ef_sorted)
    rhr_pct = _percentile_of(latest_rhr_dev, rhr_dev_sorted, invert=True)
    hrv_pct = _percentile_of(latest_hrv_dev, hrv_dev_sorted)

    # Watch VO2max — demoted to occasional low-weight calibration (docs v2 Thread 2).
    vo2_by_date = {
        date.fromisoformat(r["date"]): float(r["vo2max"])
        for r in daily_metrics
        if r.get("vo2max") is not None
    }
    latest_vo2_date = max(vo2_by_date) if vo2_by_date else None
    latest_vo2 = vo2_by_date[latest_vo2_date] if latest_vo2_date else None
    vo2max_pct = models.vo2max_to_score(latest_vo2) if latest_vo2 is not None else None
    vo2max_anchor_score = vo2max_pct  # stored for provenance/audit (0-100 percentile)

    # ---- the two EWMA compartments (spec §2). durable_load carries the durable
    # MOVEMENT; the LEVEL is set by the own-sports blend below. sharp_load feeds the
    # v2 saturating F. Floor is in LOAD units — invert the percentile→load ref. ----
    positive = sorted(w for w in daily_z2_load if w > 0)
    load_ref = 1.0
    if positive:
        idx = min(len(positive) - 1, int(round(0.9 * (len(positive) - 1))))
        load_ref = max(positive[idx], 1.0)
    floor_load = floor_pct / 100.0 * load_ref  # percentile-share of the load ref

    def load_to_pct(load: float) -> float:
        return max(0.0, min(100.0, load / load_ref * 100.0))

    series = models.z2_durable_sharpness_series(
        daily_z2_load,
        tau_fast=tau_fast,
        tau_slow_days=tau_slow_days,
        floor_load=floor_load,
    )

    warn_window = models.warn_after_days(b)

    # ---- injury / plan hold suppression (spec §5c.4) ----
    holds = db.fetch_active_injury_holds(sb)
    hold_active = holds["active_injuries"] > 0 or holds["active_constraints"] > 0

    # maintenance_met per day: ≥2 intensity-correct Z2 sessions in trailing 7d (spec §5a)
    def maintenance_met_for(day: date) -> bool:
        return sum(z2_session_dates.get(day - timedelta(days=j), 0) for j in range(7)) >= 2

    # anchor index within `days` where the durable load track equals the LEVEL.
    idx_at_level = _index_on_or_before(days, latest_vo2_date, len(days) - 1) if latest_vo2_date else (len(days) - 1)

    # ---- per-day rows ----
    rows = []
    unmet_run = 0  # consecutive maintenance-unmet days ending at each day
    for i, day in enumerate(days):
        durable_load, sharp_load = series[i]

        met = maintenance_met_for(day)
        unmet_run = 0 if met else unmet_run + 1

        # ---- DURABLE D ∈ [0, C_D]: own-sports LEVEL sets the height; durable-load
        # MOVEMENT carries the trajectory between calibrations (docs v2). ----
        vo2_refreshed = latest_vo2_date is not None and day == latest_vo2_date
        level_pct = models.durable_level_score(
            swim_ef_pct=swim_ef_pct,
            bike_ef_pct=bike_ef_pct,
            rhr_pct=rhr_pct,
            hrv_pct=hrv_pct,
            vo2max_pct=vo2max_pct,
            vo2max_refreshed=vo2_refreshed,
        )
        days_since = (day - latest_vo2_date).days if latest_vo2_date is not None else None
        if level_pct is not None:
            # delta engine: durable-load motion since the level was placed, on top
            # of the own-sports level. Anchored at idx_at_level, then drifts.
            level_d = models.durable_score_from_percentile(level_pct, durable_ceiling=c_durable)
            move_pct = load_to_pct(durable_load) - load_to_pct(series[idx_at_level][0])
            move_d = move_pct / 100.0 * c_durable
            durable_base = level_d + move_d
            beta = None  # v2 has no single VO2max beta; provenance kept via contributing
        else:
            # No own-sports signal: fall back to pure load dynamics, WIDE band.
            durable_base = models.durable_score_from_percentile(
                load_to_pct(durable_load), durable_ceiling=c_durable
            )
            beta = None
        # never below the earned floor, never above the fixed ceiling C_D.
        durable_base = max(floor_d, min(c_durable, durable_base))

        # ---- FAST F ∈ [0, C_F]: saturating map of the fast-EWMA load (docs v2). ----
        sharpness = models.fast_score_from_load(sharp_load, fast_ceiling=c_fast, fast_sat=fast_sat)

        index = durable_base + sharpness  # I = D + F ∈ [0, 100]

        # ---- confidence + evidence_state (spec §6d, defensible v2) ----
        drow = daily_rows[i]
        load_moved = any(w > 0 for w in daily_z2_load[max(0, i - 6): i + 1])
        valid_signals = 0
        if load_moved:
            valid_signals += 1
        if swim_ef_pct is not None or bike_ef_pct is not None:
            valid_signals += 1  # own-sports efficiency present
        if drow.get("rhr_dev") is not None:
            valid_signals += 1
        if drow.get("hrv_dev") is not None:
            valid_signals += 1

        own_level = level_pct is not None
        vo2_only = (not own_level) and vo2_refreshed
        if not own_level and valid_signals < 2:
            evidence_state = "insufficient"
        elif vo2_only:
            evidence_state = "low_confidence"  # only the watch moved, no own signal
        elif valid_signals < 2:
            evidence_state = "insufficient"
        else:
            evidence_state = "ok"

        confidence = max(0.0, min(1.0, valid_signals / 4.0))
        # band is on the INDEX (docs v2 Storage note); widens when signals are
        # sparse — a WIDE, honest band, no fabricated precision.
        half_width = 6.0 + (1.0 - confidence) * 18.0
        band_lo = max(0.0, index - half_width)
        band_hi = min(models.ZONE2_INDEX_CEILING, index + half_width)

        # ---- zone2_maintenance flag firing rule (spec §5c): read the two numbers'
        # relationship (F fading faster than D), never their sum. ----
        flags = models.zone2_maintenance_flag(
            maintenance_met=met,
            consecutive_unmet_days=unmet_run,
            warn_window=warn_window,
            sharpness=sharpness,
            durable_base=durable_base,
            hold_active=hold_active,
        )

        rows.append(
            {
                "date": day.isoformat(),
                "durable_base": round(durable_base, 2),   # D ∈ [0, C_D]
                "durable_band_lo": round(band_lo, 2),     # INDEX band
                "durable_band_hi": round(band_hi, 2),
                "sharpness": round(sharpness, 2),         # F ∈ [0, C_F]
                "vo2max_anchor_score": round(vo2max_anchor_score, 2) if vo2max_anchor_score is not None else None,
                "anchor_beta": round(beta, 4) if beta is not None else None,
                "days_since_vo2max": days_since,
                "durable_load": round(durable_load, 4),
                "sharp_load": round(sharp_load, 4),
                "base_accum_b": round(b, 4),
                "tau_slow_days": round(tau_slow_days, 2),
                "floor_score": round(floor_d, 2),         # floor in D-space [0, C_D]
                "confidence": round(confidence, 3),
                "evidence_state": evidence_state,
                "contributing": {
                    "swim_ef": models.ZONE2_LEVEL_W_SWIM_EF if swim_ef_pct is not None else 0.0,
                    "bike_ef": models.ZONE2_LEVEL_W_BIKE_EF if bike_ef_pct is not None else 0.0,
                    "rhr": models.ZONE2_LEVEL_W_RHR if rhr_pct is not None else 0.0,
                    "hrv": models.ZONE2_LEVEL_W_HRV if hrv_pct is not None else 0.0,
                    "vo2max": models.ZONE2_LEVEL_W_VO2MAX if vo2_refreshed else 0.0,
                    "load": 1.0 if load_moved else 0.0,
                },
                "stage": stage,
                "maintenance_met": met,
                "warn_after_days": warn_window,
                "flags": flags,
                "computed_at": now.isoformat(),
            }
        )

    db.upsert_computed_zone2_fitness(sb, rows)
    print(
        f"computed_zone2_fitness: {len(rows)} rows "
        f"(B={b:.2f}, τ_slow={tau_slow_days:.0f}d, C_D={c_durable:.0f}, C_F={c_fast:.0f}, hold={hold_active})"
    )


def _index_on_or_before(days: list[date], target: date, fallback_idx: int) -> int:
    """Index of the latest day <= target within `days`; fallback if none precede."""
    lo, hi, found = 0, len(days) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if days[mid] <= target:
            found = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return found if found is not None else fallback_idx


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
