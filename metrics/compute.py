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


def perf_series_by_date(all_workouts, perf_by_id, tz) -> dict[date, dict[str, list[float]]]:
    """Per-day performance readings: EF / decoupling / HRR60 collected over that
    day's workouts (averaged downstream). The EF series is SWIM-ONLY: since
    ef_eligibility extended to bikes (v3 — bike EF is the durable calibration's
    lead signal), a per-day average mixing swim EF (~0.5–1.5 m/min/bpm) with bike
    EF (~2–4 m/min/bpm) would be incomparable units and corrupt the correlation/
    DLM series; gating on swim preserves its original meaning. Decoupling and
    HRR60 are relative/HR-domain quantities and stay cross-sport."""
    perf_by_date: dict[date, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for w in all_workouts:
        perf = perf_by_id.get(w["id"])
        if not perf:
            continue
        day = local_date(w["start_at"], tz)
        is_swim = "swim" in (w.get("type") or "").lower()
        for key, col in (("ef", "ef"), ("decoupling_pct", "decoupling"), ("hrr60", "hrr60")):
            if perf[key] is None:
                continue
            if col == "ef" and not is_swim:
                continue
            perf_by_date[day][col].append(float(perf[key]))
    return perf_by_date


def run_insights(sb, all_workouts, daily_metrics, daily_rows, tz) -> None:
    import pandas as pd

    from metrics.insights import compute_correlations, ef_dlm, weight_series, zscore_trailing

    # per-day performance: EF (swim-only) / decoupling / HRR60 per day
    perf_by_id = {r["workout_id"]: r for r in db.fetch_computed_workouts(sb)}
    perf_by_date = perf_series_by_date(all_workouts, perf_by_id, tz)

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
    # B decays through an off-gap, and each day is stamped with the B of ITS OWN
    # week — never today's. ----
    week_keys = iso_weeks_spanning(days)
    weekly_series = [weekly_z2_min.get(k, 0.0) for k in week_keys]
    b_by_week = models.base_consolidation_series(weekly_series, b_ref=b_ref)
    week_index = {k: i for i, k in enumerate(week_keys)}
    b_t: list[float] = []
    for d in days:
        iso = d.isocalendar()
        b_t.append(b_by_week[week_index[(iso.year, iso.week)]])
    tau_slow_t = [models.tau_slow(b, tau_min=tau_slow_min, tau_max=tau_slow_max) for b in b_t]
    # floor as a [0,100] share; the D-space floor is the same share of C_D.
    floor_pct_t = [models.durable_floor_score(b, f_max=f_max, p=floor_p) for b in b_t]
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
    bike_ef_obs: list[tuple[date, float]] = []  # swim EF stays WITHHELD (docs §6)
    for wk in all_workouts:
        perf = perf_by_id.get(wk["id"])
        if not perf or perf.get("ef") is None:
            continue
        wtype = (wk.get("type") or "").lower()
        if "cycl" in wtype or "bik" in wtype:
            bike_ef_obs.append((local_date(wk["start_at"], tz), float(perf["ef"])))
    bike_ef_obs.sort()

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
    #   RHR baseline  = trailing-180d MAX  (highest resting HR = most detrained)
    #   VO2max baseline = trailing MIN     (lowest VO2max = most detrained)
    #   EF baseline   = earliest/most-detrained EF (first bike EF observed)
    rhr_personal_baseline = max(rhr_window) if rhr_window else None
    vo2_personal_baseline = min(vo2_window) if vo2_window else None
    bike_ef_personal_baseline = bike_ef_obs[0][1] if bike_ef_obs else None

    # Population priors, used ONLY to seed the baseline while history is thin; their
    # weight → 0 as valid days accrue (v3 pt5: no fixed 68/32 once own data exists).
    rhr_baseline = models.blended_baseline(
        rhr_personal_baseline, models.Z2_RHR_POP_BASELINE, valid_days=len(rhr_window)
    )
    vo2_baseline = models.blended_baseline(
        vo2_personal_baseline, models.Z2_VO2MAX_POP_BASELINE, valid_days=len(vo2_window)
    )
    # Top-amateur EF ≈ ef_top_factor × the user's own detrained baseline (economy
    # improves ~40-60% baseline→trained; a personal, not fixed, target).
    ef_top_amateur = (
        bike_ef_personal_baseline * ef_top_factor if bike_ef_personal_baseline else None
    )

    # Last-known observation per signal ON OR BEFORE each day (None before the first).
    rhr_latest_t = causal_latest(rhr_series, days)
    vo2_latest_t = causal_latest(vo2_series, days)
    bike_latest_t = causal_latest(bike_ef_obs, days)

    # ---- the LEVEL fusion (v4 redesign) — absolute D-space variances, each ×
    # per-day staleness inflation (documented derivations at the constants in
    # models.py):
    #   bike EF (var 22)     — the aerobic-specific trusted LEAD (v3 pt3).
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

    # ---- pre-compute the FULL index track so SWC is DATA-DERIVED from the user's
    # OWN recent index NOISE (v3 pt6; residuals vs a 7-day rolling mean so a build
    # block's ramp cannot masquerade as noise), not a constant. ----
    index_track: list[float] = []
    for i in range(len(days)):
        d_i = durable_base_track[i]
        f_i = models.fast_score_from_load(series[i][1], fast_ceiling=c_fast, fast_sat=fast_sat)
        index_track.append(d_i + f_i)
    recent_index = index_track[-60:]  # trailing ~2 months of the user's own index
    swc = models.swc_from_index(recent_index)

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

        # ---- v3 pt6: PROJECTION-DERIVED decay_onset horizon (continuous), from
        # the model's OWN projection of THIS day's (D, F, floor_t, τ_slow_t) + the
        # data-derived SWC. Stored CONTINUOUS on the numeric warn_after_days col. ----
        decay_onset = models.decay_onset_days(
            durable=durable_base,
            fast=sharpness,
            floor=floor_d_t[i],
            tau_slow_days=tau_slow_t[i],
            swc=swc,
            tau_fast=tau_fast,
        )

        # ---- v3 pt6 horizons. w̄ = median stimulus of qualifying-session days in
        # the trailing τ_slow(B_t) window (data-linked); Hickson fallback inside.
        # ΔI/ΔF = one session-day at w̄ vs a rest day, from THIS day's state. ----
        horizon_window = max(1, int(round(tau_slow_t[i])))
        qualifying_loads = [
            daily_z2_load[j]
            for j in range(max(0, i - horizon_window + 1), i + 1)
            if z2_session_dates.get(days[j], 0) > 0
        ]
        w_bar = models.expected_session_stimulus(qualifying_loads)
        delta_i, delta_f = models.expected_session_build(
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
        # the last day one expected session still holds the level: I(0)−I(t) ≥ ΔI
        maintain_horizon = models.decay_onset_days(
            durable=durable_base,
            fast=sharpness,
            floor=floor_d_t[i],
            tau_slow_days=tau_slow_t[i],
            swc=max(0.0, delta_i),
            tau_fast=tau_fast,
        )
        # fast-decay-limited build cadence, capped at the beginner build dose (2 d)
        build_interval = models.build_interval_days(sharpness, delta_f, tau_fast=tau_fast)

        # per-day CAUSAL vo2 provenance: most recent reading on-or-before this day
        # (None before the first — never negative days-since).
        vo2_obs = vo2_latest_t[i]
        days_since = (day - vo2_obs[0]).days if vo2_obs is not None else None
        vo2max_anchor_score = (
            models.vo2max_to_score(vo2_obs[1]) if vo2_obs is not None else None
        )

        # ---- confidence + band from THIS day's staleness-inflated fusion (§6c):
        # posterior SD vs the flat prior — continuous, data-derived; the old
        # valid_signals/4 step lookup and the 6+18 band constants are gone. With
        # only the (soft) B-prior in the fusion, posterior_sd ≈ C_D/4 → a LOW
        # confidence and a WIDE band — the desired honesty: no aerobic-specific
        # anchor exists yet, so the level is trustworthy on trend only. ----
        ests = level_estimates(i)
        rhr_elev = rhr_elevation(i)  # corroborator, never fused (v3 pt3)
        fused = models.fuse_inverse_variance(list(ests.values()))
        # a fusion that includes the flat prior can never exceed the prior's SD
        posterior_sd = min(fused[1], prior_sd) if fused is not None else prior_sd
        confidence = models.confidence_from_posterior(posterior_sd, prior_sd)
        half_width = min(1.96 * posterior_sd, models.ZONE2_INDEX_CEILING)  # 95% band
        band_lo = max(0.0, index - half_width)
        band_hi = min(models.ZONE2_INDEX_CEILING, index + half_width)

        # ---- evidence_state (spec §6d) — a categorical LABEL (the numbers stay
        # continuous); counts corroborating signals present around this day.
        # RHR still feeds this exactly as before (via rhr_dev) — demoted from the
        # LEVEL, not from the evidence accounting. ----
        drow = daily_rows[i]
        load_moved = any(w > 0 for w in daily_z2_load[max(0, i - 6): i + 1])
        valid_signals = 0
        if load_moved:
            valid_signals += 1
        if "bike_ef" in ests:
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

        # ---- zone2_maintenance flag firing rule (spec §5c): read the two pools'
        # NORMALIZED relationship (F/C_F fading below D/C_D), never their sum.
        # Persistence threshold derives from the continuous decay_onset. ----
        flags = models.zone2_maintenance_flag(
            maintenance_met=met,
            consecutive_unmet_days=unmet_run,
            warn_after_days=decay_onset,
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
                    "bike_ef": round(1.0 / ests["bike_ef"][1], 3) if "bike_ef" in ests else 0.0,
                    # corroborator, not level-setter (v3 pt3: strength-confounded)
                    # — the elevation is computed (rhr_elev) for provenance but
                    # its level weight is 0.0 BY DESIGN.
                    "rhr": 0.0,
                    "vo2max": round(1.0 / ests["vo2max"][1], 3) if "vo2max" in ests else 0.0,
                    "b_prior": round(1.0 / ests["b_prior"][1], 4),  # always present
                    "swim_ef": 0.0,  # WITHHELD (technique confound, docs §6)
                    "hrv": 0.0,      # weak corroborator; not in the durable calibration
                    "load": 1.0 if load_moved else 0.0,
                },
                "stage": stage,
                "maintenance_met": met,
                # v3 pt6 horizons — all CONTINUOUS, projection-derived, per-day.
                # A horizon at the projection-search cap means "no meaningful
                # drop within the window" (already at/near floor), NOT a real
                # date — stored NULL so the renderer omits that marker instead
                # of rendering a fake-precise day-120 calendar day.
                "warn_after_days": _uncapped(decay_onset),
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
        f"(B={b_t[-1]:.2f}, τ_slow={tau_slow_t[-1]:.0f}d, calib_load={calib_load:.1f}, "
        f"calib_score={f'{calib_score:.1f}' if calib_score is not None else 'none'}, "
        f"SWC={swc:.2f}, conf={last['confidence']:.2f}, warn={_fmt_days(last['warn_after_days'])}, "
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
