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
MIN_ACTIVE_SWIM_HR_SAMPLES = 5
MIN_ACTIVE_SWIM_DRIFT_SAMPLES = 4


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


def _valid_swim_sets(sets: list[dict]) -> list[tuple[float, float, float]]:
    """Normalized `(start, duration, distance)` active blocks, ordered by start."""
    valid_sets: list[tuple[float, float, float]] = []
    for row in sets:
        try:
            start = float(row["start_offset_s"])
            duration = float(row["duration_s"])
            distance = float(row["distance_m"])
        except (KeyError, TypeError, ValueError):
            continue
        if duration <= 0 or distance <= 0:
            continue
        valid_sets.append((start, duration, distance))
    return sorted(valid_sets)


def swim_active_ef(sets: list[dict], samples: list[Sample]) -> float | None:
    """Swim EF from active set windows only, excluding rests from both pace and HR.

    `swim_sets` are ingest-derived active blocks. A swim without those blocks or
    enough in-block HR samples stays unavailable rather than falling back to the
    rest-biased whole-workout duration/average HR.
    """
    valid_sets = _valid_swim_sets(sets)

    if not valid_sets:
        return None

    active_hr = [
        float(bpm)
        for offset, bpm in samples
        if any(start <= offset < start + duration for start, duration, _ in valid_sets)
    ]
    if len(active_hr) < MIN_ACTIVE_SWIM_HR_SAMPLES:
        return None

    distance_m = sum(distance for _, _, distance in valid_sets)
    duration_s = sum(duration for _, duration, _ in valid_sets)
    return ef(distance_m, duration_s, sum(active_hr) / len(active_hr))


def swim_active_hr_drift_pct(sets: list[dict], samples: list[Sample]) -> float | None:
    """HR drift across halves of cumulative active swim time, with rests removed."""
    valid_sets = _valid_swim_sets(sets)
    if not valid_sets:
        return None

    active_windows: list[tuple[float, float, float]] = []
    active_duration = 0.0
    for start, duration, _ in valid_sets:
        active_windows.append((start, start + duration, active_duration))
        active_duration += duration

    active_samples: list[tuple[float, float]] = []
    for offset, bpm in samples:
        for start, end, active_base in active_windows:
            if start <= offset < end:
                active_samples.append((active_base + offset - start, float(bpm)))
                break

    if len(active_samples) < MIN_ACTIVE_SWIM_DRIFT_SAMPLES:
        return None

    midpoint = active_duration / 2.0
    first = [bpm for active_offset, bpm in active_samples if active_offset < midpoint]
    second = [bpm for active_offset, bpm in active_samples if active_offset >= midpoint]
    if not first or not second:
        return None
    avg1 = sum(first) / len(first)
    avg2 = sum(second) / len(second)
    if avg1 == 0:
        return None
    return (avg2 - avg1) / avg1 * 100.0


def swim_ef_eligibility(
    workout_type: str | None,
    sets: list[dict],
    samples: list[Sample],
    bounds: tuple[float, float, float, float],
    swim_hr_offset: float,
) -> bool:
    """Apply the steady-aerobic gate to active swim time and active HR only.

    Zone time is calculated within each set separately so a rest gap between
    sets cannot be bridged by ``time_in_zones``' spacing cap.
    """
    valid_sets = _valid_swim_sets(sets)
    active_tiz = {z: 0 for z in range(1, 6)}
    for start, duration, _ in valid_sets:
        set_samples = [
            (offset, bpm)
            for offset, bpm in samples
            if start <= offset < start + duration
        ]
        set_tiz = time_in_zones(set_samples, bounds, swim_hr_offset)
        for zone, seconds in set_tiz.items():
            active_tiz[zone] += seconds

    active_duration_s = sum(duration for _, duration, _ in valid_sets)
    return ef_eligibility(workout_type, active_tiz, active_duration_s)


def ef_eligibility(workout_type: str | None, tiz: dict[int, int], duration_s: float | None) -> bool:
    """EF/decoupling eligibility: swim, bike AND run, each gated ≥20 min and ≥70%
    of classified time in Z1–Z2 (the same aerobic-specific gate for all three).
    All three stay wired regardless of which currently produce observations —
    the model is built for the data the user MAY produce, never trimmed to what
    exists today (a dormant signal costs nothing; it simply starts contributing
    the day its data appears, e.g. outdoor rides with GPS distance). Right now
    runs carry distance + HR while every bike session to date is indoor with
    distance_m NULL. Indoor rides (and any HR-only run without distance) yield
    ef=None downstream — ef() requires distance — which is fine."""
    if not workout_type:
        return False
    t = workout_type.lower()
    if not any(m in t for m in ("swim", "cycl", "bik", "run")):
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


HRR60_POST_END_MAX_S = 90  # recovery sample must land within 90s of the end


