"""Zone 2 fitness model tests — fixtures derived directly from
docs/zone2-fitness-model.md (the acceptance gates in §11). These define the
contract; models.py implements exactly this. Every load-bearing equation and
constant is pinned so a later edit cannot silently drift the physiology."""

import math

import pytest

from metrics.models import (
    Z2_BUILD_FREQ_BEGINNER,
    Z2_BUILD_FREQ_SLOPE,
    Z2_BUILD_INTERVAL_FLOOR_DAYS,
    Z2_MAINTENANCE_SESSION_LOAD,
    Z2_RHR_POP_BASELINE,
    Z2_SIGNAL_STALENESS_TAU_DAYS,
    Z2_VO2MAX_POP_BASELINE,
    ZONE2_DURABLE_CEILING,
    ZONE2_FAST_CEILING,
    ZONE2_FAST_SAT,
    ZONE2_INDEX_CEILING,
    ZONE2_MAINTENANCE_MESSAGE,
    base_consolidation,
    base_consolidation_series,
    blended_baseline,
    build_cadence_days,
    confidence_from_posterior,
    decay_onset_days,
    durable_base_series,
    durable_calibration_slope,
    durable_erosion_onset_days,
    durable_floor_score,
    durable_score_from_percentile,
    ewma_alpha,
    expected_session_build,
    expected_session_stimulus,
    fast_score_from_load,
    fuse_inverse_variance,
    is_aerobic_modality,
    personal_baseline_weight,
    project_index,
    signal_elevation_score,
    staleness_inflated_variance,
    tau_slow,
    vo2max_to_score,
    z2_durable_sharpness_series,
    z2_trimp_from_zones,
    zone2_maintenance_flag,
)


# ---------------------------------------------------------------------------
# §4b — vo2max_to_score: anchor points + clamps
# ---------------------------------------------------------------------------
def test_vo2max_to_score_anchor_points():
    # The three locked anchors from spec §4b.
    assert vo2max_to_score(30) == pytest.approx(20.0)
    assert vo2max_to_score(48) == pytest.approx(55.0)  # population median = the knee
    assert vo2max_to_score(62) == pytest.approx(100.0)  # 90th pct ceiling


def test_vo2max_to_score_intermediate_points():
    # Spec §4b lists 40→39 and 55→77 as the DISPLAY-rounded points; the exact
    # piecewise-linear map yields 39.44 and 77.5 (both round down to the spec's
    # labels). We pin the exact math so a later edit can't drift the slope.
    assert vo2max_to_score(40) == pytest.approx(20 + (40 - 30) * (55 - 20) / (48 - 30))
    assert vo2max_to_score(40) == pytest.approx(39.444, abs=1e-3)
    assert vo2max_to_score(55) == pytest.approx(55 + (55 - 48) * (100 - 55) / (62 - 48))
    assert vo2max_to_score(55) == pytest.approx(77.5)
    # both floor to the spec's stated display anchors
    assert math.floor(vo2max_to_score(40)) == 39
    assert math.floor(vo2max_to_score(55)) == 77


def test_vo2max_to_score_clamps_both_ends():
    assert vo2max_to_score(20) == 20.0  # deconditioned floor, clamped
    assert vo2max_to_score(0) == 20.0
    assert vo2max_to_score(70) == 100.0  # above the 90th-pct ceiling, clamped
    assert vo2max_to_score(120) == 100.0


# ---------------------------------------------------------------------------
# §3 — tau_slow(B) = 45 + 45*B, clamped
# ---------------------------------------------------------------------------
def test_tau_slow_endpoints():
    assert tau_slow(0.0) == pytest.approx(45.0)  # beginner
    assert tau_slow(1.0) == pytest.approx(90.0)  # consolidated
    assert tau_slow(0.5) == pytest.approx(67.5)


def test_tau_slow_clamps_out_of_range_b():
    assert tau_slow(-1.0) == pytest.approx(45.0)
    assert tau_slow(2.0) == pytest.approx(90.0)


# ---------------------------------------------------------------------------
# §3 — FLOOR_score(B) = f_max*100*B^1.5 (score units, ceiling 55 at B=1)
# ---------------------------------------------------------------------------
def test_durable_floor_score():
    assert durable_floor_score(0.0) == pytest.approx(0.0)  # no unearned floor for a beginner
    assert durable_floor_score(1.0) == pytest.approx(55.0)  # veteran retains ~55% ceiling
    # B=0.25 -> 0.55*100*0.25^1.5 = 6.875
    assert durable_floor_score(0.25) == pytest.approx(0.55 * 100 * 0.25 ** 1.5)


def test_durable_floor_score_p_shape_no_early_floor():
    # p=1.5 keeps the floor small until real base accrues.
    assert durable_floor_score(0.1) < 2.0


# ---------------------------------------------------------------------------
# §3 — B from weekly Z2 minutes (long-window EWMA, normalized by b_ref, clamped)
# ---------------------------------------------------------------------------
def test_base_consolidation_empty_is_zero():
    assert base_consolidation([]) == 0.0


def test_base_consolidation_clamped_to_one():
    # A very long history well above b_ref saturates to 1.0.
    assert base_consolidation([400.0] * 200, b_ref=200.0) == pytest.approx(1.0)


def test_base_consolidation_matches_ewma_recurrence():
    alpha_b = 1 - math.exp(-7 / 180)
    weeks = [200.0, 150.0, 220.0]
    b_raw = 0.0
    for wk in weeks:
        b_raw += alpha_b * (wk - b_raw)
    assert base_consolidation(weeks, b_ref=200.0) == pytest.approx(min(1.0, b_raw / 200.0))


# ---------------------------------------------------------------------------
# §1 — z2_trimp_from_zones: Edwards z2 weight + half-credit z3, z1/z4/z5 = 0
# ---------------------------------------------------------------------------
def test_z2_trimp_from_zones_formula():
    tiz = {"z1": 6000, "z2": 1800, "z3": 600, "z4": 300, "z5": 120}
    # z2: 30min*2 = 60 ; z3: 10min*3*0.5 = 15 ; z1/z4/z5 ignored -> 75
    assert z2_trimp_from_zones(tiz) == pytest.approx(30 * 2 + 10 * 3 * 0.5)
    assert z2_trimp_from_zones(tiz) == pytest.approx(75.0)


def test_z2_trimp_from_zones_ignores_anaerobic_and_easy_bands():
    # Only z4/z5/z1 present -> zero aerobic-base stimulus.
    assert z2_trimp_from_zones({"z1": 3600, "z4": 600, "z5": 600}) == pytest.approx(0.0)


