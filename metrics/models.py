"""Pure metric formulas per SPEC §5. No I/O — everything here is a function of
its inputs so the test suite pins the math exactly."""

from __future__ import annotations

import math
from statistics import median

Sample = tuple[int, float]  # (offset_s, bpm)
SPACING_CAP_S = 30
ACWR_FLAG_THRESHOLD = 1.5
RHR_FLAG_DEV_BPM = 4.0
RHR_FLAG_RUN_DAYS = 3


def zone_bounds(
    hr_max: float, rhr_recent: float, z2_low: float = 0.60, z2_high: float = 0.70
) -> tuple[float, float, float, float]:
    """Karvonen: thresholds where Z2..Z5 begin. Z3/Z4 bounds continue in 0.10
    steps above the configurable Z2 band."""
    hrr = hr_max - rhr_recent
    return (
        rhr_recent + z2_low * hrr,
        rhr_recent + z2_high * hrr,
        rhr_recent + (z2_high + 0.10) * hrr,
        rhr_recent + (z2_high + 0.20) * hrr,
    )


def classify_zone(bpm: float, bounds: tuple[float, float, float, float]) -> int:
    for zone, threshold in enumerate(bounds, start=2):
        if bpm < threshold:
            return zone - 1
    return 5


def time_in_zones(
    samples: list[Sample],
    bounds: tuple[float, float, float, float],
    swim_hr_offset: float = 0.0,
) -> dict[int, int]:
    """Seconds per zone. Sample duration = gap to next sample capped at 30s;
    the last sample has no next and contributes nothing. Swims: subtracting the
    (negative) offset shifts samples up, i.e. zone bounds effectively down."""
    tiz = {z: 0 for z in range(1, 6)}
    ordered = sorted(samples)
    for (offset, bpm), (next_offset, _) in zip(ordered, ordered[1:]):
        duration = min(next_offset - offset, SPACING_CAP_S)
        zone = classify_zone(bpm - swim_hr_offset, bounds)
        tiz[zone] += duration
    return tiz


def trimp_edwards(tiz: dict[int, int]) -> float:
    return sum(seconds / 60.0 * zone for zone, seconds in tiz.items())


def ef(distance_m: float | None, duration_s: float | None, avg_hr: float | None) -> float | None:
    if not distance_m or not duration_s or not avg_hr:
        return None
    return (distance_m / (duration_s / 60.0)) / avg_hr


def ef_eligibility(workout_type: str | None, tiz: dict[int, int], duration_s: float | None) -> bool:
    """EF/decoupling are swim-only, ≥20 min, ≥70% of classified time in Z1–Z2."""
    if not workout_type or "swim" not in workout_type.lower():
        return False
    if not duration_s or duration_s < 20 * 60:
        return False
    total = sum(tiz.values())
    if total == 0:
        return False
    return (tiz[1] + tiz[2]) / total >= 0.70


def hr_drift_pct(samples: list[Sample]) -> float | None:
    """HR-only drift: (avgHR second half − avgHR first half) / first half × 100.
    Positive = drifting up = decoupling. Used because only total distance is
    stored (no per-sample distance), per SPEC §5.2's fallback."""
    if len(samples) < 4:
        return None
    ordered = sorted(samples)
    midpoint = (ordered[0][0] + ordered[-1][0]) / 2
    first = [bpm for off, bpm in ordered if off <= midpoint]
    second = [bpm for off, bpm in ordered if off > midpoint]
    if not first or not second:
        return None
    avg1 = sum(first) / len(first)
    avg2 = sum(second) / len(second)
    if avg1 == 0:
        return None
    return (avg2 - avg1) / avg1 * 100.0


def hrr60(samples: list[Sample], duration_s: float | None) -> float | None:
    """Max HR in the final 2 min minus HR ~60s after the end, when post-end
    samples exist in the stream. Health Auto Export rarely provides them."""
    if not samples or not duration_s:
        return None
    ordered = sorted(samples)
    final_window = [bpm for off, bpm in ordered if duration_s - 120 <= off <= duration_s]
    post = [(abs(off - (duration_s + 60)), bpm) for off, bpm in ordered if off >= duration_s + 45]
    if not final_window or not post:
        return None
    return max(final_window) - min(post)[1]