def hrr60(samples: list[Sample], duration_s: float | None) -> float | None:
    """Max HR in the final 2 min minus HR ~60s after the end, when post-end
    samples exist in the stream. Health Auto Export rarely provides them. The
    post-end recovery sample must land in [duration_s + 45, duration_s + 90]:
    bounded above so a sample minutes later (e.g. the next activity) can never
    masquerade as a 60-second recovery reading."""
    if not samples or not duration_s:
        return None
    ordered = sorted(samples)
    final_window = [bpm for off, bpm in ordered if duration_s - 120 <= off <= duration_s]
    post = [
        (abs(off - (duration_s + 60)), bpm)
        for off, bpm in ordered
        if duration_s + 45 <= off <= duration_s + HRR60_POST_END_MAX_S
    ]
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
# [LITERATURE PRIOR] τ_fast: enzyme/plasma-volume turnover E-FOLDING time (the EWMA
# decay constant, NOT a half-life: 14 d as an e-folding time is a half-life of
# 14·ln2 ≈ 9.7 d). Chosen as a physiological PRIOR — the cited oxidative-enzyme
# half-life ~12 d would instead imply τ = 12/ln2 ≈ 17.3 d, so 14 sits between the
# plasma-volume (~days) and enzyme (~2 wk) reversal scales. Molecular, training-age
# independent, and NOT identifiable from thin gap data (docs §7 staged
# personalization + "τ_fast=14 stays a literature PRIOR; do NOT fit from thin
# data"). Stays 14 d until many gap→return episodes exist; overridable via params.
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
# [LITERATURE PRIOR] Top-amateur signal targets for the x-intercept elevation maps
# (docs v3 pt2: baseline → 0, top-decile amateur → C_D). Both overridable via
# zone2_fitness_params (columns rhr_top_amateur / ef_top_factor):
#   RHR ~48 bpm — trained-endurance-amateur resting HR (untrained ~68 bpm →
#   trained amateurs mid-to-high 40s; endurance-training bradycardia is one of the
#   most replicated autonomic adaptations, e.g. Mujika & Padilla 2000).
#   EF top = 1.6 × the user's OWN detrained EF baseline — submaximal economy
#   improves ~40–60% detrained→trained, so the target is PERSONAL (a factor on the
#   user's own baseline), never an absolute EF constant.
Z2_RHR_TOP_AMATEUR = 48.0
Z2_EF_TOP_FACTOR = 1.6

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
# ── projection / decay-onset horizons ──
Z2_DECAY_ONSET_MAX_DAYS = 120.0  # projection horizon we bother to search (4 mo)
# [LITERATURE PRIOR] Signal-staleness time constant (spec §4c / v2 amendment: a
# stale reading must yield to load dynamics). 45 d = the durable compartment's own
# minimum time constant — a reading older than that describes a state the body may
# no longer hold. Reused from the retired v2 anchor-beta machinery (same 45 d
# physiology); now inflates each fusion signal's variance CONTINUOUSLY with age:
#   variance_eff = variance × exp(days_since_signal / 45)
Z2_SIGNAL_STALENESS_TAU_DAYS = 45.0
# ── Level-fusion variances: honest ABSOLUTE D-space variances (points²), NOT
# relative weights. (The old 1/4/9 were relative-only; treating them as absolute
# overstated precision ~5× — conf 0.92 / band ±3.3 with no aerobic anchor at all.)
# Each is still × the staleness inflation above. Derivations:
# [LITERATURE PRIOR] bike EF: day-to-day submaximal EF CV ≈ 4%; the elevation map
#   spans baseline→1.6×baseline (a 0.6·baseline span) onto C_D = 70 pts, so
#   sd ≈ (0.04/0.6)·70 ≈ 4.7 pts → var ≈ 22.
#   NOTE (v5): bike EF has zero observations SO FAR — every cycling session to
#   date is indoor with distance_m NULL, so ef() returns None. It stays fully
#   wired (collection, baseline, fusion) and becomes a trusted aerobic lead the
#   day outdoor rides with GPS distance appear; running EF (below) is the
#   aerobic-specific signal that fires on current data. Model contract: signals
#   are built for data the user may produce, never trimmed to today's data.
Z2_BIKE_EF_VARIANCE = 22.0
# [LITERATURE PRIOR] running EF: the aerobic-specific calibration signal that
#   actually fires (108 runs carry distance + HR, vs 0 usable bike EF). Same
#   architecture as bike EF — ef() = (m/min)/bpm, the SAME elevation map spanning
#   the user's own detrained EF baseline → ef_top_factor×baseline onto C_D, gated
#   to Z1–Z2 runs — so its variance is derived the SAME way: submaximal running EF
#   day-to-day CV ≈ 4% over the 0.6·baseline elevation span onto C_D = 70 pts →
#   sd ≈ (0.04/0.6)·70 ≈ 4.7 pts → var ≈ 22. Overridable via
#   zone2_fitness_params.run_ef_variance. (Running pace↔HR is noisier outdoors than
#   indoor bike power↔HR, but the derivation mirrors bike EF per the model contract;
#   widen this param if the residuals warrant.)
Z2_RUN_EF_VARIANCE = 22.0
# [LITERATURE PRIOR] watch VO2max: Lambe 2025 LoA ≈ ±12 ml/kg/min → sd ≈ 6 ml;
#   elevation slope ≈ C_D/(62−32) ≈ 2.33 pts per ml → sd ≈ 14 pts → var ≈ 196.
#   (EF:VO2 var ratio ≈ 1:9 — the same RATIO as the old relative weights; only
#   the absolute scale changed.)
Z2_VO2MAX_VARIANCE = 196.0
# [LITERATURE PRIOR] B-prior softness. The level fusion always includes the
# estimate (C_D·B_t, (C_D·this)²): B is the normalized ~180-d EWMA of weekly Z2
# minutes — literally the accumulated structural base — with B=1 ≡ a consolidated
# club-level base ≡ the C_D anchor ("top-decile consistently-training amateur")
# and B=0 ≡ no banked base ≡ 0. This variance is the SOFTNESS of that map (a
# marked prior, like f_max): sd = C_D/4 (≈17.5 pts, var ≈ 306 at C_D=70) — soft
# enough that any fresh aerobic-specific signal dominates it, firm enough to set
# the level when no trusted signal exists (v3 pt1: "a sparse Zone-2 trainer reads
# LOW" — the load history is the default level-setter).
Z2_B_PRIOR_SD_FRACTION = 0.25  # sd = C_D/4 → var = (C_D/4)²
# [LITERATURE PRIOR — Hickson dose] Fallback expected-session stimulus w̄ when no
# qualifying session exists in the data window: one 20-min true-Z2 session →
# 20 min × Edwards zone-2 weight 2 = 40 load units (Hickson 1981/1985 minimum
# effective maintenance session, docs §5a).
Z2_MAINTENANCE_SESSION_LOAD = 40.0
# ── v4 build cadence: a CONTINUOUS function of base-consolidation B, not a fixed
# cap (docs v4 amendment). The v3 formula was min(fast-decay horizon, 2.0); for a
# detrained user the fast-decay horizon is unbounded so the 2.0 cap ALWAYS won —
# a hardcoded constant in disguise that never moved with fitness. The frequency
# literature says build FREQUENCY scales UP with training status: sedentary/novice
# gain on ~3 sessions/wk [ACSM 2011; VO2max-trainability meta-analyses], while
# well-trained endurance athletes need ~5–6+/wk to keep improving (diminishing
# marginal stimulus near the ceiling; elite train 10–13/wk). So the cadence is:
#   sessions_per_week(B) = FREQ_BEGINNER + FREQ_SLOPE · B
#   build_cadence_days    = max(FLOOR, 7 / sessions_per_week(B))
# B is the model's own data-derived training-status variable (the same one driving
# τ_slow and the floor), so the cadence is continuous in the user's data THROUGH B.
Z2_BUILD_FREQ_BEGINNER = 3.0  # [LITERATURE PRIOR] sessions/wk, novice VO2max-gain dose (ACSM)
Z2_BUILD_FREQ_SLOPE = 2.5     # [LITERATURE PRIOR] added sessions/wk per unit B → ~5.5/wk at B=1 (well-trained)
# [LITERATURE PRIOR] Molecular re-stimulation floor: PGC-1α (the master
# mitochondrial-biogenesis signal) mRNA peaks ~2 h post-exercise and returns
# toward baseline by ~24 h [Pilegaard 2003, PubMed 12563009]. Re-stimulating the
# build signal more than once a day buys little for a Z2 base, so 24 h floors the
# cadence regardless of B. Training-age INDEPENDENT (molecular kinetics).
Z2_BUILD_INTERVAL_FLOOR_DAYS = 1.0

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