def test_z2_trimp_from_zones_accepts_int_keys():
    assert z2_trimp_from_zones({2: 1800, 3: 600}) == pytest.approx(75.0)


# ---------------------------------------------------------------------------
# §2 — EWMA identity vs a hand-computed short series
# ---------------------------------------------------------------------------
def test_ewma_alpha_matches_definition():
    assert ewma_alpha(14) == pytest.approx(1 - math.exp(-1 / 14))
    assert ewma_alpha(14) == pytest.approx(0.0690, abs=1e-4)


def test_z2_durable_sharpness_series_ewma_identity():
    # Hand-compute both EWMAs on a short series, floor=0 (beginner). With
    # constant positive load the compartment only ever rises, so the floor rule
    # never triggers and both are plain EWMAs.
    loads = [10.0, 10.0, 10.0]
    tau_fast, tau_slow_days = 14.0, 45.0
    af = 1 - math.exp(-1 / tau_fast)
    as_ = 1 - math.exp(-1 / tau_slow_days)
    sharp = durable = 0.0
    expected = []
    for w in loads:
        sharp += af * (w - sharp)
        durable += as_ * (w - durable)
        expected.append((durable, sharp))

    got = z2_durable_sharpness_series(loads, tau_fast=tau_fast, tau_slow_days=tau_slow_days, floor_load=0.0)
    for (gd, gs), (ed, es) in zip(got, expected):
        assert gd == pytest.approx(ed)
        assert gs == pytest.approx(es)


def test_z2_sharpness_faster_than_durable():
    # Same input, τ_fast=14 vs τ_slow=45: sharpness rises faster on a build.
    loads = [20.0] * 30
    got = z2_durable_sharpness_series(loads, tau_fast=14.0, tau_slow_days=45.0, floor_load=0.0)
    durable_final, sharp_final = got[-1]
    assert sharp_final > durable_final


# ---------------------------------------------------------------------------
# §2c — durable decay never falls below the floor
# ---------------------------------------------------------------------------
def test_durable_decay_never_below_floor():
    # Build up, then a long lay-off (w=0). Durable must decay toward FLOOR_load
    # and never dip below it. Use a non-trivial floor.
    floor = 12.0
    loads = [30.0] * 40 + [0.0] * 200
    got = z2_durable_sharpness_series(loads, tau_fast=14.0, tau_slow_days=45.0, floor_load=floor)
    durable_track = [d for d, _ in got]
    # after the build the compartment is above the floor
    assert durable_track[39] > floor
    # through the entire lay-off it never drops below the floor
    assert all(d >= floor - 1e-9 for d in durable_track[40:])
    # and it is decaying toward the floor (approaches it from above)
    assert durable_track[-1] == pytest.approx(floor, abs=0.5)


def test_durable_decay_to_zero_floor_for_beginner():
    # Beginner floor ~0 (B≈0): a lay-off decays toward ~0, physiologically correct.
    loads = [30.0] * 40 + [0.0] * 300
    got = z2_durable_sharpness_series(loads, tau_fast=14.0, tau_slow_days=45.0, floor_load=0.0)
    assert got[-1][0] == pytest.approx(0.0, abs=0.5)


# ---------------------------------------------------------------------------
# §4c (v3 fix) — continuous staleness decay of a signal's evidential weight:
# variance_eff = variance · exp(days_since / τ_staleness). Replaces the dead
# anchor_beta machinery: a months-old reading yields instead of pinning the level.
# ---------------------------------------------------------------------------
def test_staleness_inflated_variance_formula():
    # fresh reading: unchanged. one τ old: ×e. two τ old: ×e².
    assert staleness_inflated_variance(4.0, 0) == pytest.approx(4.0)
    assert staleness_inflated_variance(4.0, Z2_SIGNAL_STALENESS_TAU_DAYS) == pytest.approx(
        4.0 * math.e
    )
    assert staleness_inflated_variance(4.0, 2 * Z2_SIGNAL_STALENESS_TAU_DAYS) == pytest.approx(
        4.0 * math.e**2
    )


def test_staleness_is_continuous_and_monotone_never_gains_weight():
    # variance strictly grows with age (weight strictly falls) — no freshness band.
    variances = [staleness_inflated_variance(1.0, d) for d in (0, 1, 10, 45, 100, 365)]
    assert all(b > a for a, b in zip(variances, variances[1:]))
    # a (nonsensical) negative age clamps at 0: a reading can never GAIN weight.
    assert staleness_inflated_variance(1.0, -30) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# §6c — inverse-variance fusion: weighted mean + posterior SD
# ---------------------------------------------------------------------------
def test_fuse_inverse_variance_weighted_mean_and_sd():
    # Two estimates: (50, var 4) and (60, var 1). Weights 0.25 and 1.0.
    fused, sd = fuse_inverse_variance([(50.0, 4.0), (60.0, 1.0)])
    assert fused == pytest.approx((50 * 0.25 + 60 * 1.0) / 1.25)
    assert sd == pytest.approx(math.sqrt(1 / 1.25))


def test_fuse_inverse_variance_skips_nonpositive_variance():
    fused, sd = fuse_inverse_variance([(50.0, 0.0), (60.0, 1.0), (70.0, -1.0)])
    assert fused == pytest.approx(60.0)
    assert sd == pytest.approx(1.0)


def test_fuse_inverse_variance_none_when_no_usable():
    assert fuse_inverse_variance([]) is None
    assert fuse_inverse_variance([(1.0, 0.0)]) is None


# ===========================================================================
# v3 — PROJECTION-DERIVED decay_onset (docs v3 pt6). REPLACES the warn_after_days
# 7/12/21 band lookup. The horizon is a CONTINUOUS function of the model's own
# projection (D, F, floor, τ_slow) + a data-derived SWC — verified to move
# continuously (thin < banked), NOT as a step function.
# ===========================================================================

# ---- v4 "eases" horizon = erosion of the DURABLE base past the confidence band
# (durable_erosion_onset_days). Durable-only (no fast layer) + band-gated, so it
# never fires on the fast layer's post-session dip and never on sub-band noise. ----
def test_durable_erosion_returns_cap_when_base_thinner_than_band():
    # Thin base: the whole durable range (D−floor = 7.2) is smaller than the band
    # (19) → the base can NEVER erode by a band → search cap (→ NULL, no marker).
    from metrics.models import Z2_DECAY_ONSET_MAX_DAYS

    assert durable_erosion_onset_days(
        durable=7.5, floor=0.3, tau_slow_days=47.0, band_half_width=19.0
    ) == pytest.approx(Z2_DECAY_ONSET_MAX_DAYS)