def ctl_atl_series(daily_trimp: list[float]) -> list[tuple[float, float]]:
    """EWMA chains seeded at 0: X_t = X_{t-1} + (TRIMP_t − X_{t-1}) / tc."""
    out: list[tuple[float, float]] = []
    ctl = atl = 0.0
    for t in daily_trimp:
        ctl += (t - ctl) / 42.0
        atl += (t - atl) / 7.0
        out.append((ctl, atl))
    return out


def acwr(daily_trimp: list[float], idx: int) -> float | None:
    """Mean TRIMP last 7 days ÷ mean last 28 days at day `idx`. None when
    history < 21 days or the chronic denominator is ~0."""
    if idx + 1 < 21:
        return None
    acute = daily_trimp[max(0, idx - 6) : idx + 1]
    chronic = daily_trimp[max(0, idx - 27) : idx + 1]
    chronic_mean = sum(chronic) / len(chronic)
    if chronic_mean < 1e-9:
        return None
    return (sum(acute) / len(acute)) / chronic_mean


def rolling_median(values: list[float]) -> float | None:
    cleaned = [v for v in values if v is not None]
    return median(cleaned) if cleaned else None


def flags_for_day(
    acwr_value: float | None,
    rhr_dev_last3: list[float | None],
    week_missed: bool,
) -> list[dict]:
    """The only three defined flag types (SPEC §5.3)."""
    flags: list[dict] = []
    if acwr_value is not None and acwr_value > ACWR_FLAG_THRESHOLD:
        flags.append(
            {
                "type": "acwr_high",
                "message": (
                    f"Ramp rate high: last 7 days = {acwr_value:.1f}× your 28-day average. "
                    "Rapid ramps raise overuse-injury risk — consider holding volume this week."
                ),
                "severity": "warn",
            }
        )
    devs = [d for d in rhr_dev_last3 if d is not None]
    if len(devs) >= RHR_FLAG_RUN_DAYS and all(d >= RHR_FLAG_DEV_BPM for d in devs[-RHR_FLAG_RUN_DAYS:]):
        flags.append(
            {
                "type": "rhr_elevated",
                "message": (
                    f"Resting HR +{devs[-1]:.0f} bpm above baseline for "
                    f"{RHR_FLAG_RUN_DAYS} days — consider an easy day and watch sleep."
                ),
                "severity": "warn",
            }
        )
    if week_missed:
        flags.append(
            {
                "type": "week_minimum_missed",
                "message": "Last week finished under your weekly session minimums.",
                "severity": "info",
            }
        )
    return flags


# ---------------------------------------------------------------------------
# Zone 2 fitness model (docs/zone2-fitness-model.md). Two independent numbers,
# never summed: a slow VO2max-anchored DURABLE BASE and a fast SHARPNESS. All
# math here is pure so pytest pins it exactly (spec §11), mirroring the
# ctl_atl_series style above.
# ---------------------------------------------------------------------------

# Literature defaults (spec "Locked constants"; overridable via zone2_fitness_params).
#
# ── LITERATURE PRIOR vs DATA-DERIVED-CONTINUOUS (v3 DYNAMIC principle, docs §v3) ──
# The governing rule (docs "DYNAMIC, not hardcoded"): constants that describe the
# USER'S state or timing must be CONTINUOUS FUNCTIONS of the actual data. Only
# IRREDUCIBLE physiological priors stay literature constants while data is thin,
# and each is marked [LITERATURE PRIOR] with why it cannot be fit from this user.
#
# [LITERATURE PRIOR] τ_fast: enzyme/plasma-volume turnover half-life. Molecular,
# training-age independent, and NOT identifiable from thin gap data (docs §7
# staged personalization + "τ_fast=14 stays a literature PRIOR; do NOT fit from
# thin data"). Stays 14 d until many gap→return episodes exist.
Z2_TAU_FAST_DAYS = 14.0
# [LITERATURE PRIOR, B-scaled] τ_slow(B): capillary/mito regression window. Its
# B-dependence is the model's softest constant (docs §3, Zheng 2022 contested);
# B itself IS data-derived (base_consolidation of the user's weekly Z2 minutes),
# so τ_slow becomes continuous in the user's data THROUGH B.
Z2_TAU_SLOW_MIN_DAYS = 45.0
Z2_TAU_SLOW_MAX_DAYS = 90.0
Z2_F_MAX = 0.55
Z2_FLOOR_P = 1.5
Z2_B_REF_MIN_PER_WK = 200.0
Z2_ANCHOR_VO2_100 = 62.0
Z2_ANCHOR_BETA0 = 0.7

