"""Nightly metrics job (SPEC §5). Run: `python -m metrics.compute [--full]`.

Per-workout metrics recompute over the last 60 days by default (--full for
everything). The daily CTL/ATL/ACWR chain is always recomputed over full
history: it is a few hundred rows, and the EWMA chain is only exact when
seeded from day one."""

from __future__ import annotations

import argparse
import math
import sys
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from metrics import db
from metrics.models import (
    acwr,
    adaptation_threshold_bpm,
    ambient_daily_load,
    calibrate_kcal_per_km,
    classify_zone,
    ctl_atl_series,
    easy_aerobic_seconds,
    ef,
    ef_distance_m,
    ef_eligibility,
    flags_for_day,
    hr_drift_pct,
    hrr60,
    is_ambulatory_modality,
    is_cycling_modality,
    power_ef,
    rolling_median,
    sedentary_ambient_baseline,
    swim_active_ef,
    swim_active_hr_drift_pct,
    swim_ef_eligibility,
    time_in_zones,
    trimp_edwards,
    z2_trimp_from_zones,
    zone_bounds,
)

RECOMPUTE_DAYS = 60

# The aerobic-specific EF channels of the Zone-2 level fusion, in the order they
# are written to computed_zone2_fitness.contributing (a tuple, so the jsonb key
# order is stable across runs). Each has its OWN owner-ratified detrained
# baseline in zone2_fitness_params and its own variance; they are never pooled.
# `bike_power_ef` is watts per beat — a different UNIT from the four m/min-per-
# beat channels — which is why it can never share one of their baselines.
EF_CHANNELS = ("run_ef", "bike_ef", "treadmill_ef", "row_ef", "bike_power_ef")

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


def workout_recorded_start(workout: dict, tz: ZoneInfo) -> datetime:
    """Workout local wall time, preferring HAE's verified recorded offset.

    ``start_at`` preserves the instant but Postgres normalizes its original
    offset away. HAE's compact raw summary retains that offset, which is the
    right clock for circadian/calendar analysis while travelling. A raw value
    is trusted only when it resolves to the same instant as ``start_at``.
    """
    instant = datetime.fromisoformat(workout["start_at"].replace("Z", "+00:00"))
    fallback = instant.astimezone(tz)
    raw_start = (workout.get("raw") or {}).get("start")
    if not isinstance(raw_start, str):
        return fallback
    try:
        recorded = datetime.fromisoformat(raw_start)
    except ValueError:
        return fallback
    if recorded.tzinfo is None or abs(recorded.timestamp() - instant.timestamp()) > 1.0:
        return fallback
    return recorded


def workout_local_date(workout: dict, tz: ZoneInfo) -> date:
    return workout_recorded_start(workout, tz).date()


def dedupe_replaced_workouts(
    workouts: list[dict], trimp_by_id: dict[str, float]
) -> tuple[list[dict], list[tuple[dict, dict]]]:
    """Collapse workout rows that are the same session stored twice.

    Apple Health can replace a workout object — delete it and re-create an
    identical one under a fresh UUID — which the ingest function normally
    absorbs (see planWorkoutAdoptions in supabase/functions/ingest/parse.ts).
    It deliberately refuses ambiguous cases rather than guessing, so a
    duplicate pair can still reach the DB, and every duplicate row here adds
    its TRIMP to the day again: a replaced run would double that day's TRIMP
    and drag CTL/ATL/TSB/ACWR with it.

    Grouping on (type, start_at) is the same natural key the ingest adoption
    uses: two same-type sessions cannot start at the same instant. Within a
    group the row with the HIGHEST known TRIMP wins, which keeps the day
    honest even when the other row has no computed_workout row yet (the
    freshly-inserted replacement typically doesn't).

    Returns (kept, dropped_pairs) where each dropped pair is (kept, dropped),
    so the caller can warn — this silences the double-count, it does not
    resolve the duplicate. scripts/dedupe_replaced_workouts.py does that.
    """
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for w in workouts:
        groups[(w.get("type"), w.get("start_at"))].append(w)

    kept: list[dict] = []
    dropped_pairs: list[tuple[dict, dict]] = []
    for group in groups.values():
        if len(group) == 1:
            kept.append(group[0])
            continue
        winner = max(group, key=lambda w: (trimp_by_id.get(w["id"], 0.0), str(w["id"])))
        kept.append(winner)
        for w in group:
            if w["id"] != winner["id"]:
                dropped_pairs.append((winner, w))

    # Preserve the caller's ordering; downstream weekly bucketing reads it.
    kept_ids = {w["id"] for w in kept}
    return [w for w in workouts if w["id"] in kept_ids], dropped_pairs


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


def vo2max_as_of(day: date, vo2max_by_date: dict[date, float]) -> float | None:
    """Most recent watch VO2max on or before `day`, or None when nothing precedes
    it. CAUSAL by construction — the adaptation threshold it feeds must reflect
    the fitness the user actually had that day, never a later reading (the v3
    "no fictional history" contract)."""
    candidates = [d for d in vo2max_by_date if d <= day]
    if not candidates:
        return None
    return vo2max_by_date[max(candidates)]