def test_durable_erosion_fires_when_base_can_lose_a_band():
    # Banked base (D=45, floor=10 → reach 35) with a tighter band (10): the base
    # CAN lose 10 pts, so a real, finite horizon exists — hand-check it solves
    # floor + (D−floor)·e^(−t/τ) = D − band, i.e. e^(−t/τ) = (reach−band)/reach.
    reach, band, tau = 35.0, 10.0, 60.0
    t = durable_erosion_onset_days(durable=45.0, floor=10.0, tau_slow_days=tau, band_half_width=band)
    expected = -tau * math.log((reach - band) / reach)
    assert t == pytest.approx(expected, abs=0.05)


def test_durable_erosion_ignores_the_fast_layer():
    # The horizon depends only on the DURABLE base — a huge fast layer (which the
    # v3 index projection would have shed fast, giving a short warning) does not
    # shorten it, because the fast layer is not projected here at all.
    from metrics.models import Z2_DECAY_ONSET_MAX_DAYS

    thin = durable_erosion_onset_days(
        durable=7.5, floor=0.3, tau_slow_days=47.0, band_half_width=19.0
    )
    assert thin == pytest.approx(Z2_DECAY_ONSET_MAX_DAYS)  # fast layer irrelevant


# ---- project_index: fast decays at τ_fast, durable toward floor at τ_slow ----
def test_project_index_t0_is_current_and_decays_toward_floor():
    D, F, floor, tau_slow_days = 40.0, 10.0, 15.0, 60.0
    assert project_index(D, F, floor, tau_slow_days, 0.0) == pytest.approx(D + F)
    # far future: F→0, D→floor, so I→floor
    assert project_index(D, F, floor, tau_slow_days, 1e6) == pytest.approx(floor)
    # fast layer alone at one τ_fast: F·(1/e) contribution
    i_at_tau_fast = project_index(D, 0.0, floor, tau_slow_days, 14.0, tau_fast=14.0)
    d_only = floor + (D - floor) * math.exp(-14.0 / tau_slow_days)
    assert i_at_tau_fast == pytest.approx(d_only)


# ---- decay_onset_days: thin base SHORT, banked base LONG, emergent + continuous ----
def test_decay_onset_thin_base_shorter_than_banked_base():
    swc = 1.0
    # THIN base: small durable near a ~0 floor, fast layer dominates -> falls at
    # ~τ_fast -> a SHORT horizon.
    thin = decay_onset_days(durable=8.0, fast=12.0, floor=0.0, tau_slow_days=45.0, swc=swc)
    # BANKED base: large durable, high floor, small fast layer -> falls at ~τ_slow
    # -> a LONG horizon.
    banked = decay_onset_days(durable=60.0, fast=4.0, floor=45.0, tau_slow_days=90.0, swc=swc)
    assert thin < banked
    assert thin > 0.0  # a real, finite horizon


def _banked_horizon(frac: float, swc: float = 1.0) -> float:
    """Map a base-consolidation fraction (0=thin, 1=banked) to a projection-derived
    decay-onset horizon. As a base banks, ALL of its state co-moves: durable rises,
    the erodable gap (D−floor) shrinks (an elevated floor), the fast layer shrinks,
    and τ_slow lengthens. The horizon emerges from decay_onset_days on that state."""
    d = 8.0 + frac * (66.0 - 8.0)          # durable 8 -> 66
    gap = (1.0 - frac) * d * 0.8 + 0.5     # erodable gap shrinks as the base banks
    floor = max(0.0, d - gap)
    fast = 14.0 * (1.0 - frac) + 1.0       # fast layer 15 -> 1
    tau_slow_days = 45.0 + 45.0 * frac     # 45 -> 90
    return decay_onset_days(
        durable=d, fast=fast, floor=floor, tau_slow_days=tau_slow_days, swc=swc
    )


def test_decay_onset_moves_continuously_thin_shorter_than_banked():
    # Sweep the base from thin to banked; the horizon must move CONTINUOUSLY and be
    # SHORT for a thin base, LONG for a banked one — emergent from the projection,
    # NOT the old 9/14/24 step lookup.
    horizons = [_banked_horizon(f) for f in [0.0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0]]
    # thin < banked, strictly increasing the whole way (a real trend, not 3 bands).
    assert all(b > a for a, b in zip(horizons, horizons[1:]))
    assert horizons[0] < horizons[-1]
    # NOT a step function: 8 inputs -> 8 distinct horizons (a band lookup collapses
    # them onto ~3 levels).
    assert len({round(h, 3) for h in horizons}) == len(horizons)


def test_decay_onset_is_lipschitz_continuous_not_a_step():
    # The definitive continuity proof. For a CONTINUOUS function, halving the input
    # step halves the output jump around a point. A STEP function (the old band
    # lookup) instead keeps a CONSTANT jump when a step straddles a band boundary
    # and a ZERO jump otherwise — never this smooth halving.
    f0 = 0.5
    jumps = [
        abs(_banked_horizon(f0 + s) - _banked_horizon(f0 - s))
        for s in (0.08, 0.04, 0.02, 0.01)
    ]
    # each halving of the step roughly halves the jump (ratio ~0.5), the signature
    # of a smooth (locally-linear) function, not a piecewise-constant one.
    for big, small in zip(jumps, jumps[1:]):
        assert small == pytest.approx(big / 2.0, rel=0.15)
    # and the jump vanishes as the step -> 0 (a step function's would not).
    assert jumps[-1] < jumps[0]


def test_decay_onset_smaller_swc_gives_shorter_horizon():
    # A tighter SWC (a more stable index) trips the warning sooner — continuous in SWC.
    args = dict(durable=40.0, fast=8.0, floor=20.0, tau_slow_days=60.0)
    assert decay_onset_days(swc=0.5, **args) < decay_onset_days(swc=3.0, **args)


def test_decay_onset_caps_when_base_holds():
    # F≈0 and D already at floor: the index can't fall a full SWC -> capped at max.
    assert decay_onset_days(
        durable=20.0, fast=0.0, floor=20.0, tau_slow_days=90.0, swc=2.0, max_days=120.0
    ) == pytest.approx(120.0)


# ---------------------------------------------------------------------------
# §5c — zone2_maintenance fires only after the warn window's worth of consecutive
# unmet days AND form fading below the base on NORMALIZED shares (F/C_F < D/C_D —
# the raw F<D comparison was tautological once D>30), suppressed on injury hold.
# ---------------------------------------------------------------------------
def test_maintenance_flag_fires_after_window_with_form_fading():
    flags = zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=9,
        warn_after_days=9.0,
        sharpness=6.0,       # F share 6/30 = 0.20
        durable_base=45.0,   # D share 45/70 ≈ 0.64 — form genuinely fading
        hold_active=False,
    )
    assert len(flags) == 1
    assert flags[0]["type"] == "zone2_maintenance"
    assert flags[0]["severity"] == "info"  # never an alarm severity
    assert flags[0]["message"] == ZONE2_MAINTENANCE_MESSAGE