# ── v3 x-intercept population priors (docs v3 pt2/pt5) ──
# Population untrained baselines, used ONLY to seed a signal's elevation baseline
# when the user's OWN history is too thin; the blend shifts fully to the user's
# personal detrained extreme as valid days accrue. NEVER a fixed offset when the
# user's own data exists (docs v3 pt5: "No fixed 68/32").
Z2_RHR_POP_BASELINE = 68.0     # untrained resting HR (docs v3 pt2)
Z2_VO2MAX_POP_BASELINE = 32.0  # sedentary VO2max floor, FRIEND ~10th pct (docs v3 pt2)
# Valid-day count at which the personal baseline fully replaces the population
# prior. A saturating blend (data_days / (data_days + this)) reaches ~half weight
# here; grounded in the ~50-60 valid-day floor the confidence gates use (docs §6d
# "<20 valid days -> insufficient"; a personal extreme needs ~a season to be real).
Z2_PERSONAL_BASELINE_HALFLIFE_DAYS = 60.0
# ── v3 projection / decay-onset (docs v3 pt6) ──
# [LITERATURE PRIOR] SWC floor: the smallest index move we will ever call
# meaningful, in index points. SWC itself is data-derived (0.5×CV of the user's
# own recent index); this floors it so a pathologically-flat index (CV≈0) still
# yields a finite horizon instead of an infinite one. 0.5 pt ≈ sub-integer noise.
Z2_SWC_MIN_POINTS = 0.5
Z2_SWC_CV_FRACTION = 0.5       # SWC = 0.5 × CV (Plews/Buchheit, docs §6d)
Z2_DECAY_ONSET_MAX_DAYS = 120.0  # projection horizon we bother to search (4 mo)
Z2_ANCHOR_BETA_TAU_DAYS = 45.0

# ---- v2 fixed-ceiling amendment (docs/zone2-fitness-model.md "v2 — locked
# amendments"). The headline index I = D + F, each component bounded by its OWN
# FIXED ceiling; the split never shifts with training age. ----
ZONE2_DURABLE_CEILING = 70.0  # C_D — durable/structural share of the trainable range
ZONE2_FAST_CEILING = 30.0     # C_F — fast-reversible (plasma-volume + enzyme) share
ZONE2_INDEX_CEILING = 100.0   # I = D + F tops out here

# F = C_F * (1 - exp(-fast_load / FAST_SAT)) — a SATURATING map, NOT an anchor to
# τ_fast. τ_fast=14 governs how fast fast_load MOVES; FAST_SAT is where the fast
# pool tops out. Reference: the fast compartment is a fast EWMA of the SAME daily
# Z2 stimulus w(t) as the durable one, so its steady state under a consistent
# training week equals the mean daily Z2-TRIMP. FAST_SAT is set to the daily
# Z2-TRIMP a consistently-training athlete sustains at the maintenance/build dose
# — ~4 quality Z2 sessions/wk × ~45 min in-band → ~90 z2-min/wk of steady w, i.e.
# a fast-EWMA steady state of ~ (90 min * 2 Edwards-weight / 7 days) ≈ 26 load
# units/day. At fast_load = FAST_SAT, F = C_F*(1-1/e) ≈ 0.63*C_F (the pool is
# ~63% saturated at the sustained-training reference and asymptotes to C_F above
# it) — plasma-volume expansion + oxidative-enzyme activity saturate with more
# volume, they do not scale linearly. Tunable via zone2_fitness_params.fast_sat.
ZONE2_FAST_SAT = 26.0

# The durable LEVEL is re-anchored to the user's OWN sports (v2 Thread 2), not to
# the swim/indoor-bike-blind watch VO2max. Blend weights over the available
# submaximal-efficiency + autonomic signals; watch VO2max is LOW-WEIGHT occasional
# calibration only (applied on days it refreshed), NEVER the cap.
ZONE2_LEVEL_W_SWIM_EF = 0.30   # own swim submaximal efficiency (pace/HR percentile)
ZONE2_LEVEL_W_BIKE_EF = 0.35   # own bike efficiency proxy — cleaner (no stroke confound)
ZONE2_LEVEL_W_RHR = 0.20       # resting-HR trend (technique-free, robust)
ZONE2_LEVEL_W_HRV = 0.15       # HRV trend (PPG-noisy, lowest own-signal weight)
ZONE2_LEVEL_W_VO2MAX = 0.10    # watch VO2max — occasional low-weight calibration only


