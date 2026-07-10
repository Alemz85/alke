"""Zone 2 fitness model tests — fixtures derived directly from
docs/zone2-fitness-model.md (the acceptance gates in §11). These define the
contract; models.py implements exactly this. Every load-bearing equation and
constant is pinned so a later edit cannot silently drift the physiology."""

import math

import pytest

from metrics.models import (
    Z2_ANCHOR_BETA0,
    Z2_RHR_POP_BASELINE,
    Z2_SWC_MIN_POINTS,
    Z2_VO2MAX_POP_BASELINE,
    ZONE2_DURABLE_CEILING,
    ZONE2_FAST_CEILING,
    ZONE2_FAST_SAT,
    ZONE2_INDEX_CEILING,
    ZONE2_MAINTENANCE_MESSAGE,
    anchor_beta,
    base_consolidation,
    blended_baseline,
    decay_onset_days,
    durable_base_series,
    durable_floor_score,
    durable_level_score,
    durable_score_from_percentile,
    ewma_alpha,
    fast_score_from_load,
    fuse_inverse_variance,
    personal_baseline_weight,
    project_index,
    signal_elevation_score,
    swc_from_index,
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
# §4c — anchor_beta = beta0 * exp(-days_since/45) * confidence
# ---------------------------------------------------------------------------
def test_anchor_beta_formula():
    assert anchor_beta(0, 1.0) == pytest.approx(Z2_ANCHOR_BETA0)
    assert anchor_beta(45, 1.0) == pytest.approx(Z2_ANCHOR_BETA0 * math.exp(-1))
    # confidence scales the weight linearly
    assert anchor_beta(0, 0.5) == pytest.approx(Z2_ANCHOR_BETA0 * 0.5)


def test_anchor_beta_none_when_no_vo2max():
    assert anchor_beta(None, 1.0) == 0.0


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

# ---- SWC is DATA-DERIVED from the user's own index variability (0.5×CV) ----
def test_swc_from_index_is_half_cv_scale():
    # A series with a known SD: SWC = 0.5 * SD (= 0.5 * CV * mean, since CV=SD/mean).
    vals = [40.0, 42.0, 44.0, 46.0, 48.0]  # sample SD = sqrt(10) ≈ 3.162
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)
    sd = math.sqrt(var)
    assert swc_from_index(vals) == pytest.approx(max(Z2_SWC_MIN_POINTS, 0.5 * sd))


def test_swc_floored_when_index_flat():
    # A pathologically-flat index (CV≈0) still yields a finite floor, not 0.
    assert swc_from_index([50.0] * 40) == pytest.approx(Z2_SWC_MIN_POINTS)
    assert swc_from_index([]) == pytest.approx(Z2_SWC_MIN_POINTS)
    assert swc_from_index([50.0]) == pytest.approx(Z2_SWC_MIN_POINTS)


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
# §5c — zone2_maintenance fires only after warn_after_days consecutive unmet
# days AND sharpness < durable, and is suppressed on an injury/plan hold.
# ---------------------------------------------------------------------------
def test_maintenance_flag_fires_after_window_with_form_fading():
    flags = zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=9,  # == warn_window for B<0.33
        warn_window=9,
        sharpness=30.0,
        durable_base=45.0,  # sharpness has dropped below durable
        hold_active=False,
    )
    assert len(flags) == 1
    assert flags[0]["type"] == "zone2_maintenance"
    assert flags[0]["severity"] == "info"  # never an alarm severity
    assert flags[0]["message"] == ZONE2_MAINTENANCE_MESSAGE


def test_maintenance_flag_silent_before_window_elapses():
    # One day short of the window: no fire even with form fading.
    assert zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=8,
        warn_window=9,
        sharpness=30.0,
        durable_base=45.0,
        hold_active=False,
    ) == []