def test_maintenance_flag_silent_before_window_elapses():
    # One day short of the (rounded continuous) window: no fire even with form fading.
    assert zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=8,
        warn_after_days=8.6,  # rounds to a 9-day persistence threshold
        sharpness=6.0,
        durable_base=45.0,
        hold_active=False,
    ) == []


def test_maintenance_flag_compares_normalized_shares_not_raw_scales():
    # Raw 28 < 40 would have fired under the old rule, but the SHARES say form is
    # fine: F 28/30 = 0.93 vs D 40/70 = 0.57 — the fast pool is nearly full.
    assert zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=20,
        warn_after_days=9.0,
        sharpness=28.0,
        durable_base=40.0,
        hold_active=False,
    ) == []
    # And the shares respect custom ceilings.
    assert zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=20,
        warn_after_days=9.0,
        sharpness=28.0,       # share 28/40 = 0.70
        durable_base=60.0,    # share 60/80 = 0.75 -> fires
        hold_active=False,
        fast_ceiling=40.0,
        durable_ceiling=80.0,
    ) != []


def test_maintenance_flag_sub_day_horizon_still_needs_one_full_unmet_day():
    # A detrained sub-day horizon (0.3 d) must not fire with zero unmet days...
    base = dict(
        maintenance_met=False,
        warn_after_days=0.3,
        sharpness=2.0,       # share 0.067
        durable_base=20.0,   # share 0.29
        hold_active=False,
    )
    assert zone2_maintenance_flag(consecutive_unmet_days=0, **base) == []
    # ...but one full unmet day suffices (threshold = max(1, round(0.3)) = 1).
    assert len(zone2_maintenance_flag(consecutive_unmet_days=1, **base)) == 1


def test_maintenance_flag_silent_when_maintenance_met():
    assert zone2_maintenance_flag(
        maintenance_met=True,
        consecutive_unmet_days=9,
        warn_after_days=9.0,
        sharpness=6.0,
        durable_base=45.0,
        hold_active=False,
    ) == []


def test_maintenance_flag_suppressed_on_injury_hold():
    # All firing conditions met, but an injury/plan hold is active -> suppressed
    # (spec §5c.4: the nudge must never read as pressure to train through injury).
    assert zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=30,
        warn_after_days=9.0,
        sharpness=4.0,
        durable_base=50.0,
        hold_active=True,
    ) == []


# ===========================================================================
# v2 — locked amendments (docs/zone2-fitness-model.md "v2 — locked amendments").
# Two FIXED-ceiling components summed: D ∈ [0, C_D], F ∈ [0, C_F], index ∈ [0,100].
# ===========================================================================

# ---- Ceilings are the design constants the migration/types pin (70/30/100). ----
def test_v2_ceilings_are_the_locked_constants():
    assert ZONE2_DURABLE_CEILING == 70.0
    assert ZONE2_FAST_CEILING == 30.0
    assert ZONE2_INDEX_CEILING == 100.0
    assert ZONE2_DURABLE_CEILING + ZONE2_FAST_CEILING == ZONE2_INDEX_CEILING


# ---- durable_score_from_percentile: [0,100] percentile rescaled onto [0, C_D] ----
def test_durable_rescale_maps_percentile_onto_ceiling():
    # 0 -> 0, 100 -> C_D, 50 -> C_D/2. The v1 [0,100] durable framing becomes the
    # v2 fixed-ceiling D exactly, hitting its anchors within [0, C_D].
    assert durable_score_from_percentile(0.0) == pytest.approx(0.0)
    assert durable_score_from_percentile(100.0) == pytest.approx(ZONE2_DURABLE_CEILING)
    assert durable_score_from_percentile(50.0) == pytest.approx(ZONE2_DURABLE_CEILING / 2.0)


def test_durable_rescale_clamps_to_ceiling_and_zero():
    assert durable_score_from_percentile(120.0) == pytest.approx(ZONE2_DURABLE_CEILING)
    assert durable_score_from_percentile(-5.0) == pytest.approx(0.0)


def test_durable_rescale_honours_custom_ceiling():
    assert durable_score_from_percentile(100.0, durable_ceiling=80.0) == pytest.approx(80.0)
    assert durable_score_from_percentile(50.0, durable_ceiling=80.0) == pytest.approx(40.0)


def test_vo2max_rescaled_never_exceeds_durable_ceiling():
    # The v1 anchor (vo2max_to_score -> [0,100]) rescaled onto [0, C_D] can never
    # push D past C_D even for an off-the-scale VO2max: the watch is not the cap
    # in the sense of "can't raise D above the ceiling either" (docs v2 Thread 2).
    for v in (10, 30, 48, 62, 90, 200):
        d = durable_score_from_percentile(vo2max_to_score(v))
        assert 0.0 <= d <= ZONE2_DURABLE_CEILING
    assert durable_score_from_percentile(vo2max_to_score(200)) == pytest.approx(ZONE2_DURABLE_CEILING)


# ---- fast_score_from_load: monotonic saturating map, bounded by C_F ----
def test_fast_score_saturating_bounds():
    assert fast_score_from_load(0.0) == pytest.approx(0.0)
    # F(fast_sat) = C_F*(1 - 1/e): ~63% of the ceiling at the sustained-training ref.
    assert fast_score_from_load(ZONE2_FAST_SAT) == pytest.approx(
        ZONE2_FAST_CEILING * (1.0 - math.exp(-1.0))
    )
    # asymptotes to C_F for very large load, and NEVER exceeds it.
    assert fast_score_from_load(1e6) == pytest.approx(ZONE2_FAST_CEILING, abs=1e-6)
    assert fast_score_from_load(1e6) <= ZONE2_FAST_CEILING


def test_fast_score_monotonic_in_load_and_capped():
    prev = -1.0
    for load in [0, 5, 10, 20, 26, 40, 80, 200, 1000]:
        f = fast_score_from_load(float(load))
        assert f >= prev  # strictly monotone-nondecreasing in fast_load
        assert 0.0 <= f <= ZONE2_FAST_CEILING  # never above C_F
        prev = f


def test_fast_score_negative_load_is_zero():
    assert fast_score_from_load(-3.0) == pytest.approx(0.0)