def z2_trimp_from_zones(time_in_zones: dict) -> float:
    """Zone-2 stimulus w(t) of a single workout (spec §1): Edwards zone-2 weight
    plus half-credited upper-aerobic (z3) spillover. z1/z4/z5 contribute 0 by
    design — this metric is Zone-2-scoped.

    Accepts a dict keyed either by int zone (1..5) or by the jsonb string keys
    ('z2','z3') that computed_workout.time_in_zones stores; values are seconds.
    """

    def sec(zone: int) -> float:
        if zone in time_in_zones:
            return float(time_in_zones[zone] or 0.0)
        return float(time_in_zones.get(f"z{zone}", 0.0) or 0.0)

    z2_sec = sec(2)
    z3_sec = sec(3)
    return (z2_sec / 60.0) * 2.0 + (z3_sec / 60.0) * 3.0 * 0.5


def vo2max_to_score(v: float) -> float:
    """Piecewise-linear, clamped VO2max→0-100 map (spec §4b). FRIEND reference
    percentiles anchor the knots: 30→20 (deconditioned floor), 48→55 (median
    knee), 62→100 (90th pct ceiling). Both ends clamp."""
    if v <= 30.0:
        return 20.0
    if v <= 48.0:
        return 20.0 + (v - 30.0) * (55.0 - 20.0) / (48.0 - 30.0)
    if v <= 62.0:
        return 55.0 + (v - 48.0) * (100.0 - 55.0) / (62.0 - 48.0)
    return 100.0


def durable_score_from_percentile(
    pct_score: float, durable_ceiling: float = ZONE2_DURABLE_CEILING
) -> float:
    """v2 rescale (docs v2 "Ceiling split + anchoring"): the durable/structural
    share is expressed on [0, C_D], not [0,100]. A percentile-style score in
    [0,100] (e.g. vo2max_to_score, or a fused own-sports level) maps linearly onto
    [0, C_D] and clamps there. This is what turns the v1 [0,100] durable framing
    into the v2 fixed-ceiling durable component D."""
    return max(0.0, min(durable_ceiling, pct_score / 100.0 * durable_ceiling))


def fast_score_from_load(
    fast_load: float,
    fast_ceiling: float = ZONE2_FAST_CEILING,
    fast_sat: float = ZONE2_FAST_SAT,
) -> float:
    """v2 fast component F ∈ [0, C_F] (docs v2 "Ceiling split + anchoring"):
    F = C_F · (1 − exp(−fast_load / fast_sat)), a monotonic SATURATING map of the
    fast-EWMA load. τ_fast=14 governs how fast fast_load MOVES; fast_sat is the
    saturation REFERENCE (where the plasma-volume/enzyme pool tops out), NOT the
    half-life. Monotone-increasing in fast_load, F→C_F as load→∞, F(0)=0, and F
    never exceeds C_F. Non-positive load → 0."""
    if fast_sat <= 0:
        return 0.0
    if fast_load <= 0:
        return 0.0
    return fast_ceiling * (1.0 - math.exp(-fast_load / fast_sat))


def durable_level_score(
    swim_ef_pct: float | None,
    bike_ef_pct: float | None,
    rhr_pct: float | None,
    hrv_pct: float | None,
    vo2max_pct: float | None,
    vo2max_refreshed: bool = False,
) -> float | None:
    """v2 re-anchored durable LEVEL (docs v2 "Re-anchoring"; Thread 2). Returns a
    percentile-style level in [0,100] blended from the user's OWN sports, NOT the
    swim/indoor-bike-blind watch VO2max:

      - swim_ef_pct / bike_ef_pct: own submaximal efficiency mapped to a percentile
      - rhr_pct / hrv_pct: own resting-HR / HRV trend percentiles
      - vo2max_pct: watch VO2max percentile — LOW-WEIGHT occasional calibration
        ONLY, and only counted on days it refreshed (vo2max_refreshed=True). It is
        NEVER the cap: it enters as one weighted term among many, so it can neither
        push the level above what the sports imply nor floor it below.

    Each argument is a percentile-style value in [0,100] or None when unavailable;
    missing signals drop out and the present weights renormalize. Returns None when
    NO own-sports signal is available (caller then falls back to load dynamics and
    a WIDE band — no fabricated precision).

    The caller maps this [0,100] level onto [0, C_D] via durable_score_from_percentile."""
    terms: list[tuple[float, float]] = []
    if swim_ef_pct is not None:
        terms.append((swim_ef_pct, ZONE2_LEVEL_W_SWIM_EF))
    if bike_ef_pct is not None:
        terms.append((bike_ef_pct, ZONE2_LEVEL_W_BIKE_EF))
    if rhr_pct is not None:
        terms.append((rhr_pct, ZONE2_LEVEL_W_RHR))
    if hrv_pct is not None:
        terms.append((hrv_pct, ZONE2_LEVEL_W_HRV))
    # Watch VO2max is included ONLY when it actually refreshed that day, and always
    # at low weight — the demotion from v1's primary anchor (docs v2 Thread 2).
    if vo2max_pct is not None and vo2max_refreshed:
        terms.append((vo2max_pct, ZONE2_LEVEL_W_VO2MAX))

    # Level requires at least one OWN-sports signal; a lone refreshed VO2max is not
    # enough to place the level (it may never let the swimmer reach his ceiling).
    own_signal = any(
        v is not None for v in (swim_ef_pct, bike_ef_pct, rhr_pct, hrv_pct)
    )
    if not own_signal or not terms:
        return None

    wsum = sum(w for _, w in terms)
    if wsum <= 0:
        return None
    level = sum(v * w for v, w in terms) / wsum
    return max(0.0, min(100.0, level))


