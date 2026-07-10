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