def test_fast_score_honours_custom_ceiling_and_sat():
    # A different ceiling caps F there; fast_sat only changes the CURVATURE.
    assert fast_score_from_load(1e6, fast_ceiling=40.0, fast_sat=10.0) == pytest.approx(40.0, abs=1e-6)
    assert fast_score_from_load(10.0, fast_ceiling=40.0, fast_sat=10.0) == pytest.approx(
        40.0 * (1.0 - math.exp(-1.0))
    )


# ---- The full index D + F stays within [0, 100]; each component within its ceiling ----
def test_index_and_components_within_ceilings_across_extremes():
    # Sweep the level and fast-load space; D+F must never leave [0,100], D never
    # leaves [0, C_D], F never leaves [0, C_F].
    for level_pct in (0.0, 25.0, 55.0, 100.0, 150.0):
        d = durable_score_from_percentile(level_pct)
        assert 0.0 <= d <= ZONE2_DURABLE_CEILING
        for fast_load in (0.0, 5.0, 26.0, 100.0, 1e6):
            f = fast_score_from_load(fast_load)
            assert 0.0 <= f <= ZONE2_FAST_CEILING
            index = d + f
            assert 0.0 <= index <= ZONE2_INDEX_CEILING + 1e-6


def test_durable_floor_rescaled_into_ceiling_space():
    # The v1 percentile floor rescaled into D-space stays within [0, C_D]; a fully
    # consolidated base (B=1) floors D at 0.55*C_D, not 55/100 of the old scale.
    floor_pct = durable_floor_score(1.0)  # 55 in percentile units
    floor_d = durable_score_from_percentile(floor_pct)
    assert floor_d == pytest.approx(0.55 * ZONE2_DURABLE_CEILING)
    assert 0.0 <= floor_d <= ZONE2_DURABLE_CEILING
    assert durable_score_from_percentile(durable_floor_score(0.0)) == pytest.approx(0.0)


# ===========================================================================
# v3 DYNAMIC — locked amendments (docs/zone2-fitness-model.md "v3 — locked").
# X-intercept elevation w/ personal baselines, load-driven decaying durable,
# projection-derived guidance. Everything a continuous function of the data.
# ===========================================================================

# ---- v3 pt5: PERSONAL baseline used when history present; POPULATION prior when
# absent; the blend is MONOTONE in the quantity of personal data. ----
def test_personal_baseline_weight_monotone_in_data_quantity():
    # 0 personal days -> 0 weight on personal (pure population prior).
    assert personal_baseline_weight(0) == pytest.approx(0.0)
    # weight increases monotonically with valid days and asymptotes to 1.
    ws = [personal_baseline_weight(d) for d in [0, 10, 30, 60, 120, 365, 10_000]]
    assert all(b > a for a, b in zip(ws, ws[1:]))  # strictly increasing
    assert ws[-1] == pytest.approx(1.0, abs=1e-2)  # -> personal as data -> ∞
    # at the halflife day-count, personal gets exactly half the weight.
    assert personal_baseline_weight(60, halflife_days=60.0) == pytest.approx(0.5)


def test_blended_baseline_population_prior_when_history_absent():
    # No personal baseline (None) OR zero valid days -> exactly the population prior;
    # no fabricated personal extreme.
    assert blended_baseline(None, Z2_RHR_POP_BASELINE, valid_days=200) == pytest.approx(
        Z2_RHR_POP_BASELINE
    )
    assert blended_baseline(55.0, Z2_RHR_POP_BASELINE, valid_days=0) == pytest.approx(
        Z2_RHR_POP_BASELINE
    )


def test_blended_baseline_shifts_to_personal_as_data_accrues():
    # With a personal RHR baseline of 58 vs population 68: thin history stays near
    # 68, thick history moves to 58 — a CONTINUOUS shift, monotone in data.
    personal, pop = 58.0, Z2_RHR_POP_BASELINE
    thin = blended_baseline(personal, pop, valid_days=5)
    mid = blended_baseline(personal, pop, valid_days=60)
    thick = blended_baseline(personal, pop, valid_days=1000)
    assert pop > thin > mid > thick > personal - 1e-6  # strictly toward personal
    assert thin == pytest.approx(pop, abs=1.0)  # thin history ~ population prior
    assert thick == pytest.approx(personal, abs=0.6)  # thick history ~ personal
    # the population prior's influence -> 0 as data -> ∞ (no fixed 68 once real).
    assert abs(thick - personal) < abs(thin - personal)


# ---- v3 pt2: signal scored as ELEVATION above baseline; baseline->0, top->C_D ----
def test_signal_elevation_baseline_is_zero_top_is_ceiling():
    # higher_is_fitter (VO2max/EF): at baseline -> 0, at top-amateur -> C_D.
    assert signal_elevation_score(32.0, baseline=32.0, top_amateur=62.0) == pytest.approx(0.0)
    assert signal_elevation_score(62.0, baseline=32.0, top_amateur=62.0) == pytest.approx(
        ZONE2_DURABLE_CEILING
    )
    # midpoint maps to half the ceiling (linear elevation).
    assert signal_elevation_score(47.0, baseline=32.0, top_amateur=62.0) == pytest.approx(
        ZONE2_DURABLE_CEILING / 2.0
    )


def test_signal_elevation_lower_is_fitter_for_rhr():
    # RHR: lower is fitter. baseline (untrained, high) -> 0; top (fit, low) -> C_D.
    assert signal_elevation_score(
        68.0, baseline=68.0, top_amateur=48.0, higher_is_fitter=False
    ) == pytest.approx(0.0)
    assert signal_elevation_score(
        48.0, baseline=68.0, top_amateur=48.0, higher_is_fitter=False
    ) == pytest.approx(ZONE2_DURABLE_CEILING)
    # a detrained (high) RHR sits at ~0, a mid RHR at ~half C_D.
    assert signal_elevation_score(
        58.0, baseline=68.0, top_amateur=48.0, higher_is_fitter=False
    ) == pytest.approx(ZONE2_DURABLE_CEILING / 2.0)


def test_signal_elevation_clamps_and_handles_degenerate():
    # Below baseline clamps to 0; above top clamps to the ceiling.
    assert signal_elevation_score(25.0, baseline=32.0, top_amateur=62.0) == pytest.approx(0.0)
    assert signal_elevation_score(80.0, baseline=32.0, top_amateur=62.0) == pytest.approx(
        ZONE2_DURABLE_CEILING
    )
    # missing value or degenerate span -> None (signal drops out of the fusion).
    assert signal_elevation_score(None, baseline=32.0, top_amateur=62.0) is None
    assert signal_elevation_score(50.0, baseline=50.0, top_amateur=50.0) is None