def ewma_alpha(tau: float) -> float:
    """Daily smoothing factor for a decay time constant tau (spec §2)."""
    return 1.0 - math.exp(-1.0 / tau)


def base_consolidation(
    weekly_z2_minutes: list[float],
    b_ref: float = Z2_B_REF_MIN_PER_WK,
) -> float:
    """B ∈ [0,1] — accumulated-base consolidation (spec §3): a ~180-day EWMA of
    weekly Zone-2 minutes (weekly step), normalized by b_ref and clamped. Seeded
    at 0. Returns the final B; an empty history is B=0 (brand-new)."""
    alpha_b = 1.0 - math.exp(-7.0 / 180.0)
    b_raw = 0.0
    for wk in weekly_z2_minutes:
        b_raw += alpha_b * (float(wk) - b_raw)
    return max(0.0, min(1.0, b_raw / b_ref))


def tau_slow(
    b: float,
    tau_min: float = Z2_TAU_SLOW_MIN_DAYS,
    tau_max: float = Z2_TAU_SLOW_MAX_DAYS,
) -> float:
    """Durable time constant τ_slow(B) = 45 + 45·B days (spec §3). B clamps to
    [0,1] so tau_slow(0)=45 (beginner) and tau_slow(1)=90 (consolidated)."""
    bc = max(0.0, min(1.0, b))
    return tau_min + (tau_max - tau_min) * bc


def durable_floor_score(
    b: float,
    f_max: float = Z2_F_MAX,
    p: float = Z2_FLOOR_P,
) -> float:
    """FLOOR_score(B) = f_max·100·B^p in 0-100 score units (spec §3). f_max is a
    fraction (0.55) so the ceiling of the floor is 55 at B=1; a beginner (B=0)
    has a ~0 floor (decays to baseline), a veteran retains an elevated floor."""
    bc = max(0.0, min(1.0, b))
    return f_max * 100.0 * (bc ** p)


# ---------------------------------------------------------------------------
# v3 — x-intercept elevation with PERSONAL baselines (docs v3 pt2 + pt5).
# Each fitness signal is scored as its ELEVATION above the USER'S OWN detrained
# baseline, not an absolute percentile. baseline → 0, top-amateur → C_D(70). The
# baseline blends from a population prior toward the user's personal detrained
# extreme as valid days accrue — NO fixed 68/32 once the user's own data exists.
# ---------------------------------------------------------------------------

def personal_baseline_weight(
    valid_days: int,
    halflife_days: float = Z2_PERSONAL_BASELINE_HALFLIFE_DAYS,
) -> float:
    """Weight ∈ [0,1] on the user's OWN detrended baseline vs the population prior
    (docs v3 pt5). A saturating function of how much personal history exists:

        w_personal = valid_days / (valid_days + halflife_days)

    valid_days=0 → 0 (pure population prior; the user has no history yet).
    valid_days→∞ → 1 (pure personal baseline). Monotone-increasing in valid_days
    so the baseline shifts CONTINUOUSLY from population to personal as data accrues
    — never a step, never a fixed 68/32 once personal data exists. DATA-DERIVED."""
    vd = max(0, valid_days)
    hl = max(1e-9, halflife_days)
    return vd / (vd + hl)


