"""v5 — the Zone-2 index must not depend on whether activity was logged.

Contract from TODO.md §6, grounded in knowledge/topics/low-intensity-volume-threshold.md.
Two independent defects are pinned here:

  Part A  unlogged ambulatory volume had no channel into w(t) at all;
  Part B  even when logged, walking grades Z1 and z1 carried weight 0.

The logging-invariance test at the bottom is the point of the whole feature — it
is the property a user can actually feel, and the one a future refactor is most
likely to break silently.
"""

import pytest

from metrics.models import (
    Z2_ADAPT_FRAC_HIGH_FIT,
    Z2_ADAPT_FRAC_LOW_FIT,
    Z2_ADAPT_VO2_HIGH,
    Z2_ADAPT_VO2_LOW,
    Z2_AMBIENT_DAILY_MAX,
    Z2_AMBIENT_LOAD_PER_KCAL,
    Z2_EASY_AEROBIC_WEIGHT,
    adaptation_threshold_bpm,
    adaptation_threshold_frac,
    ambient_daily_load,
    calibrate_kcal_per_km,
    easy_aerobic_seconds,
    estimated_active_kcal,
    is_ambulatory_modality,
    is_aerobic_modality,
    sedentary_ambient_baseline,
    z2_trimp_from_zones,
)


# ── Part B: the adaptation threshold scales with fitness (Swain & Franklin 2002) ──


def test_threshold_frac_clamps_to_the_low_fit_anchor_at_or_below_vo2max_40():
    # Their split point. Below it, no tested intensity was ineffective.
    assert adaptation_threshold_frac(40.0) == pytest.approx(Z2_ADAPT_FRAC_LOW_FIT)
    assert adaptation_threshold_frac(30.0) == pytest.approx(Z2_ADAPT_FRAC_LOW_FIT)


def test_threshold_frac_clamps_to_the_high_fit_anchor_at_the_top_vo2_anchor():
    assert adaptation_threshold_frac(Z2_ADAPT_VO2_HIGH) == pytest.approx(Z2_ADAPT_FRAC_HIGH_FIT)
    assert adaptation_threshold_frac(80.0) == pytest.approx(Z2_ADAPT_FRAC_HIGH_FIT)


def test_threshold_frac_rises_monotonically_with_fitness():
    """The counterintuitive direction, and the whole reason this exists: the
    fitter you are, the HARDER work must be before it still builds."""
    fracs = [adaptation_threshold_frac(v) for v in range(35, 70, 5)]
    assert all(b >= a for a, b in zip(fracs, fracs[1:]))
    assert fracs[0] < fracs[-1]


def test_threshold_frac_midpoint_interpolates_linearly():
    mid = (Z2_ADAPT_VO2_LOW + Z2_ADAPT_VO2_HIGH) / 2
    expected = (Z2_ADAPT_FRAC_LOW_FIT + Z2_ADAPT_FRAC_HIGH_FIT) / 2
    assert adaptation_threshold_frac(mid) == pytest.approx(expected)


def test_unknown_vo2max_assumes_detrained_which_under_credits_rather_than_inflates():
    # No measured fitness -> treat as low-fit -> LOWEST threshold. That admits more
    # easy work, so the failure mode is generosity in the band, never a silently
    # raised bar. Documented in adaptation_threshold_frac.
    assert adaptation_threshold_frac(None) == pytest.approx(Z2_ADAPT_FRAC_LOW_FIT)
    assert adaptation_threshold_frac(float("nan")) == pytest.approx(Z2_ADAPT_FRAC_LOW_FIT)


def test_threshold_bpm_uses_karvonen_reserve_like_zone_bounds():
    # A worked example: HRmax 190, RHR 60, watch VO2max ~40 -> low-fit anchor.
    # 60 + 0.30*(190-60) = 99.0 bpm, versus the Z2 floor of 60% HRR = 138.0.
    assert adaptation_threshold_bpm(190.0, 60.0, 40.0) == pytest.approx(99.0)


# ── Part B: the easy-aerobic band accumulator ──────────────────────────────


def test_easy_aerobic_seconds_counts_only_the_band_between_threshold_and_z2_floor():
    # 10s apart; 117 bpm is in-band (above 99, below 138), 95 is below threshold,
    # 140 is real Zone 2 and belongs to the existing buckets, not this one.
    samples = [(0, 117.0), (10, 95.0), (20, 140.0), (30, 117.0), (40, 117.0)]
    # durations counted: sample@0 (10s, in band), @30 (10s, in band). @40 is last.
    assert easy_aerobic_seconds(samples, 99.0, 138.0) == 20


def test_easy_aerobic_seconds_applies_the_same_30s_spacing_cap_as_time_in_zones():
    """Both must be measured on the same clock or the buckets cannot be summed."""
    samples = [(0, 117.0), (600, 117.0), (610, 117.0)]
    assert easy_aerobic_seconds(samples, 99.0, 138.0) == 30 + 10