def configured_float(config: dict, key: str, default: float) -> float:
    """Read a numeric setting, defaulting only for a missing/NULL value."""
    value = config.get(key)
    return float(default if value is None else value)


def run(full: bool, skip_insights: bool = False) -> None:
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
    # Feeds the v5 per-workout adaptation threshold (models.adaptation_threshold_bpm):
    # how easy a session can be and still build scales with current fitness.
    vo2max_by_date = {
        date.fromisoformat(r["date"]): float(r["vo2max"])
        for r in daily_metrics
        if r.get("vo2max") is not None
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
        day = workout_local_date(w, tz)
        bounds = zone_bounds(hr_max, rhr_recent_for(day, rhr_by_date), z2_low, z2_high)
        is_swim = bool(w["type"]) and "swim" in w["type"].lower()
        tiz = time_in_zones(samples, bounds, swim_hr_offset=swim_offset if is_swim else 0.0)
        # v5: the easy-aerobic band below the Z2 floor but above the fitness-scaled
        # adaptation threshold. Stored alongside the 1..5 buckets as an extra jsonb
        # key (no migration); pre-v5 rows simply lack it until a --full recompute.
        easy_sec = easy_aerobic_seconds(
            samples,
            adaptation_threshold_bpm(
                hr_max, rhr_recent_for(day, rhr_by_date), vo2max_as_of(day, vo2max_by_date)
            ),
            bounds[0],
            swim_hr_offset=swim_offset if is_swim else 0.0,
        )
        swim_sets = swim_sets_by_workout.get(w["id"], []) if is_swim else []
        eligible = (
            swim_ef_eligibility(w["type"], swim_sets, samples, bounds, swim_offset)
            if is_swim
            else ef_eligibility(w["type"], tiz, w["duration_s"])
        )
        efficiency = None
        # Cycling POWER EF (W/bpm) — a DIFFERENT UNIT from `efficiency`
        # (m/min per bpm), so it gets its own column, never `ef`. See
        # models.power_ef and migration 20260830120000.
        power_efficiency = None
        drift = None
        if eligible:
            if is_swim:
                efficiency = swim_active_ef(swim_sets, samples)
                drift = swim_active_hr_drift_pct(swim_sets, samples)
            else:
                # Per-modality distance trust: a manual entry supersedes the
                # device figure, treadmill EF additionally requires a logged
                # near-flat incline, and an indoor trainer's fabricated distance
                # is refused outright (it reaches the model as power instead).
                efficiency = ef(
                    ef_distance_m(
                        w["type"],
                        w.get("distance_m"),
                        w.get("manual_distance_m"),
                        w.get("manual_incline_pct"),
                    ),
                    w["duration_s"],
                    w["avg_hr"],
                )
                drift = hr_drift_pct(samples)
            if is_cycling_modality(w["type"]):
                power_efficiency = power_ef(w.get("manual_avg_watts"), w["avg_hr"])
        computed_rows.append(
            {
                "workout_id": w["id"],
                "time_in_zones": {**{f"z{z}": s for z, s in tiz.items()}, "z1b": easy_sec},
                "trimp": round(trimp_edwards(tiz), 2),
                "ef": efficiency,
                "power_ef": power_efficiency,
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
    # Guard against the same session being stored under two HealthKit UUIDs;
    # without this each duplicate row adds its TRIMP to the day a second time.
    deduped_workouts, duplicate_pairs = dedupe_replaced_workouts(
        all_workouts, trimp_by_id
    )
    for winner, dropped in duplicate_pairs:
        print(
            f"WARNING: duplicate workout ignored for daily load — "
            f"{dropped['type']} at {dropped['start_at']} is stored as both "
            f"{winner['external_id']} (counted) and {dropped['external_id']} "
            f"(ignored). Run scripts/dedupe_replaced_workouts.py to collapse it.",
            file=sys.stderr,
        )

    trimp_by_date: dict[date, float] = defaultdict(float)
    workouts_by_week: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for w in deduped_workouts:
        day = workout_local_date(w, tz)
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
    if skip_insights:
        # On-demand runs (the app's "Run metrics now" button) skip the two
        # insight finders — by far the slowest stage — leaving last night's
        # insight rows in place; the nightly cron always recomputes them.
        print("insights: skipped (--skip-insights); nightly run will refresh them")
    else:
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
        day = workout_local_date(w, tz)
        for key, col in (("decoupling_pct", "decoupling"), ("hrr60", "hrr60")):
            if perf[key] is None:
                continue
            perf_by_date[day][col].append(float(perf[key]))
    return perf_by_date


def workout_duration_by_date(all_workouts, tz) -> dict[date, float]:
    """Recorded workout minutes per local date, independent of HR coverage."""
    totals: dict[date, float] = defaultdict(float)
    for workout in all_workouts:
        try:
            duration_s = float(workout.get("duration_s"))
        except (AttributeError, TypeError, ValueError):
            continue
        if not math.isfinite(duration_s) or duration_s <= 0:
            continue
        totals[workout_local_date(workout, tz)] += duration_s / 60.0
    return dict(totals)


SLEEP_END_OFFSET_KEY = "_sleep_end_timezone_offset_min"
MIN_SLEEP_INSIGHT_DURATION_MIN = 180.0
MAX_SLEEP_UNACCOUNTED_MIN = 180.0
MAX_SLEEP_DURATION_OVER_SPAN_MIN = 15.0


def sleep_insight_eligible(row: dict) -> bool:
    """Return whether an aggregate is plausible main sleep for inference.

    HAE can label naps, awake-only episodes, or multiple sleep episodes joined
    by a long daytime gap with one daily date. Those records remain useful for
    display, but treating them as the night's sleep would contaminate every
    duration, timing, continuity, and pre-workout hypothesis.
    """
    try:
        duration = float(row.get("sleep_duration_min"))
        start = datetime.fromisoformat(row["sleep_start"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(row["sleep_end"].replace("Z", "+00:00"))
        span_minutes = (end.timestamp() - start.timestamp()) / 60.0
    except (AttributeError, KeyError, TypeError, ValueError):
        return False
    if (
        not math.isfinite(duration)
        or not math.isfinite(span_minutes)
        or duration < MIN_SLEEP_INSIGHT_DURATION_MIN
        or span_minutes <= 0
        or duration > span_minutes + MAX_SLEEP_DURATION_OVER_SPAN_MIN
        or span_minutes - duration > MAX_SLEEP_UNACCOUNTED_MIN
    ):
        return False

    stages = row.get("sleep_stages")
    if not isinstance(stages, dict):
        return True
    known_stages = ("awake", "core", "deep", "rem")
    if not any(name in stages for name in known_stages):
        return True
    parsed: dict[str, float] = {}
    for name in known_stages:
        if name not in stages:
            parsed[name] = 0.0
            continue
        try:
            parsed[name] = float(stages[name])
        except (TypeError, ValueError):
            return False
        if not math.isfinite(parsed[name]) or parsed[name] < 0:
            return False
    return sum(parsed[name] for name in ("core", "deep", "rem")) > 0


def sleep_clock_timezone(row: dict, configured_tz, end: datetime):
    """Use the recorded wake offset only when it identifies travel.

    Matching offsets retain the configured IANA zone, including its DST
    transition rules. A differing valid offset is the best available record
    of the clock where this particular sleep occurred.
    """
    stages = row.get("sleep_stages") or {}
    try:
        recorded_minutes = float(stages.get(SLEEP_END_OFFSET_KEY))
    except (AttributeError, TypeError, ValueError):
        return configured_tz
    if not math.isfinite(recorded_minutes) or recorded_minutes != int(recorded_minutes):
        return configured_tz
    recorded_minutes = int(recorded_minutes)
    if not -14 * 60 <= recorded_minutes <= 14 * 60:
        return configured_tz
    configured_offset = end.astimezone(configured_tz).utcoffset()
    configured_minutes = (
        int(configured_offset.total_seconds() / 60)
        if configured_offset is not None else 0
    )
    if recorded_minutes == configured_minutes:
        return configured_tz
    return timezone(timedelta(minutes=recorded_minutes))


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
    clock_tz = sleep_clock_timezone(row, tz, end)
    midpoint_ts = start.timestamp() + (end.timestamp() - start.timestamp()) / 2
    midpoint_local = datetime.fromtimestamp(midpoint_ts, clock_tz)
    wake_local = end.astimezone(clock_tz)
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
    end = datetime.fromisoformat(row["sleep_end"].replace("Z", "+00:00"))
    wake = end.astimezone(sleep_clock_timezone(row, tz, end))
    row_day = date.fromisoformat(row["date"])
    day_offset = (wake.date() - row_day).days
    return day_offset * 24 + wake.hour + wake.minute / 60 + wake.second / 3600


def wake_epoch(row: dict) -> float | None:
    if not row.get("sleep_end"):
        return None
    try:
        return datetime.fromisoformat(row["sleep_end"].replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def build_daily_insight_frame(
    daily_metrics,
    daily_rows,
    tz,
    training_duration_by_date: dict[date, float] | None = None,
):
    """Build the temporal-contract daily frame without database writes."""
    import pandas as pd

    from metrics.insights import (
        prior_rolling_circular_deviation,
        prior_rolling_circular_mad,
        prior_rolling_deviation,
        weight_series,
    )

    dm_by_date = {date.fromisoformat(row["date"]): row for row in daily_metrics}
    index = [date.fromisoformat(row["date"]) for row in daily_rows]
    eligible_sleep = {
        day: sleep_insight_eligible(row) for day, row in dm_by_date.items()
    }
    frame = pd.DataFrame(
        {
            "sleep_duration": [
                (dm_by_date.get(day) or {}).get("sleep_duration_min")
                if eligible_sleep.get(day, False) else None
                for day in index
            ],
            "sleep_midpoint": [
                sleep_midpoint_hours(dm_by_date[day], tz)
                if eligible_sleep.get(day, False) else None
                for day in index
            ],
            "sleep_awake_fraction": [
                sleep_awake_fraction(dm_by_date[day])
                if eligible_sleep.get(day, False) else None
                for day in index
            ],
            "wake_hour": [
                wake_clock_hours(dm_by_date[day], tz)
                if eligible_sleep.get(day, False) else None
                for day in index
            ],
            "wake_at_epoch": [
                wake_epoch(dm_by_date[day])
                if eligible_sleep.get(day, False) else None
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
            "flights": [
                (dm_by_date.get(day) or {}).get("flights_climbed") for day in index
            ],
        },
        index=pd.DatetimeIndex([pd.Timestamp(day) for day in index]),
    ).apply(pd.to_numeric, errors="coerce")

    # These controls contain only load state available before the modeled
    # exposure/outcome; same-day ATL/CTL includes a later workout and leaks.
    frame["trimp_prior"] = frame["trimp_total"].shift(1)
    frame["steps_prior"] = frame["steps"].shift(1)
    frame["flights_prior"] = frame["flights"].shift(1)
    frame["ctl_prior"] = frame["ctl"].shift(1)
    frame["atl_prior"] = frame["atl"].shift(1)
    frame["ctl_pre_exposure"] = frame["ctl"].shift(2)
    if training_duration_by_date is not None:
        # Distribution is distinct from amount: for the same seven-day
        # training time, (sum duration)^2 / sum(duration^2) is the effective
        # number of equally sized training days (1 concentrated … 7 even).
        # Duration is used rather than TRIMP so missing HR cannot turn a real
        # workout into a false rest day. An all-rest week stays undefined.
        daily_duration = pd.Series(
            [float(training_duration_by_date.get(day, 0.0)) for day in index],
            index=frame.index,
            dtype=float,
        )
        prior_duration = daily_duration.shift(1)
        frame["duration_7d_prior"] = prior_duration.rolling(
            7, min_periods=7
        ).sum()
        prior_duration_squares = prior_duration.pow(2).rolling(
            7, min_periods=7
        ).sum()
        frame["training_density_7d_prior"] = (
            frame["duration_7d_prior"].pow(2) / prior_duration_squares
        ).where(prior_duration_squares > 0)
    # HAE's midnight-stamped RHR/HRV values are finalized full-day aggregates:
    # later exports revise them after same-day workouts. Only yesterday's
    # finalized aggregate is temporally available before today's session.
    frame["rhr_dev_prior"] = frame["rhr_dev"].shift(1)
    frame["hrv_dev_prior"] = frame["hrv_dev"].shift(1)

    frame["sleep_shortfall"] = -prior_rolling_deviation(frame["sleep_duration"])
    # A separate cumulative exposure preserves the distinction between one
    # short night and several consecutive short nights. Requiring all three
    # calendar days avoids silently changing its meaning across sensor gaps.
    frame["sleep_shortfall_3d"] = frame["sleep_shortfall"].rolling(
        window=3, min_periods=3
    ).mean()
    frame["sleep_midpoint_shift"] = prior_rolling_circular_deviation(
        frame["sleep_midpoint"]
    )
    frame["sleep_midpoint_dev"] = frame["sleep_midpoint_shift"].abs()
    frame["sleep_timing_variability_7d_prior"] = prior_rolling_circular_mad(
        frame["sleep_midpoint"]
    )
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


MIN_WORKOUT_HR_SECONDS = 300.0
MIN_WORKOUT_HR_COVERAGE = 0.90
MAX_WORKOUT_HR_COVERAGE = 1.05
MIN_WORKOUT_ENERGY_INTENSITY = 0.5
MAX_WORKOUT_ENERGY_INTENSITY = 25.0


def workout_energy_intensity(raw: dict | None) -> float | None:
    """Apple/HAE average workout intensity in kcal/(hour·kg), or MET.

    Real payloads use ``kcal/hr·kg`` while the HAE schema documents MET; the
    quantities are numerically equivalent for this purpose. Unknown units and
    physiologically implausible values stay missing rather than being guessed.
    """
    if not isinstance(raw, dict):
        return None
    summary = raw.get("intensity")
    if not isinstance(summary, dict) or isinstance(summary.get("qty"), bool):
        return None
    units = str(summary.get("units") or "").casefold().replace(" ", "")
    if units not in {"met", "kcal/hr·kg", "kcal/(hr·kg)"}:
        return None
    try:
        value = float(summary.get("qty"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or not MIN_WORKOUT_ENERGY_INTENSITY <= value <= MAX_WORKOUT_ENERGY_INTENSITY:
        return None
    return value


def daily_high_zone_fraction(all_workouts, perf_by_id, tz) -> dict[date, float]:
    """HR-quality workout-day fraction of measured time in zones 4–5.

    A day is omitted if any workout on it fails the HR-outcome quality gate.
    Rest days are also omitted: downstream candidates therefore compare the
    composition of known training days rather than rediscovering workout vs
    rest. Multi-session days aggregate seconds before taking the fraction.
    """
    totals: dict[date, dict[str, float | bool]] = defaultdict(
        lambda: {"high": 0.0, "total": 0.0, "valid": True}
    )
    for workout in all_workouts:
        day = workout_local_date(workout, tz)
        state = totals[day]
        computed = perf_by_id.get(workout["id"]) or {}
        try:
            duration_s = float(workout.get("duration_s"))
            trimp = float(computed.get("trimp"))
            zones = computed.get("time_in_zones") or {}
            zone_seconds = sum(
                float(zones.get(f"z{zone}") or 0.0) for zone in range(1, 6)
            )
            hr_coverage = zone_seconds / duration_s
            high_seconds = float(zones.get("z4") or 0.0) + float(zones.get("z5") or 0.0)
        except (TypeError, ValueError, ZeroDivisionError):
            state["valid"] = False
            continue
        valid = (
            math.isfinite(duration_s)
            and duration_s > 0
            and math.isfinite(trimp)
            and trimp > 0
            and zone_seconds >= MIN_WORKOUT_HR_SECONDS
            and MIN_WORKOUT_HR_COVERAGE <= hr_coverage <= MAX_WORKOUT_HR_COVERAGE
        )
        if not valid:
            state["valid"] = False
            continue
        state["high"] = float(state["high"]) + high_seconds
        state["total"] = float(state["total"]) + zone_seconds

    return {
        day: float(state["high"]) / float(state["total"])
        for day, state in totals.items()
        if state["valid"] and float(state["total"]) > 0
    }


def build_workout_insight_frame(all_workouts, perf_by_id, daily_frame, tz):
    """One row per positive-duration workout with pre-workout context.

    Duration is recorded independently of HR and remains a valid outcome when
    HR is missing. Load, intensity, and zone outcomes require at least five
    measured minutes and near-complete HR-time coverage; this prevents gaps in
    the HR stream from being interpreted as low effort.
    """
    import numpy as np
    import pandas as pd

    rows: list[dict] = []
    sleep_context_columns = {
        "sleep_shortfall", "sleep_shortfall_3d", "sleep_midpoint_dev",
        "sleep_midpoint_shift",
        "sleep_awake_fraction", "respiratory_rate_dev",
    }
    context_columns = (
        "sleep_shortfall", "sleep_shortfall_3d", "sleep_midpoint_dev",
        "sleep_midpoint_shift",
        "sleep_awake_fraction",
        "sleep_timing_variability_7d_prior",
        "rhr_dev_prior", "hrv_dev_prior", "respiratory_rate_dev",
        "ctl_prior", "atl_prior", "trimp_prior", "high_zone_fraction_prior",
        "duration_7d_prior", "training_density_7d_prior",
    )
    last_workout_at = None
    last_modality_at: dict[str, datetime] = {}
    prior_load_by_day: dict[date, float] = defaultdict(float)
    prior_duration_by_day: dict[date, float] = defaultdict(float)
    prior_duration_by_modality: dict[
        str, deque[tuple[datetime, float]]
    ] = defaultdict(deque)
    ordered_workouts = sorted(
        all_workouts,
        key=lambda workout: datetime.fromisoformat(
            workout["start_at"].replace("Z", "+00:00")
        ).timestamp(),
    )
    for workout in ordered_workouts:
        computed = perf_by_id.get(workout["id"]) or {}
        event_at = datetime.fromisoformat(
            workout["start_at"].replace("Z", "+00:00")
        )
        start = workout_recorded_start(workout, tz)
        modality = workout_modality(workout.get("type"))
        hours_since_prev_workout = (
            (event_at - last_workout_at).total_seconds() / 3600.0
            if last_workout_at is not None else np.nan
        )
        days_since_prev_modality = (
            (event_at - last_modality_at[modality]).total_seconds() / 86_400.0
            if modality in last_modality_at else np.nan
        )
        day = start.date()
        same_day_prior_load = prior_load_by_day[day]
        same_day_prior_duration = prior_duration_by_day[day]
        try:
            duration_s = float(workout.get("duration_s"))
        except (TypeError, ValueError):
            duration_s = np.nan
        try:
            trimp = float(computed.get("trimp"))
        except (TypeError, ValueError):
            trimp = np.nan
        zones = computed.get("time_in_zones") or {}
        try:
            zone_seconds = sum(float(zones.get(f"z{zone}") or 0.0) for zone in range(1, 6))
        except (TypeError, ValueError):
            zones = {}
            zone_seconds = 0.0

        # Eligibility determines whether this workout can be an outcome row,
        # not whether it existed. Every workout updates recency; every positive
        # measured load updates the day's dose before later sessions.
        last_workout_at = event_at
        last_modality_at[modality] = event_at
        if np.isfinite(trimp) and trimp > 0:
            prior_load_by_day[day] += trimp
        if not np.isfinite(duration_s) or duration_s <= 0:
            continue
        duration_min = duration_s / 60.0
        modality_history = prior_duration_by_modality[modality]
        modality_cutoff = event_at - timedelta(days=28)
        while modality_history and modality_history[0][0] < modality_cutoff:
            modality_history.popleft()
        modality_duration_28d_prior = sum(
            prior_duration for _, prior_duration in modality_history
        )
        prior_duration_by_day[day] += duration_min
        modality_history.append((event_at, duration_min))
        hr_coverage = zone_seconds / duration_s
        hr_outcomes_valid = (
            np.isfinite(trimp)
            and trimp > 0
            and zone_seconds >= MIN_WORKOUT_HR_SECONDS
            and MIN_WORKOUT_HR_COVERAGE <= hr_coverage <= MAX_WORKOUT_HR_COVERAGE
        )
        day_key = pd.Timestamp(start.date())
        context = daily_frame.loc[day_key] if day_key in daily_frame.index else None
        hour = start.hour + start.minute / 60 + start.second / 3600
        theta = 2.0 * math.pi * hour / 24.0
        row = {
            "start_at": pd.Timestamp(start.replace(tzinfo=None)),
            "_event_at": pd.Timestamp(event_at),
            "start_hour": hour,
            "start_sin": math.sin(theta),
            "start_cos": math.cos(theta),
            "modality": modality,
            "hr_coverage_fraction": hr_coverage,
            "energy_intensity": workout_energy_intensity(workout.get("raw")),
            "workout_load": trimp if hr_outcomes_valid else np.nan,
            "workout_duration": duration_min,
            "log_duration": math.log(duration_min),
            "workout_intensity": (
                trimp / (zone_seconds / 60.0) if hr_outcomes_valid else np.nan
            ),
            "high_zone_fraction": (
                float(zones.get("z4") or 0.0) + float(zones.get("z5") or 0.0)
            ) / zone_seconds if hr_outcomes_valid else np.nan,
            "hours_since_prev_workout": hours_since_prev_workout,
            "days_since_prev_modality": days_since_prev_modality,
            "modality_duration_28d_prior": modality_duration_28d_prior,
            "same_day_prior_load": same_day_prior_load,
            "same_day_prior_duration": same_day_prior_duration,
        }
        wake_at_epoch = context.get("wake_at_epoch") if context is not None else np.nan
        wake_hour = context.get("wake_hour") if context is not None else np.nan
        if pd.notna(wake_at_epoch):
            hours_since_wake = (event_at.timestamp() - float(wake_at_epoch)) / 3600.0
        else:
            # Backward-compatible fallback for synthetic/legacy frames. The
            # production frame always carries the exact wake instant.
            hours_since_wake = hour - wake_hour if pd.notna(wake_hour) else np.nan
        valid_hours_since_wake = (
            hours_since_wake if pd.notna(hours_since_wake) and 0 <= hours_since_wake <= 20
            else np.nan
        )
        row["hours_since_wake"] = valid_hours_since_wake
        for column in context_columns:
            value = context.get(column) if context is not None else np.nan
            # A daily sleep row is labelled by the local date on which sleep
            # ended. For a workout before that wake time, those measurements
            # are future information and must not enter the workout model.
            if column in sleep_context_columns and pd.isna(valid_hours_since_wake):
                value = np.nan
            row[column] = value
        rows.append(row)
    if not rows:
        return pd.DataFrame()

    frame = (
        pd.DataFrame(rows)
        .sort_values("_event_at")
        .drop(columns="_event_at")
        .set_index("start_at")
    )
    frame["log_hours_since_prev_workout"] = np.log1p(frame["hours_since_prev_workout"])
    frame["log_days_since_prev_modality"] = np.log1p(frame["days_since_prev_modality"])
    frame["log_modality_duration_28d_prior"] = np.log1p(
        frame["modality_duration_28d_prior"]
    )
    frame["log_same_day_prior_duration"] = np.log1p(
        frame["same_day_prior_duration"]
    )
    for outcome, prior_name in (
        ("workout_load", "load_prev_modality"),
        ("workout_duration", "duration_prev_modality"),
        ("workout_intensity", "intensity_prev_modality"),
        ("energy_intensity", "energy_intensity_prev_modality"),
        ("high_zone_fraction", "high_zone_prev_modality"),
    ):
        # Missing HR outcomes do not replace the last valid modality outcome;
        # duration, which is always present on a retained row, still advances.
        frame[prior_name] = frame.groupby("modality", sort=False)[outcome].transform(
            lambda values: values.ffill().shift(1)
        )
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
    frame = build_daily_insight_frame(
        daily_metrics,
        daily_rows,
        tz,
        workout_duration_by_date(all_workouts, tz),
    )
    high_zones_by_date = daily_high_zone_fraction(all_workouts, perf_by_id, tz)
    frame["high_zone_fraction_prior"] = pd.Series(
        [high_zones_by_date.get(day) for day in index],
        index=frame.index,
        dtype=float,
    ).shift(1)
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
    prior_state = insight_prior_state(prior, expected_version=10)
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
    workout_prior_state = insight_prior_state(workout_prior, expected_version=16)
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
    bike_ef_variance = param("bike_ef_variance", models.Z2_BIKE_EF_VARIANCE)
    treadmill_ef_variance = param("treadmill_ef_variance", models.Z2_TREADMILL_EF_VARIANCE)
    row_ef_variance = param("row_ef_variance", models.Z2_ROW_EF_VARIANCE)
    bike_power_ef_variance = param(
        "bike_power_ef_variance", models.Z2_BIKE_POWER_EF_VARIANCE
    )
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
    logged_kcal_by_date: dict[date, float] = defaultdict(float)
    for wk in all_workouts:
        # Every logged workout's energy is subtracted from the day's active energy
        # below, ambulatory or not — the ambient channel must credit only what the
        # workout channel did NOT already see.
        energy = wk.get("energy_kcal")
        if energy is not None:
            logged_kcal_by_date[workout_local_date(wk, tz)] += float(energy)
        if not models.is_aerobic_modality(wk.get("type")):
            continue
        # v5 (TODO.md §6 Part A step 5): walk/hike are excluded from the WORKOUT
        # channel entirely — not because they don't build, but because their energy
        # is already inside daily active_energy_kcal and the ambient channel below
        # credits it from data that exists whether or not a workout was started.
        # Counting both would double-count, AND would make the index depend on
        # whether the user pressed "start" — the exact defect this task fixes.
        if models.is_ambulatory_modality(wk.get("type")):
            continue
        tiz = zones_by_id.get(wk["id"])
        if not tiz:
            continue
        day = workout_local_date(wk, tz)
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

    # ---- v5 ambulatory AMBIENT channel (TODO.md §6 Part A). Daily active energy
    # is logging-invariant; whatever it holds beyond what logged workouts account
    # for is unlogged activity — overwhelmingly walking. Clamped at 0 because a
    # partially-ingested day can leave logged energy exceeding the day's running
    # total. The sedentary baseline is a low
    # percentile of the user's OWN ambient series, so "an inactive day" is their
    # number, not a constant. ----
    # Where `active_energy` is missing (HAE only began sending it partway through
    # this history, while distance is present throughout), fall back to a day-level
    # estimate from walking+running distance, using a kcal/km ratio fitted to the
    # user's own days that carry BOTH readings. Days with neither stay absent and
    # contribute nothing.
    # Watch-off days (resting_hr absent — the watch computes RHR only on the
    # wrist) get the same rescue even when a reading EXISTS: the phone counts
    # steps from a pocket but sees little energy (an order of magnitude less per km than when worn), so
    # a present-but-tiny value is a floor, not a measurement — see
    # effective_active_kcal. Those days are also excluded from the ratio fit,
    # where their tiny kcal/km would drag the median toward under-crediting the
    # very days the fallback exists to fill.
    kcal_per_km = calibrate_kcal_per_km(
        [
            (float(r["active_energy_kcal"]), float(r["walking_running_distance_m"]))
            for r in daily_metrics
            if r.get("active_energy_kcal") is not None
            and r.get("walking_running_distance_m") is not None
            and r.get("resting_hr") is not None
        ]
    )
    ambient_by_date: dict[date, float] = {}
    for r in daily_metrics:
        active = models.effective_active_kcal(
            r.get("active_energy_kcal"),
            r.get("walking_running_distance_m"),
            kcal_per_km,
            watch_worn=r.get("resting_hr") is not None,
        )
        if active is None:
            continue
        d = date.fromisoformat(r["date"])
        ambient_by_date[d] = max(0.0, active - logged_kcal_by_date.get(d, 0.0))
    sedentary_kcal = sedentary_ambient_baseline(list(ambient_by_date.values()))

    daily_z2_load = [
        w_by_date.get(d, 0.0) + ambient_daily_load(ambient_by_date.get(d), sedentary_kcal)
        for d in days
    ]

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
    # may START producing, never trimmed to what currently exists: OBSERVATIONS
    # begin with the first outdoor GPS ride / first ≥20-min HR-bearing Z1–Z2 run,
    # but each signal enters the LEVEL FUSION only once its detrained baseline is
    # ratified in zone2_fitness_params — see the baseline block below.
    #
    # FIVE EF channels, never mixed (agent_log 34/35 added the last three):
    #   bike_ef        outdoor cycling, m/min per bpm
    #   run_ef         over-ground running, m/min per bpm
    #   treadmill_ef   belt running, m/min per bpm — SAME unit and sport as run_ef
    #                  but a systematically different economy (no air resistance),
    #                  so it is split OUT of run_ef rather than pooled with it. An
    #                  indoor_run silently joining run_ef_obs would score belt
    #                  economy against the outdoor baseline.
    #   row_ef         erg/rowing, m/min per bpm — different sport, own baseline.
    #   bike_power_ef  cycling watts per bpm — a DIFFERENT UNIT entirely, read from
    #                  computed_workout.power_ef, never from `ef`.
    bike_ef_obs: list[tuple[date, float]] = []
    run_ef_obs: list[tuple[date, float]] = []
    treadmill_ef_obs: list[tuple[date, float]] = []
    row_ef_obs: list[tuple[date, float]] = []
    bike_power_ef_obs: list[tuple[date, float]] = []
    for wk in all_workouts:
        perf = perf_by_id.get(wk["id"])
        if not perf:
            continue
        wtype = wk.get("type")
        wday = workout_local_date(wk, tz)
        if perf.get("ef") is not None:
            value = float(perf["ef"])
            if models.is_cycling_modality(wtype):
                # Indoor rides never produce a speed EF (ef_distance_m refuses a
                # trainer's fabricated distance), so this stays the outdoor channel.
                if not models.is_indoor_cycling(wtype):
                    bike_ef_obs.append((wday, value))
            elif models.is_treadmill_run(wtype):
                treadmill_ef_obs.append((wday, value))
            elif models.is_running_modality(wtype):
                run_ef_obs.append((wday, value))
            elif models.is_rowing_modality(wtype):
                row_ef_obs.append((wday, value))
        if perf.get("power_ef") is not None and models.is_cycling_modality(wtype):
            bike_power_ef_obs.append((wday, float(perf["power_ef"])))
    for obs in (bike_ef_obs, run_ef_obs, treadmill_ef_obs, row_ef_obs, bike_power_ef_obs):
        obs.sort()

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
    #   EF baseline   = owner-ratified in zone2_fitness_params (see below); NEVER
    #     derived from the observation history — a signal born mid-training has no
    #     detrained-era observation to derive one from.
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
    # EF baselines come ONLY from an owner-ratified params value (NULL = the
    # baseline is unidentified → the signal is collected, stored and displayed
    # but WITHHELD from the level fusion — the swim-EF treatment). The previous
    # derivation (first stored observation) proved wrong the day the signal woke:
    # the first-ever outdoor-ride EF (born MID-TRAINING) became its
    # own baseline, so elevation ≡ 0 — a tautology, not a measurement — fused at
    # the model's strongest weight (var 22). That crashed the durable calibration
    # below the floor (D pinned to the floor track across all history) while the
    # confidence band FALSELY collapsed 2.5×. No observation count fixes this:
    # "elevation above the detrained baseline" is unidentifiable from a history
    # with no detrained-era observation, so ratifying the baseline is an explicit
    # modeling decision, not an accident of ingestion order. (The natural
    # candidate: the first post-gap easy Z1–Z2 session's EF, ratified while
    # genuinely detrained.)
    bike_ef_personal_baseline = param("bike_ef_baseline", None)
    run_ef_personal_baseline = param("run_ef_baseline", None)
    # The manual-input channels follow the SAME ratification rule (migration
    # 20260830120000 adds the columns, all NULL). Until the owner ratifies a
    # detrained baseline for one, its observations are computed, stored and
    # displayed but contribute nothing to the level fusion — so wiring these
    # channels changes no model number today.
    treadmill_ef_personal_baseline = param("treadmill_ef_baseline", None)
    row_ef_personal_baseline = param("row_ef_baseline", None)
    bike_power_ef_personal_baseline = param("bike_power_ef_baseline", None)

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
    # ef_top_factor is a RELATIVE economy improvement (baseline → trained), so it
    # applies unchanged to the W/bpm channel as well as the m/min-per-bpm ones —
    # what must never cross channels is the BASELINE, and each has its own.
    treadmill_ef_top_amateur = (
        treadmill_ef_personal_baseline * ef_top_factor
        if treadmill_ef_personal_baseline
        else None
    )
    row_ef_top_amateur = (
        row_ef_personal_baseline * ef_top_factor if row_ef_personal_baseline else None
    )
    bike_power_ef_top_amateur = (
        bike_power_ef_personal_baseline * ef_top_factor
        if bike_power_ef_personal_baseline
        else None
    )

    # Last-known observation per signal ON OR BEFORE each day (None before the first).
    rhr_latest_t = causal_latest(rhr_series, days)
    vo2_latest_t = causal_latest(vo2_series, days)
    bike_latest_t = causal_latest(bike_ef_obs, days)
    run_latest_t = causal_latest(run_ef_obs, days)
    treadmill_latest_t = causal_latest(treadmill_ef_obs, days)
    row_latest_t = causal_latest(row_ef_obs, days)
    bike_power_latest_t = causal_latest(bike_power_ef_obs, days)

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
                    models.staleness_inflated_variance(bike_ef_variance, age),
                )
        # Manual-input indoor channels. Identical elevation architecture, each
        # scored ONLY against its own ratified baseline and its own variance —
        # `treadmill_ef` and `row_ef` share the m/min-per-bpm unit with run/bike EF
        # but never their baselines, and `bike_power_ef` (W/bpm) shares nothing but
        # the shape of the map. All three stay absent from `out` (hence from the
        # fusion) while their baseline param is NULL.
        for name, latest, baseline, top, variance in (
            (
                "treadmill_ef",
                treadmill_latest_t,
                treadmill_ef_personal_baseline,
                treadmill_ef_top_amateur,
                treadmill_ef_variance,
            ),
            ("row_ef", row_latest_t, row_ef_personal_baseline, row_ef_top_amateur, row_ef_variance),
            (
                "bike_power_ef",
                bike_power_latest_t,
                bike_power_ef_personal_baseline,
                bike_power_ef_top_amateur,
                bike_power_ef_variance,
            ),
        ):
            obs = latest[i]
            if obs is None or top is None:
                continue
            elev = models.signal_elevation_score(obs[1], baseline, top, ceiling=c_durable)
            if elev is None:
                continue
            age = (days[i] - obs[0]).days
            out[name] = (elev, models.staleness_inflated_variance(variance, age))
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
        if any(channel in ests for channel in EF_CHANNELS):
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
                    # (staleness-inflated; 0 when the signal is absent). The three
                    # manual-input channels read 0.0 until their baseline is
                    # ratified — present for provenance, contributing nothing.
                    **{
                        name: round(1.0 / ests[name][1], 3) if name in ests else 0.0
                        for name in EF_CHANNELS
                    },
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
    parser.add_argument(
        "--skip-insights",
        action="store_true",
        help="skip the insight finders (slowest stage); used by on-demand runs",
    )
    args = parser.parse_args()
    try:
        run(full=args.full, skip_insights=args.skip_insights)
    except Exception as e:  # noqa: BLE001 — fail loudly for Actions
        print(f"metrics job failed: {e}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