def blended_baseline(
    personal_baseline: float | None,
    population_prior: float,
    valid_days: int,
    halflife_days: float = Z2_PERSONAL_BASELINE_HALFLIFE_DAYS,
) -> float:
    """The detrained baseline a signal is scored against (docs v3 pt2/pt5). Blends
    the user's OWN most-detrained extreme toward the population prior, weighted by
    how much personal history exists:

        baseline = w·personal + (1−w)·population,  w = personal_baseline_weight(...)

    When personal history is absent (personal_baseline is None, or valid_days=0)
    this returns the population prior. As valid days accrue it shifts continuously
    to the personal extreme. When personal data exists the population prior's
    influence decays away — satisfying "no fixed 68/32 when the user's own data
    exists" (the pop prior's weight → 0 as valid_days → ∞)."""
    if personal_baseline is None:
        return population_prior
    w = personal_baseline_weight(valid_days, halflife_days)
    return w * float(personal_baseline) + (1.0 - w) * float(population_prior)


def signal_elevation_score(
    value: float | None,
    baseline: float,
    top_amateur: float,
    ceiling: float = ZONE2_DURABLE_CEILING,
    higher_is_fitter: bool = True,
) -> float | None:
    """Score one fitness signal as its ELEVATION above the detrained baseline,
    mapped baseline→0 and top-amateur→`ceiling` (docs v3 pt2). Continuous and
    clamped to [0, ceiling]:

        higher_is_fitter (VO2max, EF):  frac = (value − baseline)/(top − baseline)
        lower_is_fitter  (RHR):         frac = (baseline − value)/(baseline − top)

    A detrained value sits at ~0; a top-decile-amateur value sits at `ceiling`
    (=C_D, 70). Returns None when the value is missing or the baseline/top span is
    degenerate (caller then drops this signal from the fusion). No band lookup, no
    fixed offset — a pure continuous elevation."""
    if value is None:
        return None
    span = (top_amateur - baseline) if higher_is_fitter else (baseline - top_amateur)
    if abs(span) < 1e-9:
        return None
    frac = ((value - baseline) if higher_is_fitter else (baseline - value)) / span
    return max(0.0, min(ceiling, frac * ceiling))


def z2_durable_sharpness_series(
    daily_z2_load: list[float],
    tau_fast: float = Z2_TAU_FAST_DAYS,
    tau_slow_days: float = Z2_TAU_SLOW_MIN_DAYS,
    floor_load: float = 0.0,
) -> list[tuple[float, float]]:
    """Per-day (durable_load, sharp_load), both EWMAs over the same daily Z2
    load, seeded at 0 (spec §2).

    - sharp_load: plain fast EWMA, alpha_fast = 1-exp(-1/tau_fast).
    - durable_load: slow EWMA build, then on any *falling* day the Newton-cooling
      floor rule (spec §2c) replaces the value so it decays toward floor_load,
      never below it: durable = floor + (prev - floor)*exp(-1/tau_slow).

    tau_slow_days and floor_load are held fixed across the series (resolved from
    B by the caller); this matches the nightly single-pass usage and keeps the
    math pinnable."""
    alpha_fast = ewma_alpha(tau_fast)
    alpha_slow = ewma_alpha(tau_slow_days)
    decay_slow = math.exp(-1.0 / tau_slow_days)

    out: list[tuple[float, float]] = []
    durable = sharp = 0.0
    for w in daily_z2_load:
        w = float(w)
        sharp += alpha_fast * (w - sharp)

        prev_durable = durable
        built = prev_durable + alpha_slow * (w - prev_durable)
        if built < prev_durable:  # detraining day: decay toward the floor, not 0
            built = floor_load + (prev_durable - floor_load) * decay_slow
        durable = built
        out.append((durable, sharp))
    return out