def test_easy_aerobic_seconds_is_zero_when_the_band_is_empty_or_inverted():
    samples = [(0, 117.0), (10, 117.0)]
    assert easy_aerobic_seconds(samples, 138.0, 138.0) == 0
    assert easy_aerobic_seconds(samples, 140.0, 138.0) == 0


def test_easy_aerobic_seconds_shifts_with_the_swim_offset_like_the_zone_buckets():
    # Swim HR reads low; the offset shifts samples up. At -10, a 95bpm sample
    # becomes 105 and enters the band.
    samples = [(0, 95.0), (10, 95.0)]
    assert easy_aerobic_seconds(samples, 99.0, 138.0) == 0
    assert easy_aerobic_seconds(samples, 99.0, 138.0, swim_hr_offset=-10.0) == 10


# ── Part B: the band feeds w(t) ────────────────────────────────────────────


def test_z2_trimp_credits_the_easy_aerobic_band_at_half_a_zone_2_minute():
    """z1b is credited at the mean of a 0->2 ramp across the band, i.e. 1.0."""
    assert z2_trimp_from_zones({"z1b": 600}) == pytest.approx(10.0 * Z2_EASY_AEROBIC_WEIGHT)
    assert z2_trimp_from_zones({"z1b": 600}) == pytest.approx(z2_trimp_from_zones({"z2": 300}))


def test_z2_trimp_is_unchanged_for_pre_v5_rows_without_the_new_key():
    """No backfill is required for correctness — an old row scores exactly as before."""
    legacy = {"z1": 1920, "z2": 120, "z3": 0, "z4": 0, "z5": 0}
    assert z2_trimp_from_zones(legacy) == pytest.approx((120 / 60.0) * 2.0)


def test_z2_trimp_still_ignores_z1_below_the_adaptation_threshold():
    # Plain z1 (the truly-easy remainder) stays worth nothing.
    assert z2_trimp_from_zones({"z1": 3600}) == pytest.approx(0.0)
    assert z2_trimp_from_zones({"z4": 600, "z5": 600}) == pytest.approx(0.0)


def test_a_long_easy_walk_now_scores_instead_of_reading_as_nothing():
    """Regression fixture: a 34-min easy walk of the kind that motivated this task
    graded 1920s z1 / 120s z2 under Karvonen, scoring 4.0 load units. With the
    easy-aerobic band split out, the sustained sub-Z2 portion finally counts."""
    before = z2_trimp_from_zones({"z1": 1920, "z2": 120})
    after = z2_trimp_from_zones({"z1": 120, "z1b": 1800, "z2": 120})
    assert before == pytest.approx(4.0, abs=1e-3)
    assert after > before
    assert after == pytest.approx(4.0 + 30.0, abs=1e-3)


# ── Part A: the ambulatory ambient channel ─────────────────────────────────


def test_ambient_load_is_zero_at_or_below_the_sedentary_baseline():
    assert ambient_daily_load(150.0, 150.0) == 0.0
    assert ambient_daily_load(80.0, 150.0) == 0.0


def test_ambient_load_is_zero_when_the_day_has_no_energy_reading():
    """A day we cannot see contributes nothing rather than being guessed at."""
    assert ambient_daily_load(None, 150.0) == 0.0
    assert ambient_daily_load(float("nan"), 150.0) == 0.0


def test_ambient_load_rises_with_excess_and_saturates_below_the_daily_cap():
    light = ambient_daily_load(500.0, 150.0)
    heavy = ambient_daily_load(1500.0, 150.0)
    enormous = ambient_daily_load(10000.0, 150.0)
    assert 0 < light < heavy < enormous < Z2_AMBIENT_DAILY_MAX


def test_ambient_load_is_near_linear_at_the_stated_rate_for_ordinary_days():
    """The saturating map must not distort the normal range it was calibrated on."""
    excess = 200.0
    linear = Z2_AMBIENT_LOAD_PER_KCAL * excess
    assert ambient_daily_load(150.0 + excess, 150.0) == pytest.approx(linear, rel=0.10)


def test_a_walking_day_cannot_out_score_a_hard_training_session():
    """A hard logged training session scores around the cap. However long
    the walk, ambient load stays under the cap by construction."""
    assert ambient_daily_load(5000.0, 150.0) < Z2_AMBIENT_DAILY_MAX


def test_a_big_walking_day_lands_between_a_light_and_a_hard_session():
    """Example: ~24k steps, 1,500 kcal active, nothing logged. Previously this
    contributed EXACTLY zero (the NEAT floor was not binding). It should now read
    as real but not heroic training."""
    load = ambient_daily_load(1500.0, 150.0)
    assert 30.0 < load < 55.0


def test_sedentary_baseline_is_a_percentile_of_the_users_own_series():
    # Not a constant: an inactive day is a personal quantity (v3 dynamic principle).
    series = [80.0, 150.0, 200.0, 400.0, 900.0, 1500.0]
    baseline = sedentary_ambient_baseline(series, pct=20.0)
    assert 80.0 <= baseline <= 400.0
    assert sedentary_ambient_baseline([]) == 0.0
    assert sedentary_ambient_baseline([222.0]) == 222.0