def test_signal_elevation_uses_personal_baseline_when_present():
    # The SAME VO2max reading scores DIFFERENTLY against a personal detrained
    # baseline than against the population prior — proving the personal baseline is
    # actually used, not the fixed 32 (docs v3 pt5).
    v = 50.0
    against_pop = signal_elevation_score(v, baseline=Z2_VO2MAX_POP_BASELINE, top_amateur=62.0)
    against_personal = signal_elevation_score(v, baseline=42.0, top_amateur=62.0)
    assert against_pop != pytest.approx(against_personal)
    # a HIGHER personal baseline (less detrained) means the same reading is LESS of
    # an elevation -> a lower score.
    assert against_personal < against_pop


# ---- v3 pt1 ACCEPTANCE: a zero-load stretch decays DURABLE toward the floor even
# with favorable CONSTANT elevation (RHR/EF/VO2max) inputs. The durable base is
# LOAD-DRIVEN + DECAYING (dominant behavior); the elevation only calibrates height.
def test_v3_durable_decays_toward_floor_on_zero_load_despite_favorable_signals():
    # Build a base with load, then a long zero-load stretch. The elevation
    # calibration (calib_score) is held HIGH and CONSTANT — a favorable RHR/EF —
    # yet the durable base must fall toward the floor during the gap.
    floor_load = 6.0
    loads = [40.0] * 60 + [0.0] * 240   # 2 months building, 8 months off
    series = z2_durable_sharpness_series(
        loads, tau_fast=14.0, tau_slow_days=45.0, floor_load=floor_load
    )
    durable_load_track = [d for d, _ in series]

    floor_d = 10.0  # the earned floor in D-space
    # FAVORABLE, CONSTANT elevation calibration: a high durable score at the ref.
    calib_load = 40.0
    calib_score = 60.0  # a top-ish elevation — held constant across the whole run

    D = durable_base_series(
        durable_load_track, floor_d=floor_d, ceiling=ZONE2_DURABLE_CEILING,
        calib_load=calib_load, calib_score=calib_score, floor_load=floor_load,
    )
    peak = max(D[:60])
    end = D[-1]
    # DURABLE built up during training...
    assert peak > floor_d + 5.0
    # ...and DECAYED back toward the floor through the zero-load stretch, despite
    # the elevation calibration staying favorable and constant the entire time.
    assert end < peak
    assert end == pytest.approx(floor_d, abs=2.0)
    # monotone-ish decay through the gap: strictly below peak and never under floor.
    assert all(d >= floor_d - 1e-9 for d in D)
    assert D[-1] < D[80]  # still falling well into the gap


def test_v3_durable_base_series_is_load_driven_monotone():
    # D is a monotone-increasing function of the durable load track: more load ->
    # higher D. Two constant-load tracks; the higher load yields the higher D.
    lo_track = [10.0] * 50
    hi_track = [30.0] * 50
    d_lo = durable_base_series(lo_track, floor_d=5.0, calib_load=30.0, calib_score=50.0)
    d_hi = durable_base_series(hi_track, floor_d=5.0, calib_load=30.0, calib_score=50.0)
    assert d_hi[-1] > d_lo[-1]
    # calibration point maps the calib_load to ~calib_score (above the floor).
    assert d_hi[-1] == pytest.approx(50.0, abs=1e-6)  # 30 load -> 50 score at calib
    # everything stays within [floor, ceiling].
    for d in d_lo + d_hi:
        assert 5.0 <= d <= ZONE2_DURABLE_CEILING


def test_v3_durable_base_series_falls_back_to_floor_without_calibration():
    # No calibration (no elevation signal at all): slope 0 → D IS the earned
    # floor track. The most data-thin state must produce the most conservative
    # number, not the most extreme — the old fallback anchored the user's own
    # peak load to the CEILING (evidence_state 'insufficient' yet D=70).
    track = [30.0] * 30 + [0.0] * 5
    D = durable_base_series(track, floor_d=8.0, calib_load=None, calib_score=None)
    assert all(d == pytest.approx(8.0) for d in D)
    assert max(D) < ZONE2_DURABLE_CEILING  # never the ceiling from load alone
    # slope helper pins the same rule directly.
    assert durable_calibration_slope(8.0, 2.0, calib_load=None, calib_score=None) == 0.0
    # and with per-day floors the fallback reads the floor TRACK, day by day.
    floors = [4.0] * 20 + [6.0] * 15
    D2 = durable_base_series(track, floor_d=floors, calib_load=None, calib_score=None)
    assert D2 == pytest.approx(floors)


# ===========================================================================
# v4 defect fixes — each block pins one confirmed defect's correction with
# hand-computed values (never asserting the implementation against itself).
# ===========================================================================

# ---- fix 1: strength/core contamination of w(t) — modality classification ----
def test_is_aerobic_modality_excludes_pressor_response_types():
    for t in (
        "functional_strength_training",
        "traditional_strength_training",
        "core_training",
        "yoga",
        "pilates",
    ):
        assert not is_aerobic_modality(t), t


def test_is_aerobic_modality_counts_everything_else():
    for t in (
        "rowing", "pool_swim", "swimming", "indoor_cycling", "cycling",
        "walking", "running", "hiking", "elliptical",
    ):
        assert is_aerobic_modality(t), t
    # unknown/missing type cannot be shown non-aerobic; the intensity gates
    # still apply downstream.
    assert is_aerobic_modality(None)
    assert is_aerobic_modality("")


# ---- fix 3: B must decay through workout-free weeks (per-week causal series) ----
def test_base_consolidation_series_decays_through_an_off_gap():
    # ACCEPTANCE: 26 weeks @200 min/wk then 52 fully-empty weeks → final B < 0.1
    # and B monotonically decaying through the entire gap. (The old feed skipped
    # workout-free weeks, freezing B across gaps — the exact bug class v3 kills.)
    series = base_consolidation_series([200.0] * 26 + [0.0] * 52, b_ref=200.0)
    assert len(series) == 78
    peak = series[25]
    gap = series[26:]
    assert peak > 0.5  # a real base was banked first
    # strictly decreasing through the gap:
    assert all(later < earlier for earlier, later in zip([peak] + gap[:-1], gap))
    assert series[-1] < 0.1
    # hand-check the EWMA closed form at the end of the gap:
    alpha_b = 1 - math.exp(-7 / 180)
    b_raw = 0.0
    for wk in [200.0] * 26 + [0.0] * 52:
        b_raw += alpha_b * (wk - b_raw)
    assert series[-1] == pytest.approx(b_raw / 200.0)