# Non-aerobic workout-type markers for is_aerobic_modality. Categorical modality
# classification (like the swim/bike splits elsewhere), NOT a state/timing constant
# — no v3 dynamic-principle violation.
Z2_NON_AEROBIC_MARKERS = ("strength", "core", "yoga", "pilates")


def is_aerobic_modality(workout_type: str | None) -> bool:
    """Whether a workout's Zone-2-band HR time is a genuine AEROBIC stimulus
    eligible to feed w(t), the intensity-correct session count, and B's weekly
    minutes. Weight-room / core work raises HR into the Z2 band via the pressor
    response (static contractions, intrathoracic pressure) and sympathetic drive
    — NOT via sustained elevated cardiac output and muscle O2 flux, so it builds
    no capillary/mitochondrial base and must not read as Zone-2 aerobic load.
    Yoga/pilates are excluded defensively for the same reason (breath-hold and
    isometric HR elevation). Everything else — rowing, swimming, cycling, walking,
    running, hiking, elliptical, ... — counts; an unknown/missing type counts
    (cannot be shown non-aerobic, and the intensity gates still apply)."""
    if not workout_type:
        return True
    t = workout_type.lower()
    return not any(marker in t for marker in Z2_NON_AEROBIC_MARKERS)


def z2_trimp_from_zones(time_in_zones: dict) -> float:
    """Zone-2 stimulus w(t) of a single workout (spec §1): Edwards zone-2 weight
    plus half-credited upper-aerobic (z3) spillover, PLUS (v5) the easy-aerobic
    band below the Z2 floor — see `Z2_EASY_AEROBIC_WEIGHT`. z4/z5 and the truly
    easy part of z1 (below the adaptation threshold) contribute 0 by design.

    Accepts a dict keyed either by int zone (1..5) or by the jsonb string keys
    ('z2','z3','z1b') that computed_workout.time_in_zones stores; values are
    seconds. A row computed before v5 simply has no 'z1b' key and scores as it
    did before — no backfill required for correctness, only for completeness.
    """

    def sec(zone: int) -> float:
        if zone in time_in_zones:
            return float(time_in_zones[zone] or 0.0)
        return float(time_in_zones.get(f"z{zone}", 0.0) or 0.0)

    z2_sec = sec(2)
    z3_sec = sec(3)
    z1b_sec = float(time_in_zones.get("z1b", 0.0) or 0.0)
    return (
        (z2_sec / 60.0) * 2.0
        + (z3_sec / 60.0) * 3.0 * 0.5
        + (z1b_sec / 60.0) * Z2_EASY_AEROBIC_WEIGHT
    )


# ---------------------------------------------------------------------------
# v5 — easy-aerobic (sub-Z2) credit and the ambulatory ambient channel.
# See TODO.md §6 and knowledge topics/low-intensity-volume-threshold.md.
#
# The governing evidence (Swain & Franklin 2002, MSSE): the MINIMUM intensity
# that still builds VO2max is not a constant — it scales UP with fitness.
# Initial VO2max < 40 ml/kg/min: no tested intensity was ineffective, down to the
# lowest anyone tried (~30% VO2R). Initial VO2max > 40: below ~45% VO2R was
# consistently ineffective. %VO2R maps onto %HRR, so these read directly as
# heart-rate-reserve fractions. A FIXED 60% HRR Z2 floor therefore demands the
# highest relative effort from exactly the user whose true threshold is lowest.
# ---------------------------------------------------------------------------

# [LITERATURE PRIOR] The two Swain & Franklin anchor points, as %HRR.
Z2_ADAPT_FRAC_LOW_FIT = 0.30
Z2_ADAPT_FRAC_HIGH_FIT = 0.45
# [LITERATURE PRIOR] Their split point: initial VO2max 40 ml/kg/min.
Z2_ADAPT_VO2_LOW = 40.0
# [CHOSEN PRIOR] Swain & Franklin give a STEP at VO2max 40, not a curve. Smoothing
# it into a ramp from 40 up to the model's own top-amateur VO2 anchor is OUR
# choice, made to honour the v3 "continuous in the user's data" principle rather
# than because the paper supports a gradient. A step would make the whole index
# jump discontinuously the day a watch VO2max reading crosses 40.
Z2_ADAPT_VO2_HIGH = Z2_ANCHOR_VO2_100
# [CHOSEN PRIOR] Edwards-style weight for a minute in the easy-aerobic band
# [adaptation threshold, Z2 floor). The band is credited on a conceptual 0→2 ramp
# across its width; a single aggregated second-count cannot say where within the
# band a minute sat, so it is credited at the ramp's MEAN, which is 1.0 — half a
# true Zone-2 minute. Not a derived number: Oja 2018 (37 RCTs, n=2001) tested 91
# walking dose-response relationships and found chance-level significance,
# concluding there is "insufficient evidence to quantify" the dose.
Z2_EASY_AEROBIC_WEIGHT = 1.0