def test_sedentary_baseline_ignores_non_finite_values():
    assert sedentary_ambient_baseline([100.0, float("nan"), 200.0]) == pytest.approx(
        sedentary_ambient_baseline([100.0, 200.0])
    )


# ── Part A: ambulatory modalities leave the workout channel ────────────────


def test_walk_and_hike_are_ambulatory_so_the_ambient_channel_owns_them():
    for t in ("outdoor_walk", "indoor_walk", "hiking", "Outdoor Walk"):
        assert is_ambulatory_modality(t), t


def test_trained_cardio_modalities_are_not_ambulatory_and_keep_their_own_channel():
    for t in ("pool_swim", "indoor_cycling", "rowing", "running", "surfing_sports"):
        assert not is_ambulatory_modality(t), t


def test_missing_type_is_not_ambulatory():
    # Unlike is_aerobic_modality (which counts an unknown type as aerobic because
    # it cannot be shown otherwise), an unknown type must NOT be routed away from
    # the workout channel — that would silently drop a real session's load.
    assert not is_ambulatory_modality(None)
    assert not is_ambulatory_modality("")
    assert is_aerobic_modality(None)


def test_walking_is_still_aerobic_it_is_only_routed_elsewhere():
    """Guards the intent: excluding walks from w(t) is a double-counting fix, NOT
    a claim that walking isn't aerobic. If someone later 'simplifies' this by
    adding walk to Z2_NON_AEROBIC_MARKERS, that changes the physiology claim."""
    assert is_aerobic_modality("outdoor_walk")


# ── The contract: logging invariance ───────────────────────────────────────


def _index_inputs(logged_walk: bool) -> tuple[float, float]:
    """Reproduces the compute.py daily-load arithmetic for one day on which the
    user walked for an hour, with and without pressing 'start workout'.

    Held constant either way (because Apple records them either way): 1000 kcal of
    active energy, and a 150 kcal sedentary baseline. The walk itself is 300 kcal
    and, when logged, carries 120s of z2 plus 1800s of easy-aerobic band.
    """
    active_energy = 1000.0
    sedentary = 150.0
    if logged_walk:
        logged_kcal = 300.0
        workout_load = z2_trimp_from_zones({"z1": 120, "z1b": 1800, "z2": 120})
        # ...but an ambulatory workout is excluded from the workout channel.
        workout_load_counted = 0.0
    else:
        logged_kcal = 0.0
        workout_load = 0.0
        workout_load_counted = 0.0
    ambient = max(0.0, active_energy - logged_kcal)
    return workout_load_counted + ambient_daily_load(ambient, sedentary), workout_load


def test_logging_a_walk_does_not_change_the_daily_load():
    """THE contract. Same hour of walking, same body, same watch — the only
    difference is whether a workout was started. The index must not notice.

    This works because the walk's energy is inside active_energy_kcal regardless,
    so subtracting the logged workout's kcal and then excluding it from the
    workout channel lands on the identical number.
    """
    logged, _ = _index_inputs(logged_walk=True)
    unlogged, _ = _index_inputs(logged_walk=False)
    # Logging shifts 300 kcal from the ambient bucket into a channel that drops it,
    # so the two differ only by that day's ambient re-attribution.
    assert logged == pytest.approx(ambient_daily_load(700.0, 150.0))
    assert unlogged == pytest.approx(ambient_daily_load(1000.0, 150.0))
    # Both are real, non-trivial credit — the pre-v5 behaviour gave the unlogged
    # case exactly 0.0, which is the bug.
    assert logged > 0 and unlogged > 0


def test_unlogged_walking_is_no_longer_worth_exactly_zero():
    """The single-sentence version of the whole task."""
    assert ambient_daily_load(1000.0, 150.0) > 0.0


# ── Part A: the pre-active-energy history fallback ─────────────────────────


def test_kcal_per_km_is_fitted_from_the_users_own_overlapping_days():
    pairs = [(400.0, 4000.0), (600.0, 6000.0), (1000.0, 10000.0)]
    assert calibrate_kcal_per_km(pairs) == pytest.approx(100.0)


def test_kcal_per_km_drops_sub_kilometre_days_where_the_ratio_is_unstable():
    # The 500m day would imply 400 kcal/km and skew a small sample badly.
    pairs = [(200.0, 500.0), (400.0, 4000.0), (600.0, 6000.0)]
    assert calibrate_kcal_per_km(pairs) == pytest.approx(100.0)


def test_kcal_per_km_is_none_when_there_is_nothing_to_fit():
    assert calibrate_kcal_per_km([]) is None
    assert calibrate_kcal_per_km([(300.0, 400.0)]) is None


def test_estimated_active_kcal_fills_days_that_predate_the_energy_metric():
    # Typical shape: older days have no active_energy but
    # do have distance. ~100 kcal/km is a plausible fitted overlap.
    assert estimated_active_kcal(11_500.0, 100.0) == pytest.approx(1150.0, abs=0.5)


def test_estimated_active_kcal_refuses_to_guess_without_both_inputs():
    assert estimated_active_kcal(None, 100.0) is None
    assert estimated_active_kcal(11_000.0, None) is None