def test_base_consolidation_final_value_matches_series():
    weeks = [120.0, 0.0, 60.0, 0.0, 0.0]
    assert base_consolidation(weeks) == pytest.approx(base_consolidation_series(weeks)[-1])
    assert base_consolidation([]) == 0.0


def test_base_consolidation_guards_nonpositive_b_ref():
    # fix 12: a corrupted params row (b_ref ≤ 0) falls back to the literature
    # default instead of crashing/poisoning the nightly job.
    weeks = [200.0] * 10
    assert base_consolidation(weeks, b_ref=0.0) == pytest.approx(base_consolidation(weeks))
    assert base_consolidation(weeks, b_ref=-5.0) == pytest.approx(base_consolidation(weeks))


# ---- fix 4: the floor LIMITS decay, it never replaces the day's load; and a
# sub-floor state must not RISE on a rest day. Closed form for prev > floor:
#   durable(t) = prev·exp(−1/τ) + (1−exp(−1/τ))·max(w, floor)
def test_floor_limits_decay_light_session_never_reads_below_pure_decay():
    floor, tau = 12.0, 45.0
    build = [30.0] * 40
    prev = z2_durable_sharpness_series(build, tau_slow_days=tau, floor_load=floor)[-1][0]
    decay = math.exp(-1.0 / tau)
    alpha = 1.0 - decay

    for w in (0.0, 5.0, 20.0):
        got = z2_durable_sharpness_series(build + [w], tau_slow_days=tau, floor_load=floor)[-1][0]
        newton = floor + (prev - floor) * decay          # pure Newton decay
        plain = prev + alpha * (w - prev)                # plain EWMA update
        assert got >= newton - 1e-12                     # never below pure decay
        assert got >= plain - 1e-12                      # never below the plain EWMA
        assert got == pytest.approx(prev * decay + alpha * max(w, floor))
    # a session above the floor-equivalent stimulus reads STRICTLY above a rest day
    rest = z2_durable_sharpness_series(build + [0.0], tau_slow_days=tau, floor_load=floor)[-1][0]
    active = z2_durable_sharpness_series(build + [20.0], tau_slow_days=tau, floor_load=floor)[-1][0]
    assert active > rest


def test_sub_floor_state_never_rises_on_a_rest_day():
    # Start below the floor (prev ≤ floor): w=0 days are a plain EWMA — durable
    # keeps FALLING; the old rule RAISED it toward the floor (unearned fitness).
    floor, tau = 12.0, 45.0
    track = [d for d, _ in z2_durable_sharpness_series(
        [5.0, 0.0, 0.0, 0.0], tau_slow_days=tau, floor_load=floor
    )]
    assert all(d < floor for d in track)                  # never jumps to the floor
    assert all(later < earlier for earlier, later in zip(track, track[1:]))


def test_series_accepts_per_day_sequences_and_matches_scalars():
    loads = [20.0] * 10 + [0.0] * 20
    n = len(loads)
    scalar = z2_durable_sharpness_series(loads, tau_slow_days=60.0, floor_load=3.0)
    seq = z2_durable_sharpness_series(loads, tau_slow_days=[60.0] * n, floor_load=[3.0] * n)
    for (sd, ss), (qd, qs) in zip(scalar, seq):
        assert sd == pytest.approx(qd)
        assert ss == pytest.approx(qs)
    with pytest.raises(ValueError):
        z2_durable_sharpness_series(loads, tau_slow_days=[60.0] * (n - 1))


# ---- fix 5: calibration abscissa in EWMA units (two-pass scheme). A steady
# 3×/wk trainer at plateau with signals implying S must read ≈S, not ~0.43·S. ----
def test_steady_trainer_reads_the_signal_implied_height():
    tau = 45.0
    loads = [40.0, 0.0, 0.0] * 120  # one 40-load session every 3 days, ~1 year
    track = [d for d, _ in z2_durable_sharpness_series(loads, tau_slow_days=tau, floor_load=0.0)]
    S = 50.0
    # the two-pass scheme: calib_load = max of the (floorless) track over the
    # trailing signal window — EWMA units, same as the track itself.
    calib_load = max(track[-180:])
    D = durable_base_series(
        track, floor_d=5.0, calib_load=calib_load, calib_score=S, floor_load=0.0
    )
    # at the calibration point D reads exactly S…
    assert max(D[-180:]) == pytest.approx(S)
    # …and the whole plateau sits ≈S (small within-cycle ripple only), NOT the
    # ~0.43·S the single-day 90th-percentile abscissa produced.
    assert min(D[-30:]) > 0.9 * S
    # the old defect for contrast: pinning the slope at the single-DAY session
    # load (40) reads the plateau at less than half the implied height.
    D_old = durable_base_series(track, floor_d=5.0, calib_load=40.0, calib_score=S, floor_load=0.0)
    assert max(D_old[-30:]) < 0.55 * S


def test_no_load_stretch_still_decays_toward_floor_with_constant_signals():
    # the v3 pt1 acceptance survives the two-pass calibration: signals constant
    # and favorable, training stops → D falls to the floor.
    tau, floor_load = 45.0, 4.0
    loads = [40.0, 0.0, 0.0] * 40 + [0.0] * 300
    track = [d for d, _ in z2_durable_sharpness_series(loads, tau_slow_days=tau, floor_load=floor_load)]
    calib_load = max(track)
    D = durable_base_series(
        track, floor_d=9.0, calib_load=calib_load, calib_score=55.0, floor_load=floor_load
    )
    assert max(D) > 40.0
    assert D[-1] == pytest.approx(9.0, abs=1.5)  # decayed to the earned floor
    assert D[-1] < max(D)


# ---- fix 8: continuous confidence from the fused posterior vs the flat prior ----
def test_confidence_from_posterior_continuous_and_bounded():
    prior = ZONE2_DURABLE_CEILING / math.sqrt(12.0)  # flat prior over [0, C_D]
    assert confidence_from_posterior(prior, prior) == pytest.approx(0.0)   # knows nothing
    assert confidence_from_posterior(0.0, prior) == pytest.approx(1.0)     # exact knowledge
    assert confidence_from_posterior(prior / 2, prior) == pytest.approx(0.5)
    # worse-than-prior posterior clamps at 0; degenerate prior yields 0.
    assert confidence_from_posterior(prior * 2, prior) == 0.0
    assert confidence_from_posterior(1.0, 0.0) == 0.0
    # strictly monotone in the posterior: more precise fusion → more confidence.
    cs = [confidence_from_posterior(sd, prior) for sd in (18.0, 12.0, 6.0, 2.0)]
    assert all(b > a for a, b in zip(cs, cs[1:]))