def adaptation_threshold_frac(
    vo2max: float | None,
    low_frac: float = Z2_ADAPT_FRAC_LOW_FIT,
    high_frac: float = Z2_ADAPT_FRAC_HIGH_FIT,
    vo2_low: float = Z2_ADAPT_VO2_LOW,
    vo2_high: float = Z2_ADAPT_VO2_HIGH,
) -> float:
    """The %HRR below which aerobic work stops building, as a function of the
    user's CURRENT fitness (Swain & Franklin 2002, smoothed — see the constants).

    Clamps to `low_frac` at or below `vo2_low` and to `high_frac` at or above
    `vo2_high`; linear between. An unknown VO2max returns `low_frac`: the
    conservative reading for someone with no measured fitness is that they are
    detrained, which is the case where easy work counts for MORE, and getting
    that wrong under-credits rather than inflates.
    """
    if vo2max is None or not math.isfinite(vo2max):
        return low_frac
    if vo2_high <= vo2_low:
        return high_frac
    t = (float(vo2max) - vo2_low) / (vo2_high - vo2_low)
    return low_frac + max(0.0, min(1.0, t)) * (high_frac - low_frac)


def adaptation_threshold_bpm(hr_max: float, rhr: float, vo2max: float | None) -> float:
    """Karvonen HR at the adaptation threshold: `rhr + frac(VO2max) · HRR`. Same
    reserve arithmetic as `zone_bounds`, so the two are directly comparable."""
    return rhr + adaptation_threshold_frac(vo2max) * (hr_max - rhr)


def easy_aerobic_seconds(
    samples: list[Sample],
    threshold_bpm: float,
    z2_low_bpm: float,
    swim_hr_offset: float = 0.0,
) -> int:
    """Seconds in the easy-aerobic band `[threshold_bpm, z2_low_bpm)` — the part
    of the app's Zone 1 that is still above the adaptation threshold.

    Deliberately a SEPARATE accumulator rather than a sixth entry in
    `time_in_zones`: that function's 1..5 dict is consumed in several places that
    assume exactly five integer keys, and widening it would ripple. Sample
    duration follows the identical rule (gap to next sample, capped at
    SPACING_CAP_S; the last sample contributes nothing), so this band and the
    zone buckets are measured on the same clock and can be summed safely.
    """
    if z2_low_bpm <= threshold_bpm:
        return 0
    total = 0
    ordered = sorted(samples)
    for (offset, bpm), (next_offset, _) in zip(ordered, ordered[1:]):
        adjusted = bpm - swim_hr_offset
        if threshold_bpm <= adjusted < z2_low_bpm:
            total += min(next_offset - offset, SPACING_CAP_S)
    return total


# ── ambulatory ambient channel (TODO.md §6 Part A) ──────────────────────────
# The index must not depend on whether the user pressed "start workout". Daily
# active energy is logging-invariant and already ingested, so the load that
# unlogged walking represents is derivable: total active energy MINUS what logged
# workouts already account for, above the user's own sedentary baseline.

# [CHOSEN PRIOR] Load units per excess ambient kcal. Anchored by the user's own
# logged data rather than literature (which declines to supply one — Oja 2018):
# a steady pool swim works out to roughly 0.18 load/kcal at
# true Zone-2 intensity. Ambulatory work is credited at ~1/3 of that, the
# "transfer is always a discount" constraint from Tanaka 1994. Deliberately
# conservative: under-crediting a walk is a smaller error than letting errands
# masquerade as training.
Z2_AMBIENT_LOAD_PER_KCAL = 0.06
# [CHOSEN PRIOR] Daily ceiling in load units. A day of walking, however long, must
# not out-score a hard training session (a hard logged session
# scores around this ceiling). Saturating rather than clipped, so the map stays smooth.
Z2_AMBIENT_DAILY_MAX = 60.0
# Percentile of the user's OWN daily ambient series taken as their sedentary
# baseline — data-derived per the v3 dynamic principle, never a fixed kcal
# constant (an inactive day is a personal quantity).
Z2_AMBIENT_BASELINE_PCT = 20.0


def ambient_daily_load(
    ambient_kcal: float | None,
    sedentary_kcal: float,
    rate: float = Z2_AMBIENT_LOAD_PER_KCAL,
    daily_max: float = Z2_AMBIENT_DAILY_MAX,
) -> float:
    """Build stimulus from a day's UNLOGGED ambulatory activity, in load units.

        excess = max(0, ambient_kcal − sedentary_kcal)
        load   = daily_max · (1 − exp(−rate · excess / daily_max))

    Saturating: near-linear at `rate` for ordinary days, asymptotic to `daily_max`
    for an exceptional one. Missing energy data returns 0.0 — a day we cannot see
    contributes nothing rather than guessing.

    NOTE on `flights_climbed`: an earlier draft of this spec added a separate
    vertical-work term. It is deliberately NOT here — Apple's active-energy
    already includes the cost of climbing, so adding flights on top would double
    count the same joules (each ~3 m flight's cost is already inside the
    number). Flights remain useful as a bout-structure signal if one is ever
    needed; they are not additive load.
    """
    if ambient_kcal is None or not math.isfinite(ambient_kcal):
        return 0.0
    excess = max(0.0, float(ambient_kcal) - sedentary_kcal)
    if excess <= 0.0 or daily_max <= 0.0 or rate <= 0.0:
        return 0.0
    return daily_max * (1.0 - math.exp(-rate * excess / daily_max))


