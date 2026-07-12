# Shared data context — schema, metric definitions, quirks

Loaded by every data-touching mode.

## Metric definitions (as computed in this system)

- **TRIMP (Edwards)**: per workout, minutes in each heart-rate zone × the zone number (1–5), summed. Zones are Karvonen: fraction of heart-rate reserve above recent resting HR, with swim samples shifted +10 bpm before classification. It is the system's single training-load unit.
- **CTL / ATL / TSB**: exponentially weighted averages of daily TRIMP with 42-day and 7-day time constants; TSB = CTL − ATL. CTL ≈ fitness trend, ATL ≈ recent fatigue, negative TSB = carrying fatigue.
- **ACWR**: mean TRIMP of the last 7 days ÷ mean of the last 28. Values well above ~1.5 indicate a fast ramp; null with under 21 days of history.
- **EF (efficiency factor)**: swims only — (meters per minute) ÷ average HR, computed only when ≥70% of the session sat in Z1–Z2 and it lasted ≥20 min. Rising EF at constant effort = aerobic base improving.
- **Decoupling**: for EF-eligible swims, HR drift between first and second half of the session ((avgHR₂−avgHR₁)/avgHR₁ × 100). Under ~5% = aerobically steady.
- **HRR60**: heart-rate drop 60s after a workout ends; usually null (the export rarely includes post-workout samples).
- **SWOLF₍25₎**: per swim set, (seconds + 2×strokes) normalized per 25 m of that set. Stored strokes are Apple watch-arm counts (≈ one per stroke cycle); doubling converts to the textbook both-hands convention — exact for freestyle/backstroke, overcounts breast/fly (accepted: freestyle is the assumed stroke, and HAE never exports stroke style). Lower is better at equal effort; compare within similar set distances.
- **rhr_dev / hrv_dev**: 7-day median resting HR (or HRV) minus its 60-day baseline median.
- **weight_7d_slope**: body-weight trend in kg/week — the 7-day rolling mean of daily weight (forward-filled up to 3 days to bridge sparse weigh-ins) minus that same rolling mean 7 days earlier. Treated as a slow OUTCOME variable in the insights layer, not a daily driver — correlations test it against sleep, rhr_dev, hrv_dev, and prior training load, not the other way around.

## Schema summary

- `workouts(id, external_id, type, start_at, end_at, duration_s, distance_m, energy_kcal, avg_hr, max_hr, raw)` — types like `pool_swim`, `functional_strength_training`, `indoor_cycling`, `rowing`.
- `workout_hr_samples(workout_id, offset_s, bpm)` — per-second HR traces.
- `workout_swim_samples(workout_id, offset_s, distance_m, strokes)` — per-second swim series for pool swims (meters/strokes attributed to each second; seconds with no row = resting).
- `swim_sets(workout_id, set_index, start_offset_s, duration_s, distance_m, strokes, rest_after_s)` — ingest-detected swim sets (new set after a >10s sampling gap; `rest_after_s` null on the last set). Pace and SWOLF are derived, not stored: `pace_s_per_100m = 100*duration_s/distance_m`; `swolf25 = (duration_s + 2*strokes)/(distance_m/25)` (stored strokes are watch-arm cycles; ×2 converts to both-hands, freestyle assumption).
- `daily_metrics(date, resting_hr, hrv_sdnn_ms, respiratory_rate, sleep_start, sleep_end, sleep_duration_min, sleep_stages, vo2max, steps, active_energy_kcal, wrist_temp_deviation_c, state_of_mind, weight_kg)`.
- `computed_workout(workout_id, time_in_zones, trimp, ef, decoupling_pct, hrr60)`.
- `computed_daily(date, trimp_total, ctl, atl, tsb, acwr, rhr_baseline_60d, rhr_dev, hrv_baseline_60d, hrv_dev, flags)`.
- `insight_correlations(var_x, var_y, lag_days, r, n, p_value)` and `insight_models(name, spec, coefficients, diagnostics)`.
- `user_config(hr_max, swim_hr_offset, zone2_low_frac, zone2_high_frac, weekly_min_sessions, zone2_weekly_target_min, timezone)` — single row.
- `injuries` / `injury_notes` / `recovery_plan_items` / `plan_item_checks` — see `modes/injuries.md`.
- `goals` / `goal_progress` — see `modes/goals.md`.

Data quirks: watch data covers only the recent part of the record (check the earliest `daily_metrics` date); resting HR / HRV / sleep exist on ~half of days (watch not always worn); `distance_m` exists only for swims and walks.