# ---- fix 10: v3 pt6 horizons — expected session build, maintain, build cadence ----
def test_expected_session_stimulus_median_with_hickson_fallback():
    assert expected_session_stimulus([30.0, 50.0, 40.0]) == pytest.approx(40.0)
    assert expected_session_stimulus([30.0, 50.0]) == pytest.approx(40.0)
    # no qualifying sessions in the window → the marked Hickson maintenance dose.
    assert expected_session_stimulus([]) == pytest.approx(Z2_MAINTENANCE_SESSION_LOAD)
    assert expected_session_stimulus([0.0, 0.0]) == pytest.approx(Z2_MAINTENANCE_SESSION_LOAD)
    assert Z2_MAINTENANCE_SESSION_LOAD == 40.0  # one 20-min Z2 session × Edwards 2


def test_expected_session_build_hand_computed():
    # State: durable_load=10, sharp_load=5; one session at w̄=40 vs a rest day.
    tau_f, tau_s = 14.0, 45.0
    slope, floor_d, floor_load = 1.5, 5.0, 2.0
    a_f = 1 - math.exp(-1 / tau_f)
    a_s = 1 - math.exp(-1 / tau_s)
    d_s = math.exp(-1 / tau_s)

    def hand(w):
        sharp = 5.0 + a_f * (w - 5.0)
        built = 10.0 + a_s * (w - 10.0)
        built = max(built, floor_load + (10.0 - floor_load) * d_s)  # floor limit
        d = max(floor_d, min(70.0, floor_d + slope * (built - floor_load)))
        f = 30.0 * (1 - math.exp(-sharp / 26.0))
        return d + f, f

    i_s, f_s = hand(40.0)
    i_r, f_r = hand(0.0)
    di, df = expected_session_build(
        10.0, 5.0, 40.0,
        slope=slope, floor_d=floor_d, floor_load=floor_load,
        tau_slow_days=tau_s, tau_fast=tau_f,
        durable_ceiling=70.0, fast_ceiling=30.0, fast_sat=26.0,
    )
    assert di == pytest.approx(i_s - i_r)
    assert df == pytest.approx(f_s - f_r)
    assert 0 < df < di  # a session builds fast AND durable; ΔF is the fast part


def test_maintain_horizon_is_decay_onset_at_one_session_build():
    # Durable pinned at its floor → the projected drop is purely the fast layer:
    # F(1 − e^(−t/τf)) ≥ ΔI ⇒ t = −τf·ln(1 − ΔI/F). F=10, ΔI=2, τf=14 → 3.1236 d.
    t = decay_onset_days(
        durable=20.0, fast=10.0, floor=20.0, tau_slow_days=90.0, swc=2.0, tau_fast=14.0
    )
    assert t == pytest.approx(-14.0 * math.log(1 - 2.0 / 10.0), abs=1e-6)


def test_build_cadence_scales_with_base_consolidation():
    # v4: cadence = max(24h floor, 7 / (freq_beginner + freq_slope·B)). Hand-check
    # the two anchors and the floor from the marked literature priors.
    # B=0 (novice): 7 / 3 = 2.333 d (ACSM ~3×/wk).
    assert build_cadence_days(0.0) == pytest.approx(7.0 / Z2_BUILD_FREQ_BEGINNER)
    # B=1 (consolidated): 7 / 5.5 = 1.273 d (well-trained train MORE often).
    assert build_cadence_days(1.0) == pytest.approx(
        7.0 / (Z2_BUILD_FREQ_BEGINNER + Z2_BUILD_FREQ_SLOPE)
    )
    # Monotone DECREASING in B (fitter → shorter cadence) — no step, no plateau.
    xs = [build_cadence_days(b) for b in (0.0, 0.1, 0.25, 0.5, 0.75, 1.0)]
    assert all(b < a for a, b in zip(xs, xs[1:]))
    # Floored at the 24 h molecular re-stimulation window even for an (out-of-range)
    # hyper-consolidated B — the cadence never drops below one session/day.
    assert build_cadence_days(5.0) >= Z2_BUILD_INTERVAL_FLOOR_DAYS
    # Clamps out-of-range B.
    assert build_cadence_days(-3.0) == pytest.approx(build_cadence_days(0.0))


# ===========================================================================
# compute-side pure helpers (metrics/compute.py): the weekly axis MUST include
# workout-free weeks (fix for B skipping gaps) and every per-day signal lookup
# MUST be causal (no historical row reads its own future).
# ===========================================================================
from datetime import date, timedelta  # noqa: E402

from metrics.compute import causal_latest, iso_weeks_spanning  # noqa: E402


def test_iso_weeks_spanning_includes_empty_weeks():
    # 2026-01-05 is a Monday (ISO week 2). Four contiguous weeks of days →
    # exactly the four ISO keys, regardless of whether any workouts exist.
    days = [date(2026, 1, 5) + timedelta(days=i) for i in range(28)]
    assert iso_weeks_spanning(days) == [(2026, 2), (2026, 3), (2026, 4), (2026, 5)]
    # a mid-week single day still yields its own week
    assert iso_weeks_spanning([date(2026, 1, 7)]) == [(2026, 2)]
    assert iso_weeks_spanning([]) == []


def test_iso_weeks_spanning_covers_year_boundary_gap():
    # Nov 2025 → Feb 2026 daily axis: the ISO week list is contiguous across the
    # year boundary with NO missing weeks — a workout-free December still yields
    # its weeks (each will carry 0.0 minutes into base_consolidation_series).
    days = [date(2025, 11, 3) + timedelta(days=i) for i in range(100)]
    weeks = iso_weeks_spanning(days)
    assert len(weeks) == len(set(weeks)) == 15  # 100 days from a Monday = 15 ISO weeks
    # every day's own ISO week is present (so a per-day B lookup can never miss)
    for d in days:
        iso = d.isocalendar()
        assert (iso.year, iso.week) in weeks


def test_causal_latest_never_reads_the_future():
    d0 = date(2026, 6, 1)
    days = [d0 + timedelta(days=i) for i in range(8)]
    series = [(d0 + timedelta(days=1), 50.0), (d0 + timedelta(days=5), 60.0)]
    got = causal_latest(series, days)
    assert got[0] is None                                # before the first reading
    assert got[1] == (d0 + timedelta(days=1), 50.0)      # the day it lands
    assert got[4] == (d0 + timedelta(days=1), 50.0)      # holds until the next
    assert got[5] == (d0 + timedelta(days=5), 60.0)
    assert got[7] == (d0 + timedelta(days=5), 60.0)
    # days-since derived from these can never be negative
    for day, obs in zip(days, got):
        if obs is not None:
            assert (day - obs[0]).days >= 0