def durable_base_series(
    durable_load_track: list[float],
    floor_d: float,
    ceiling: float = ZONE2_DURABLE_CEILING,
    calib_load: float | None = None,
    calib_score: float | None = None,
    floor_load: float = 0.0,
) -> list[float]:
    """v3 pt1 — durable D ∈ [floor_d, ceiling] as a LOAD-DRIVEN, DECAYING series.

    The durable base tracks the load-driven durable_load compartment (which builds
    with Z2 load and decays toward its floor `floor_load` during gaps — see
    z2_durable_sharpness_series); the x-intercept ELEVATION signals only CALIBRATE
    the load→score scale, they do NOT pin D flat. Because D is a strictly
    increasing function of durable_load, and durable_load decays toward floor_load
    during a zero-load stretch, D DECAYS TOWARD floor_d during that stretch — even
    if the elevation inputs are held constant favorable (docs v3 pt1 acceptance).

    Calibration (docs v3 pt2/pt5) is an AFFINE load→score map pinned at two points:
        floor_load → floor_d     (a fully-detrained load reads the earned floor)
        calib_load → calib_score (the current load reads the elevation-implied height)

        slope = (calib_score − floor_d) / (calib_load − floor_load)
        D(t)  = clamp( floor_d + slope·(load(t) − floor_load), floor_d, ceiling )

    When the load track sits at its floor, D = floor_d exactly — so a gap decays D
    to the earned floor, not to some residual above it. Falls back to a
    range-anchored map (max load → ceiling) when no calibration is supplied."""
    track = [float(x) for x in durable_load_track]
    if not track:
        return []
    fl = float(floor_load)
    if (
        calib_load is not None
        and calib_score is not None
        and (float(calib_load) - fl) > 1e-9
    ):
        # affine map pinned at (floor_load -> floor_d) and (calib_load -> calib_score).
        slope = (float(calib_score) - floor_d) / (float(calib_load) - fl)
    else:
        ref = max((x for x in track), default=fl)
        slope = ((ceiling - floor_d) / (ref - fl)) if (ref - fl) > 1e-9 else 0.0
    out: list[float] = []
    for load in track:
        d = floor_d + slope * (load - fl)
        out.append(max(floor_d, min(ceiling, d)))
    return out


def anchor_beta(
    days_since_vo2max: int | None,
    vo2max_confidence: float,
    beta0: float = Z2_ANCHOR_BETA0,
    tau_days: float = Z2_ANCHOR_BETA_TAU_DAYS,
) -> float:
    """Weight on the VO2max anchor (spec §4c): beta0·exp(-days_since/45)·conf. A
    fresh, corroborated VO2max dominates the level; a stale/uncorroborated one
    yields to load dynamics. No VO2max at all → 0 (pure dynamics)."""
    if days_since_vo2max is None:
        return 0.0
    return beta0 * math.exp(-max(0, days_since_vo2max) / tau_days) * max(0.0, min(1.0, vo2max_confidence))


def fuse_inverse_variance(estimates: list[tuple[float, float]]) -> tuple[float, float] | None:
    """Inverse-variance weighted mean + posterior SD (spec §6c). `estimates` is
    a list of (value, variance); variances ≤ 0 are skipped. Returns
    (fused_mean, posterior_sd), or None when no usable estimate exists."""
    num = 0.0
    wsum = 0.0
    for value, variance in estimates:
        if variance is None or variance <= 0:
            continue
        w = 1.0 / variance
        num += w * float(value)
        wsum += w
    if wsum <= 0:
        return None
    mean = num / wsum
    posterior_sd = math.sqrt(1.0 / wsum)
    return mean, posterior_sd


# ---------------------------------------------------------------------------
# v3 — PROJECTION-DERIVED decay_onset (docs v3 pt6). REPLACES the warn_after_days
# B-band lookup (7/12/21) ENTIRELY. The horizon is computed from the model's OWN
# forward projection and a data-derived SWC — the bands EMERGE from the math:
#   F_proj(t) = F·exp(−t/τ_fast)
#   D_proj(t) = floor + (D−floor)·exp(−t/τ_slow(B))
#   I(t)      = D_proj(t) + F_proj(t)
#   decay_onset = smallest t where I(0) − I(t) ≥ SWC
# A thin base (F dominates, small D/floor → I falls at ~τ_fast) yields a SHORT
# horizon; a banked base (large D + high floor → I falls at ~τ_slow) yields a
# LONG one. Continuous in D, F, floor, τ_slow — NOT a step function.
# ---------------------------------------------------------------------------