def test_maintenance_flag_silent_when_sharpness_not_below_durable():
    # Window elapsed but form has NOT faded below the base -> no fire (spec §5c.2).
    assert zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=20,
        warn_window=9,
        sharpness=50.0,
        durable_base=45.0,
        hold_active=False,
    ) == []


def test_maintenance_flag_silent_when_maintenance_met():
    assert zone2_maintenance_flag(
        maintenance_met=True,
        consecutive_unmet_days=9,
        warn_window=9,
        sharpness=30.0,
        durable_base=45.0,
        hold_active=False,
    ) == []


def test_maintenance_flag_suppressed_on_injury_hold():
    # All firing conditions met, but an injury/plan hold is active -> suppressed
    # (spec §5c.4: the nudge must never read as pressure to train through injury).
    assert zone2_maintenance_flag(
        maintenance_met=False,
        consecutive_unmet_days=30,
        warn_window=9,
        sharpness=20.0,
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


# ---- durable_level_score: own-sports blend; watch VO2max low-weight, not the cap ----
def test_level_blend_uses_own_sports_only_when_no_vo2max_refresh():
    # A day with bike EF at the 90th pct and no VO2max refresh: level tracks the
    # own-sports signal, VO2max excluded entirely.
    level = durable_level_score(
        swim_ef_pct=None, bike_ef_pct=90.0, rhr_pct=60.0, hrv_pct=None,
        vo2max_pct=10.0, vo2max_refreshed=False,
    )
    # weights: bike 0.35, rhr 0.20 -> (90*0.35 + 60*0.20)/0.55
    assert level == pytest.approx((90 * 0.35 + 60 * 0.20) / 0.55)


def test_level_blend_vo2max_only_counts_on_refresh_day_and_is_low_weight():
    base = durable_level_score(
        swim_ef_pct=80.0, bike_ef_pct=80.0, rhr_pct=80.0, hrv_pct=80.0,
        vo2max_pct=0.0, vo2max_refreshed=False,
    )
    with_vo2 = durable_level_score(
        swim_ef_pct=80.0, bike_ef_pct=80.0, rhr_pct=80.0, hrv_pct=80.0,
        vo2max_pct=0.0, vo2max_refreshed=True,
    )
    # Without a refresh the own-sports level is a clean 80. A refreshed, contrary
    # VO2max=0 can only nudge it down slightly (low weight), never dominate/cap it.
    assert base == pytest.approx(80.0)
    assert with_vo2 < base
    assert with_vo2 > 70.0  # a hostile watch reading moves the level by <10 pts


def test_level_blend_none_without_own_signal():
    # A lone refreshed VO2max with NO own-sports signal cannot place the level:
    # the watch may never let the swimmer reach his ceiling (docs v2 Thread 2).
    assert durable_level_score(
        swim_ef_pct=None, bike_ef_pct=None, rhr_pct=None, hrv_pct=None,
        vo2max_pct=95.0, vo2max_refreshed=True,
    ) is None
    # and with no signals at all.
    assert durable_level_score(None, None, None, None, None, False) is None


def test_level_blend_is_bounded_0_100():
    assert durable_level_score(100.0, 100.0, 100.0, 100.0, 100.0, True) == pytest.approx(100.0)
    assert durable_level_score(0.0, 0.0, 0.0, 0.0, 0.0, True) == pytest.approx(0.0)


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


def test_v3_durable_base_series_falls_back_without_calibration():
    # No calibration (no aerobic signal): D still maps the load track onto
    # [floor, ceiling] via the range, and still decays with the load.
    track = [30.0] * 30 + [0.0] * 5  # the plain EWMA won't zero this fast, but the
    # top of the range anchors to the ceiling; a lower load -> lower D.
    D = durable_base_series(track, floor_d=8.0, calib_load=None, calib_score=None)
    assert all(8.0 <= d <= ZONE2_DURABLE_CEILING for d in D)
    assert max(D) == pytest.approx(ZONE2_DURABLE_CEILING)  # peak load -> ceiling