def calibrate_kcal_per_km(pairs: list[tuple[float, float]]) -> float | None:
    """Median daily active-kcal per walking+running km, fitted from the user's OWN
    days where BOTH readings exist. Returns None when there is nothing to fit.

    Why a fitted ratio and not a literature walking-economy constant: the quantity
    being estimated is the day's WHOLE active-energy total, of which ambulation is
    the bulk but not all — so a textbook kcal/kg/km figure would systematically
    under-read. Fitting it to their own overlap makes the estimator carry whatever
    their real mix is, and it self-corrects as that mix changes (v3 dynamic
    principle). `pairs` is [(active_kcal, distance_m)]; days under a kilometre are
    dropped because the ratio is unstable there.
    """
    ratios = sorted(
        kcal / (dist / 1000.0)
        for kcal, dist in pairs
        if kcal is not None and dist is not None and dist > 1000.0 and math.isfinite(kcal)
    )
    if not ratios:
        return None
    mid = len(ratios) // 2
    return ratios[mid] if len(ratios) % 2 else (ratios[mid - 1] + ratios[mid]) / 2.0


def estimated_active_kcal(distance_m: float | None, kcal_per_km: float | None) -> float | None:
    """Fallback day-level active energy from walking+running distance, for the long
    stretch of history before HAE began sending `active_energy` (most older days
    have no energy reading, but they do have distance).

    Returns None — never a guess — when either input is missing, so a day with no
    usable signal keeps contributing exactly nothing.
    """
    if distance_m is None or kcal_per_km is None or not math.isfinite(distance_m):
        return None
    return max(0.0, float(distance_m) / 1000.0 * kcal_per_km)


def sedentary_ambient_baseline(
    ambient_series: list[float], pct: float = Z2_AMBIENT_BASELINE_PCT
) -> float:
    """The user's own inactive-day ambient burn: the `pct`th percentile of their
    daily ambient-kcal series. Empty input returns 0.0, which makes every day read
    as fully "excess" — acceptable only because it cannot occur alongside real
    energy data, and erring toward 0 never suppresses a real signal silently."""
    values = sorted(v for v in ambient_series if v is not None and math.isfinite(v))
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    rank = (pct / 100.0) * (len(values) - 1)
    lo = int(math.floor(rank))
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (rank - lo)


# Modality markers for activity whose energy is ALREADY inside daily active
# energy and which therefore must not also feed w(t) through the workout channel
# (TODO.md §6 Part A step 5). This is what makes the index logging-invariant:
# logging a walk moves no number, because the walk was already counted.
Z2_AMBULATORY_MARKERS = ("walk", "hiking")


def is_ambulatory_modality(workout_type: str | None) -> bool:
    """Whether a workout is ambulatory (walk/hike) and thus already represented in
    the day's active-energy total. Such workouts are excluded from the workout
    `w(t)` channel, the intensity-correct session count, and B's weekly minutes —
    not because walking doesn't build (it does; see the module docstring above),
    but because the ambient channel already credits it, from data that exists
    whether or not the user started a workout."""
    if not workout_type:
        return False
    t = workout_type.lower()
    return any(marker in t for marker in Z2_AMBULATORY_MARKERS)


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


def ewma_alpha(tau: float) -> float:
    """Daily smoothing factor for a decay time constant tau (spec §2)."""
    return 1.0 - math.exp(-1.0 / tau)


def base_consolidation_series(
    weekly_z2_minutes: list[float],
    b_ref: float = Z2_B_REF_MIN_PER_WK,
) -> list[float]:
    """Per-week B ∈ [0,1] — accumulated-base consolidation (spec §3): a ~180-day
    EWMA of weekly Zone-2 minutes (weekly step), normalized by b_ref and clamped,
    seeded at 0. Element i is B after week i, so the caller can stamp each
    historical day with the CAUSAL B of its own week — never today's B (v3
    dynamic principle: no fictional history). The weekly axis MUST include
    workout-free weeks as 0.0 so B decays through a fully-off gap.

    b_ref ≤ 0 (a corrupted params row) falls back to the literature default
    rather than crashing the nightly job."""
    if b_ref is None or b_ref <= 0:
        b_ref = Z2_B_REF_MIN_PER_WK
    alpha_b = 1.0 - math.exp(-7.0 / 180.0)
    out: list[float] = []
    b_raw = 0.0
    for wk in weekly_z2_minutes:
        b_raw += alpha_b * (float(wk) - b_raw)
        out.append(max(0.0, min(1.0, b_raw / b_ref)))
    return out


def base_consolidation(
    weekly_z2_minutes: list[float],
    b_ref: float = Z2_B_REF_MIN_PER_WK,
) -> float:
    """Final B of base_consolidation_series; an empty history is B=0 (brand-new)."""
    series = base_consolidation_series(weekly_z2_minutes, b_ref=b_ref)
    return series[-1] if series else 0.0


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


# ── v4.2 NEAT / ambient-activity floor (docs v4.2). Casual daily movement
# (walking around, being on your feet) is a WEAK Zone-2 BUILD stimulus — a stroll
# stays in Zone 1, so it must NOT add to w(t) — but a REAL maintenance one: high
# non-exercise activity slows detraining (plasma volume, capillary density and
# resting HR hold up better than in true sedentary rest) [Levine NEAT reviews;
# sedentary-vs-active detraining literature]. So daily STEPS raise the durable
# FLOOR — an active-lifestyle stretch decays toward a higher floor than sitting
# still — without ever counting as building. Modest and saturating by design.
Z2_NEAT_STEPS_SEDENTARY = 2500.0  # [PRIOR] ≤ this ≈ truly inactive → no floor bonus
Z2_NEAT_STEPS_SCALE = 5000.0      # [PRIOR] saturation scale (steps above sedentary)
Z2_NEAT_FLOOR_MAX_PCT = 8.0       # [PRIOR] max floor bonus, % of C_D (≈5.6 pts) at high NEAT
Z2_NEAT_STEPS_TAU_DAYS = 21.0     # [PRIOR] EWMA window — SUSTAINED activity, not one big day