def swc_from_index(
    recent_index: list[float],
    cv_fraction: float = Z2_SWC_CV_FRACTION,
    swc_min: float = Z2_SWC_MIN_POINTS,
) -> float:
    """Smallest worthwhile change (index points), DATA-DERIVED from the user's own
    index variability (docs v3 pt6, Plews/Buchheit): SWC ≈ 0.5 × CV of the recent
    index, expressed in the index's own points (CV·mean = SD-scale), floored at a
    small minimum so a pathologically-flat index still yields a finite horizon.

        SWC = max( cv_fraction × CV × mean , swc_min )
            = max( cv_fraction × SD , swc_min )     [since CV = SD/mean]

    A noisy index (large CV) demands a larger real move before we call it decay; a
    stable one lets a small move count. Grounded in the user's OWN signal, not a
    constant. Empty/degenerate history falls back to the floor."""
    vals = [float(v) for v in recent_index if v is not None]
    if len(vals) < 2:
        return swc_min
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)
    sd = math.sqrt(max(0.0, var))
    return max(swc_min, cv_fraction * sd)


def project_index(
    durable: float,
    fast: float,
    floor: float,
    tau_slow_days: float,
    t: float,
    tau_fast: float = Z2_TAU_FAST_DAYS,
) -> float:
    """The model's forward index projection I(t) if training stops now (docs v3
    pt6). Fast layer decays to 0 at τ_fast; durable layer decays toward its floor
    at τ_slow(B). Every input is the user's CURRENT state — no fixed offsets."""
    f_proj = fast * math.exp(-t / max(1e-9, tau_fast))
    d_proj = floor + (durable - floor) * math.exp(-t / max(1e-9, tau_slow_days))
    return d_proj + f_proj


def decay_onset_days(
    durable: float,
    fast: float,
    floor: float,
    tau_slow_days: float,
    swc: float,
    tau_fast: float = Z2_TAU_FAST_DAYS,
    max_days: float = Z2_DECAY_ONSET_MAX_DAYS,
) -> float:
    """PROJECTION-DERIVED decay-onset horizon in days (docs v3 pt6): the smallest
    t where the projected index has fallen by at least one SWC,
    I(0) − I(t) ≥ swc. Solved on the continuous projection (bisection on the
    monotone drop), so the horizon moves CONTINUOUSLY with D, F, floor and τ_slow
    — it is NOT the old 7/12/21 step lookup.

    Emergent behavior (verified by test): a thin base (F dominates a small D near
    a ~0 floor → I falls fast at ~τ_fast) gives a SHORT horizon; a banked base
    (large D, high floor → the drop is bounded by (I(0)−floor)·(fast decay) plus
    slow durable erosion) gives a LONG one. If the index can never fall by a full
    SWC within max_days (e.g. F≈0 and D already at floor), returns max_days."""
    i0 = project_index(durable, fast, floor, tau_slow_days, 0.0, tau_fast=tau_fast)
    drop_at = lambda t: i0 - project_index(durable, fast, floor, tau_slow_days, t, tau_fast=tau_fast)

    # I(t) is monotone non-increasing (both exponentials decay toward >=0 targets
    # with I(0) above them), so the drop is monotone non-decreasing in t. If even
    # the full horizon can't reach one SWC, the base holds past max_days.
    if drop_at(max_days) < swc:
        return max_days
    if drop_at(0.0) >= swc:  # degenerate: already at/over SWC at t=0
        return 0.0

    lo, hi = 0.0, max_days
    for _ in range(60):  # ~1e-18 resolution on [0, max_days]; continuous result
        mid = (lo + hi) / 2.0
        if drop_at(mid) >= swc:
            hi = mid
        else:
            lo = mid
    return hi


ZONE2_MAINTENANCE_MESSAGE = (
    "You're below the dose that holds your level. Two Zone-2 sessions at target "
    "intensity in the next few days keeps it. Miss that and your sharpness fades "
    "first; your durable base erodes more slowly."
)


def zone2_maintenance_flag(
    maintenance_met: bool,
    consecutive_unmet_days: int,
    warn_window: int,
    sharpness: float,
    durable_base: float,
    hold_active: bool,
) -> list[dict]:
    """The zone2_maintenance firing rule (spec §5c). Fires severity 'info' iff
    ALL hold: maintenance unmet for `warn_window` consecutive days AND sharpness
    has dropped below durable_base (form fading faster than the base) AND NOT
    suppressed by an active injury/plan hold. Never red, never single-reading —
    the multi-day window supplies persistence; the two numbers' relationship is
    read, never summed."""
    fires = (
        not maintenance_met
        and consecutive_unmet_days >= warn_window
        and sharpness < durable_base
        and not hold_active
    )
    if not fires:
        return []
    return [
        {
            "type": "zone2_maintenance",
            "severity": "info",
            "message": ZONE2_MAINTENANCE_MESSAGE,
        }
    ]