def neat_floor_score(
    steps_ewma: float,
    sedentary: float = Z2_NEAT_STEPS_SEDENTARY,
    scale: float = Z2_NEAT_STEPS_SCALE,
    max_pct: float = Z2_NEAT_FLOOR_MAX_PCT,
) -> float:
    """Ambient-activity floor bonus in [0, max_pct] SCORE units (% of C_D), a
    saturating function of the user's SMOOTHED daily steps above a sedentary
    baseline (docs v4.2):

        neat = max_pct · (1 − exp(−(steps_ewma − sedentary) / scale))   [steps > sedentary]
             = 0                                                         [otherwise]

    It feeds the FLOOR (added to durable_floor_score(B)), NOT w(t) — NEAT maintains,
    it does not build. Continuous and data-derived from the user's own step count;
    the anchors (sedentary threshold, scale, cap) are marked literature priors,
    conservatively set since NEAT's effect on detraining is real but modest.
    `steps_ewma` is a ~21-day CAUSAL EWMA (sustained activity, not a single big
    day). Monotone-increasing, saturating at max_pct."""
    s = float(steps_ewma)
    if s <= sedentary or scale <= 0:
        return 0.0
    return max_pct * (1.0 - math.exp(-(s - sedentary) / scale))


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


def _per_day(value, n: int) -> list[float]:
    """Broadcast a scalar to n days, or validate a per-day sequence of length n.
    Lets the series functions take per-day CAUSAL τ_slow/floor tracks (v3: every
    quantity a continuous function of the actual data, per-day — no stamping
    today's state onto history) while keeping scalar convenience for tests."""
    if isinstance(value, (int, float)):
        return [float(value)] * n
    seq = [float(v) for v in value]
    if len(seq) != n:
        raise ValueError(f"per-day sequence has length {len(seq)}, expected {n}")
    return seq


def z2_durable_sharpness_series(
    daily_z2_load: list[float],
    tau_fast: float = Z2_TAU_FAST_DAYS,
    tau_slow_days=Z2_TAU_SLOW_MIN_DAYS,
    floor_load=0.0,
) -> list[tuple[float, float]]:
    """Per-day (durable_load, sharp_load), both EWMAs over the same daily Z2
    load, seeded at 0 (spec §2).

    - sharp_load: plain fast EWMA, alpha_fast = 1-exp(-1/tau_fast).
    - durable_load: slow EWMA build, with the Newton-cooling floor (spec §2c) as
      a LIMIT on decay, never a replacement for the day's load:

        prev > floor:  durable = max( plain EWMA update,
                                      floor + (prev − floor)·exp(−1/τ_slow) )
        prev ≤ floor:  durable = plain EWMA update

      The max form means the floor bounds how far a day can fall while the day's
      actual load w still counts — a light Z2 session never reads below the pure
      Newton decay NOR below the plain EWMA (algebraically the day's effective
      input is max(w, floor)). Below the floor the plain EWMA applies unmodified,
      so a rest day can never RAISE durable toward an unearned floor.

    tau_slow_days and floor_load are scalars OR per-day sequences (the nightly
    job passes the causal per-day τ_slow(B_t)/floor_t tracks)."""
    n = len(daily_z2_load)
    taus = _per_day(tau_slow_days, n)
    floors = _per_day(floor_load, n)
    alpha_fast = ewma_alpha(tau_fast)

    out: list[tuple[float, float]] = []
    durable = sharp = 0.0
    for i, w in enumerate(daily_z2_load):
        w = float(w)
        sharp += alpha_fast * (w - sharp)

        alpha_slow = ewma_alpha(taus[i])
        decay_slow = math.exp(-1.0 / taus[i])
        prev = durable
        built = prev + alpha_slow * (w - prev)
        if prev > floors[i]:
            # floor LIMITS the fall; the day's load is never discarded.
            durable = max(built, floors[i] + (prev - floors[i]) * decay_slow)
        else:
            durable = built  # at/below floor: plain EWMA — resting earns nothing
        out.append((durable, sharp))
    return out


def durable_calibration_slope(
    floor_d_now: float,
    floor_load_now: float,
    calib_load: float | None = None,
    calib_score: float | None = None,
) -> float:
    """The affine load→score slope (docs v3 pt2/pt5), pinned at today's floor point
    (floor_load → floor_d) and the calibration point (calib_load → calib_score).

    NO CALIBRATION → slope 0: with no elevation signal at all there is NO EVIDENCE
    of height above the earned floor, so D reads the floor track — the honest
    data-thin answer (evidence_state is 'insufficient' there anyway). This replaces
    the old fallback that anchored the user's own peak load to the CEILING, which
    made the most data-thin state produce the most extreme number."""
    if (
        calib_load is not None
        and calib_score is not None
        and (float(calib_load) - float(floor_load_now)) > 1e-9
    ):
        return (float(calib_score) - float(floor_d_now)) / (
            float(calib_load) - float(floor_load_now)
        )
    return 0.0


def durable_base_series(
    durable_load_track: list[float],
    floor_d,
    ceiling: float = ZONE2_DURABLE_CEILING,
    calib_load: float | None = None,
    calib_score: float | None = None,
    floor_load=0.0,
) -> list[float]:
    """v3 pt1 — durable D ∈ [floor_d, ceiling] as a LOAD-DRIVEN, DECAYING series.

    The durable base tracks the load-driven durable_load compartment (which builds
    with Z2 load and decays toward its floor `floor_load` during gaps — see
    z2_durable_sharpness_series); the x-intercept ELEVATION signals only CALIBRATE
    the load→score scale, they do NOT pin D flat. Because D is a strictly
    increasing function of durable_load, and durable_load decays toward floor_load
    during a zero-load stretch, D DECAYS TOWARD floor_d during that stretch — even
    if the elevation inputs are held constant favorable (docs v3 pt1 acceptance).

    Calibration (docs v3 pt2/pt5) is an AFFINE load→score map pinned at two points
    (see durable_calibration_slope; the slope is anchored at TODAY's floor point —
    the calibration signals are a current-state scale):
        floor_load → floor_d     (a fully-detrained load reads the earned floor)
        calib_load → calib_score (the recently-trained smoothed load reads the
                                  elevation-implied height; the caller supplies
                                  calib_load in EWMA units — the max of the
                                  floorless track over the signal window — so the
                                  abscissa is commensurate with the track)

        D(t) = clamp( floor_d(t) + slope·(load(t) − floor_load(t)), floor_d(t), ceiling )

    floor_d and floor_load are scalars OR per-day sequences (causal per-day floors).
    When the load track sits at its floor, D = floor_d exactly — a gap decays D to
    the earned floor. With NO calibration, slope=0 and D IS the floor track."""
    track = [float(x) for x in durable_load_track]
    if not track:
        return []
    n = len(track)
    floors_d = _per_day(floor_d, n)
    floors_load = _per_day(floor_load, n)
    slope = durable_calibration_slope(
        floors_d[-1], floors_load[-1], calib_load=calib_load, calib_score=calib_score
    )
    out: list[float] = []
    for i, load in enumerate(track):
        d = floors_d[i] + slope * (load - floors_load[i])
        out.append(max(floors_d[i], min(ceiling, d)))
    return out


def staleness_inflated_variance(
    variance: float,
    days_since_signal: float,
    tau_days: float = Z2_SIGNAL_STALENESS_TAU_DAYS,
) -> float:
    """Continuous staleness decay of a fusion signal's evidential weight (spec §4c
    / v2: a stale reading yields to load dynamics — the fix for months-old watch
    VO2max co-anchoring the height forever at full weight):

        variance_eff = variance × exp(days_since_signal / τ_staleness)

    Weight (1/variance) halves every τ·ln2 ≈ 31 d. Age clamps at 0 so a reading
    can never gain weight. Continuous in age — no freshness cutoff band."""
    return float(variance) * math.exp(
        max(0.0, float(days_since_signal)) / max(1e-9, tau_days)
    )


def confidence_from_posterior(posterior_sd: float, prior_sd: float) -> float:
    """Confidence ∈ [0,1] as the fractional variance-reduction the signals achieve
    over knowing nothing (docs §6c/§6d — the fused posterior SD drives the band):

        confidence = clamp( 1 − posterior_sd / prior_sd , 0, 1 )

    prior_sd is the SD of total ignorance — a flat prior over [0, C_D], i.e.
    C_D/√12. No signals → posterior = prior → confidence 0. Continuous and
    data-derived; replaces the valid_signals/4 step lookup."""
    if prior_sd <= 0:
        return 0.0
    return max(0.0, min(1.0, 1.0 - float(posterior_sd) / float(prior_sd)))


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
# PROJECTION-DERIVED horizons. decay_onset_days finds the smallest t where the
# projected index falls by a given drop threshold (bisection on the monotone
# projection), so a horizon is a CONTINUOUS function of the current state — never
# a band lookup. It is the shared engine for the maintain horizon (threshold =
# one session's build increment ΔI) and, with fast=0, the v4 durable-erosion
# "eases" horizon (threshold = the confidence band); see durable_erosion_onset_days.
#   F_proj(t) = F·exp(−t/τ_fast)
#   D_proj(t) = floor + (D−floor)·exp(−t/τ_slow(B))
#   I(t)      = D_proj(t) + F_proj(t)
# ---------------------------------------------------------------------------

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


def durable_erosion_onset_days(
    durable: float,
    floor: float,
    tau_slow_days: float,
    band_half_width: float,
    max_days: float = Z2_DECAY_ONSET_MAX_DAYS,
) -> float:
    """v4 "eases" horizon (docs v4 amendment): the smallest t where the projected
    DURABLE BASE has eroded by more than the model's own confidence band —
    D(0) − D_proj(t) ≥ band_half_width, with D_proj the durable-only decay toward
    its floor.

    Two deliberate departures from the v3 decay_onset (which projected the INDEX
    against a tiny SWC):
      1. DURABLE-ONLY. "Zone 2 fitness level" erosion means the banked BASE
         eroding, not the fast/sharpness layer's normal post-session dip. The v3
         index projection fired on the fast layer — so the warning was SHORTEST
         right after training (high F to shed) and blanked out when detrained
         (F≈0). Projecting the durable base removes that inversion.
      2. Threshold = the CONFIDENCE BAND, not SWC. Erosion is only flagged once it
         exceeds what the model can actually resolve, so a thin base (whose entire
         durable range is smaller than its band) yields NO erosion horizon — the
         honest "nothing meaningful to protect yet, just build" state. As the base
         banks and the band tightens, a real horizon emerges.

    Returns max_days when the durable base cannot erode by a full band within the
    horizon (durable − floor < band_half_width, or already at floor); the caller
    maps that to NULL so no calendar marker is drawn."""
    reach = float(durable) - float(floor)
    if reach <= 0 or band_half_width <= 0 or reach < float(band_half_width):
        return max_days  # can never lose a band's-worth → no meaningful erosion
    # durable-only projection: fast=0 makes decay_onset project D alone.
    return decay_onset_days(
        durable=float(durable),
        fast=0.0,
        floor=float(floor),
        tau_slow_days=float(tau_slow_days),
        swc=float(band_half_width),
        tau_fast=Z2_TAU_FAST_DAYS,
        max_days=max_days,
    )


# ---------------------------------------------------------------------------
# v3 pt6 — maintain/build horizons, derived from the model's own projection and
# the user's data. maintain_horizon = decay_onset_days(..., swc=ΔI): the last day
# a single expected session still holds the level. build_interval = the fast-
# decay-limited cadence. Both continuous in the current state.
# ---------------------------------------------------------------------------

def expected_session_stimulus(
    qualifying_day_loads: list[float],
    fallback: float = Z2_MAINTENANCE_SESSION_LOAD,
) -> float:
    """Expected single-session stimulus w̄ (docs v3 pt6): the MEDIAN daily z2-TRIMP
    of qualifying-session DAYS within the caller's trailing τ_slow window — the
    window itself is data-linked (τ_slow(B_t)), so w̄ is what a typical recent
    quality session actually delivered. With NO qualifying session in the window,
    fall back to the maintenance-dose prior (one 20-min true-Z2 session → 40 load
    units, [LITERATURE PRIOR — Hickson dose])."""
    vals = [float(v) for v in qualifying_day_loads if v is not None and float(v) > 0]
    return median(vals) if vals else fallback


def expected_session_build(
    durable_load: float,
    sharp_load: float,
    w_bar: float,
    *,
    slope: float,
    floor_d: float,
    floor_load: float,
    tau_slow_days: float,
    tau_fast: float = Z2_TAU_FAST_DAYS,
    durable_ceiling: float = ZONE2_DURABLE_CEILING,
    fast_ceiling: float = ZONE2_FAST_CEILING,
    fast_sat: float = ZONE2_FAST_SAT,
) -> tuple[float, float]:
    """ΔI (and its fast-only component ΔF) of ONE session-day at w̄ taken FROM THE
    CURRENT STATE (docs v3 pt6): advance both EWMAs one day with w=w̄ vs w=0 using
    the exact series update rules, map each through the score functions, and
    difference. Continuous in every state variable — near fast-saturation a
    session buys less, when detrained it buys more. Returns (ΔI, ΔF)."""
    alpha_fast = ewma_alpha(tau_fast)
    alpha_slow = ewma_alpha(tau_slow_days)
    decay_slow = math.exp(-1.0 / tau_slow_days)

    def advance(w: float) -> tuple[float, float]:
        sharp = sharp_load + alpha_fast * (w - sharp_load)
        built = durable_load + alpha_slow * (w - durable_load)
        if durable_load > floor_load:  # same max floor-limit rule as the series
            built = max(built, floor_load + (durable_load - floor_load) * decay_slow)
        d = max(floor_d, min(durable_ceiling, floor_d + slope * (built - floor_load)))
        f = fast_score_from_load(sharp, fast_ceiling=fast_ceiling, fast_sat=fast_sat)
        return d + f, f

    i_session, f_session = advance(float(w_bar))
    i_rest, f_rest = advance(0.0)
    return i_session - i_rest, f_session - f_rest


def build_cadence_days(
    b: float,
    freq_beginner: float = Z2_BUILD_FREQ_BEGINNER,
    freq_slope: float = Z2_BUILD_FREQ_SLOPE,
    floor_days: float = Z2_BUILD_INTERVAL_FLOOR_DAYS,
) -> float:
    """v4 build cadence (days between building sessions) as a CONTINUOUS function
    of base-consolidation B (docs v4 amendment; replaces the v3 min(fast-decay,
    2.0) whose 2.0 cap always bound for a detrained user):

        sessions_per_week(B) = freq_beginner + freq_slope · clamp(B,0,1)
        cadence_days         = max(floor_days, 7 / sessions_per_week)

    B=0 (novice) → 7/3 ≈ 2.33 d (the ACSM ~3×/wk VO2max-gain dose); B=1
    (consolidated) → 7/5.5 ≈ 1.27 d (well-trained need MORE frequency to keep
    improving). Floored at the ~24 h molecular re-stimulation window. Monotone
    DECREASING in B, continuous, no hardcoded interval — the only constants are
    the marked literature priors (frequencies + the 24 h floor)."""
    bc = max(0.0, min(1.0, float(b)))
    per_week = freq_beginner + freq_slope * bc
    if per_week <= 0:
        return floor_days
    return max(floor_days, 7.0 / per_week)


ZONE2_MAINTENANCE_MESSAGE = (
    "You're below the dose that holds your level. Two Zone-2 sessions at target "
    "intensity in the next few days keeps it. Miss that and your sharpness fades "
    "first; your durable base erodes more slowly."
)


def zone2_maintenance_flag(
    maintenance_met: bool,
    consecutive_unmet_days: int,
    warn_after_days: float,
    sharpness: float,
    durable_base: float,
    hold_active: bool,
    fast_ceiling: float = ZONE2_FAST_CEILING,
    durable_ceiling: float = ZONE2_DURABLE_CEILING,
) -> list[dict]:
    """The zone2_maintenance firing rule (spec §5c). Fires severity 'info' iff
    ALL hold: maintenance unmet for the warn window's worth of consecutive days
    AND form is fading faster than the base AND NOT suppressed by an active
    injury/plan hold. Never red, never single-reading.

    "Form fading below the base" compares NORMALIZED shares, F/C_F < D/C_D — the
    raw F < D comparison put F∈[0,30] against D∈[0,70], tautologically true
    whenever D > 30 regardless of form. The shares put both pools on their own
    saturation scale, which is the relationship §5c actually means.

    warn_after_days is the CONTINUOUS projection-derived decay-onset horizon; the
    firing threshold is max(1, round(warn_after_days)) unmet DAYS so even a
    sub-day horizon still demands one full unmet day of persistence."""
    threshold = max(1, round(float(warn_after_days)))
    fast_share = sharpness / fast_ceiling if fast_ceiling > 0 else 0.0
    durable_share = durable_base / durable_ceiling if durable_ceiling > 0 else 0.0
    fires = (
        not maintenance_met
        and consecutive_unmet_days >= threshold
        and fast_share < durable_share
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
