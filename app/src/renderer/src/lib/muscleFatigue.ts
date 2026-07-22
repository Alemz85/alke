// Muscle Load & Fatigue model — pure functions (docs/muscle-fatigue-model.md).
//
// For each of the 6 anatomical groups (expandable to 20 individual muscles),
// a Fatigue score in [0,1] modeling how recovered that muscle is RIGHT NOW. It
// is a per-muscle acute÷chronic impulse-response: every session (lifting AND
// cardio) deposits a load impulse into each muscle it works; the impulse decays
// with a recovery time-constant; the acute total is read relative to that
// muscle's chronic capacity ("how used to the load you are"). Lifting is first
// converted into personal hard-set equivalents, so a handful of normal sets is
// not mistaken for extreme fatigue just because it uses more kilograms.
//
// DYNAMIC, not hardcoded: relIntensity is measured against the user's own 30-day
// norm; cap_m and tau_rec scale with the user's own capacity and aerobic base.
// The only irreducible priors (k_cardio, tau0) are isolated in
// MUSCLE_FATIGUE_PARAMS and marked. No DB schema, no nightly job — every input
// is client-side, so this runs app-side in real time.
//
// No window.api / DOM access here: everything takes explicit data so it is
// unit-testable in isolation (mirrors lib/gymLog.ts, lib/zone2Fitness.ts).

import type { Exercise, GymSession, GymSet, Workout } from '@shared/types'
import { cardioModalityOf, type CardioModalityKey } from './cardioModality'
import { addDays, isoWeekKey, localDateKey, toZonedYMD, type YMD, ymdKey } from '../hooks/sessionsDate'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MuscleFatigueInput {
  sessions: GymSession[] // logged gym sessions with sets, ~last 90d
  workouts: Workout[] // cardio workouts ~last 90d (uses computed.time_in_zones + computed.trimp + type)
  exercisesById: Map<string, Exercise>
  aerobicBase: number | null // Zone2 durable base 0-100 for recovery modulation; null = skip that term
  timezone: string | null
  asOf: Date
  // Dated body-mass readings (kg), newest or oldest order irrelevant. Used to
  // resolve the effective load of bodyweight-BEARING exercises per session date
  // (body mass as of that day + any added weight). Omitted/empty → the model
  // falls back to bodyWeightFallbackKg. Each session uses the most recent reading
  // on or before its date, so past sessions use the weight the user actually was.
  bodyWeightSeries?: { date: string; weightKg: number }[]
}

export type MuscleGroup = 'chest' | 'back' | 'shoulders' | 'arms' | 'legs' | 'core'

export interface MuscleDetail {
  muscle: string
  fatigue: number
  weekSets: number
  lowData: boolean
}

export interface GroupFatigue {
  group: MuscleGroup
  fatigue: number
  lowData: boolean
  volumeWeekSets: number
  volumeMonthSets: number
  volumePrevWeekSets: number
  muscles: MuscleDetail[]
}

export interface MuscleFatigueResult {
  groups: GroupFatigue[]
}

// ---------------------------------------------------------------------------
// Muscle vocabulary (the 20-muscle vocab enforced by the gym_exercise_catalog
// CHECK constraint; primary/secondary values come from this set).
// ---------------------------------------------------------------------------

export const MUSCLES = [
  'chest',
  'lats',
  'upper back',
  'traps',
  'lower back',
  'front delts',
  'side delts',
  'rear delts',
  'biceps',
  'triceps',
  'forearms',
  'quadriceps',
  'hamstrings',
  'glutes',
  'calves',
  'tibialis',
  'adductors',
  'abductors',
  'hip flexors',
  'abs',
  'obliques'
] as const
export type Muscle = (typeof MUSCLES)[number]

// ---------------------------------------------------------------------------
// §4 muscle → group rollup map. A few muscles split across two groups
// (fractional membership). The 6 anatomical groups only — a "full body"-tagged
// exercise distributes via its own primary/secondary muscles into these six.
// ---------------------------------------------------------------------------

export const GROUP_MEMBERSHIP: Record<MuscleGroup, Partial<Record<Muscle, number>>> = {
  chest: { chest: 1.0 },
  back: { lats: 1.0, 'upper back': 1.0, 'lower back': 0.6, traps: 0.5, 'rear delts': 0.4 },
  shoulders: { 'front delts': 1.0, 'side delts': 1.0, 'rear delts': 0.6, traps: 0.5 },
  arms: { biceps: 1.0, triceps: 1.0, forearms: 1.0 },
  legs: {
    quadriceps: 1.0,
    hamstrings: 1.0,
    glutes: 1.0,
    calves: 1.0,
    tibialis: 1.0,
    adductors: 1.0,
    abductors: 1.0
  },
  core: { abs: 1.0, obliques: 1.0, 'hip flexors': 1.0, 'lower back': 0.4 }
}

export const MUSCLE_GROUPS: MuscleGroup[] = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core']

// ---------------------------------------------------------------------------
// §5 constants — grounded tables + marked priors, one source of truth.
// ---------------------------------------------------------------------------

export const MUSCLE_FATIGUE_PARAMS = {
  // --- lifting stimulus ---
  primaryShare: 1.0, // grounded (existing app convention, matches muscleSetVolume)
  secondaryShare: 0.5, // grounded
  // BW_PROXY: nominal load (kg-equivalent) for a null-weight set on an
  // EXTERNAL-load exercise (e.g. a machine set whose stack weight went
  // unrecorded) — the load is genuinely unknown, so a neutral proxy stands in.
  // Bodyweight-BEARING exercises (equipment='bodyweight') do NOT use this: their
  // effective load is the user's own body mass + any added weight (see setLoad).
  bwProxy: 40, // tuning
  // Population fallback body mass (kg), used ONLY to resolve the effective load
  // of a bodyweight-bearing set when the user has no dated body-mass reading at
  // all. The user's own dated series is used per session date whenever present,
  // so this rarely bites. MARKED PRIOR (neutral adult mass; magnitude cancels in
  // the per-exercise self-normalization, only monotonicity in added weight matters).
  bodyWeightFallbackKg: 70,
  kappaH: 0.5, // hardness slope above r0 — tuning
  r0: 1.0, // relIntensity threshold where hardness kicks in — tuning
  refPercentile: 0.9, // ref30 = 90th-pctile working weight over trailing 30 d
  referenceSetReps: 10, // normalizes lifting into 10-rep hard-set equivalents
  // MARKED PRIOR: conservative added cost for an explicitly eccentric working
  // set. Applied only to its final fatigue stimulus, never descriptive volume
  // or the exercise's relative-load histories; personalizable after calibration.
  eccentricStimulusMultiplier: 1.25,

  // --- cardio stimulus ---
  // MARKED PRIOR: no literature scalar. Conservative start so cardio deposits
  // LESS muscle fatigue than lifting per unit; personalizable.
  kCardio: 0.15,
  // GROUNDED (EIMD eccentric>concentric; Wilson 2012 run>cycle interference).
  // Keyed by CardioModalityKey (cardioModalityOf) — 'swim' is the app's key for
  // the spec table's "swimming".
  mech: {
    running: 1.0,
    rowing: 0.6,
    elliptical: 0.4,
    cycling: 0.35,
    swim: 0.3,
    walking: 0.2
  } as Record<CardioModalityKey, number>,
  // GROUNDED (EMG recruitment); each modality's row sums to ~1 across its muscles.
  spill: {
    swim: {
      lats: 0.25,
      'upper back': 0.15,
      'front delts': 0.1,
      'side delts': 0.08,
      'rear delts': 0.07,
      triceps: 0.1,
      biceps: 0.05,
      abs: 0.12,
      obliques: 0.08
    },
    running: { quadriceps: 0.3, hamstrings: 0.2, calves: 0.2, glutes: 0.15, abs: 0.15 },
    cycling: { quadriceps: 0.55, glutes: 0.25, hamstrings: 0.1, calves: 0.1 },
    rowing: {
      quadriceps: 0.2,
      glutes: 0.15,
      lats: 0.2,
      'upper back': 0.15,
      'lower back': 0.1,
      biceps: 0.1,
      abs: 0.1
    },
    elliptical: { quadriceps: 0.35, glutes: 0.25, hamstrings: 0.2, calves: 0.15, 'front delts': 0.05 },
    walking: { calves: 0.4, quadriceps: 0.3, glutes: 0.2, hamstrings: 0.1 }
  } as Record<CardioModalityKey, Partial<Record<Muscle, number>>>,

  // --- compartments (§3) ---
  // MARKED PRIOR: base per-muscle recovery time-constant ≈ 2.5 d.
  tau0Days: 2.5,
  tauRecFloorDays: 1.0, // physiological minimum tau_rec never drops below
  tauCapDays: 35, // "training status" window (mirrors the CTL τ family)
  // Neutral cold-start capacity in hard-set equivalents. A six-set chest week
  // is a normal dose even before the app has enough history to infer capacity.
  baselineCapacitySetEquivalents: 6,
  kappaScale: 2, // acute-vs-capacity scale in the fatigue squash — tuning
  epsilon: 1e-6, // guards fatigue when capacity ~0
  // g(cap, aerobicBase): fitter/more-conditioned ⇒ faster clearance (shorter tau).
  capRecoveryGain: 0.0025, // how much accumulated capacity shortens tau (direction grounded, magnitude marked)
  aerobicRecoveryGain: 0.35, // max fractional tau reduction at aerobicBase=100 (direction grounded)
  // f_muscle: larger muscles recover slower. Default 1.0 for any muscle unlisted.
  muscleSizeFactor: {
    quadriceps: 1.3,
    hamstrings: 1.3,
    glutes: 1.3,
    'lower back': 1.2,
    lats: 1.2,
    'upper back': 1.15,
    chest: 1.1,
    traps: 1.05,
    adductors: 1.1,
    abductors: 1.0,
    calves: 1.0,
    tibialis: 0.8, // small distal dorsiflexor — recovers fast, like forearms
    abs: 0.9,
    obliques: 0.9,
    'hip flexors': 0.9,
    'front delts': 0.85,
    'side delts': 0.85,
    'rear delts': 0.85,
    biceps: 0.85,
    triceps: 0.9,
    forearms: 0.8
  } as Partial<Record<Muscle, number>>,

  // --- windowing ---
  windowDays: 75, // trailing daily axis long enough for acute to converge (≥60 d)
  refWindowDays: 30, // trailing window for ref30
  // A muscle counts as having real history (clears the low-data flag) once its
  // total deposited stimulus over the window exceeds this floor.
  lowDataStimulusFloor: 1e-6,

  // --- exercise load coefficient (§ new: intrinsic systemic cost per set) ---
  // Two sets are not created equal: an all-out barbell squat taxes the whole
  // body far harder than a resisted-band dorsiflexion of the same set-count.
  // The coefficient scales each set's deposited stimulus by the exercise's
  // INTRINSIC systemic cost, read from catalog metadata the exercises table
  // already carries (equipment + mechanics + movement_pattern) — NOT hand-tagged
  // per exercise. It is a heuristic; every tier's rationale is stated below.
  //
  // Design: coeff = clamp(equipmentTier × mechanicsMult × patternMult, floor, 1.0),
  // then an optional per-name_key override wins outright. The three axes multiply
  // because they capture independent things: equipment ≈ how much external load /
  // stabilization the tool allows, mechanics ≈ how many joints/muscles share the
  // work, pattern ≈ whether it is a big structural lift or an accessory.
  loadCoeff: {
    // Neutral default when metadata is missing entirely (custom exercises with no
    // equipment/mechanics/pattern — e.g. a custom band exercise whose rows
    // carry blank metadata). A middle-of-the-road accessory coefficient: we refuse
    // to guess it is either a max-effort compound or a trivial rehab drill.
    defaultCoeff: 0.55,
    floor: 0.25, // a set never contributes less than a quarter of a reference set
    ceil: 1.0, // reference = a heavy barbell/loaded compound (squat/deadlift class)

    // Equipment tier — the primary axis. Ordered by how much systemic load the
    // tool lets you move and how much stabilization it demands.
    //   barbell/trap bar : full external load, free stabilization      → 1.0 (reference)
    //   smith machine    : barbell load but guided bar, less stabilizer → 0.9
    //   ez bar           : loaded but curl/extension accessory class    → 0.75
    //   dumbbell/kettlebell: real load, per-limb, usually accessory     → 0.7
    //   machine          : loaded but seated/supported, isolating       → 0.6
    //   cable            : constant-tension isolation, light systemic   → 0.5
    //   bodyweight       : bounded by own mass, no external load        → 0.5
    //   band             : lightest resistance, rehab/activation class  → 0.3
    //   other/blank      : unknown → treated as the accessory default   → 0.55
    equipmentTier: {
      barbell: 1.0,
      'trap bar': 1.0,
      'smith machine': 0.9,
      'ez bar': 0.75,
      dumbbell: 0.7,
      kettlebell: 0.7,
      machine: 0.6,
      cable: 0.5,
      bodyweight: 0.5,
      band: 0.3,
      other: 0.55
    } as Record<string, number>,

    // Mechanics multiplier — compound movements recruit more muscle and cost more
    // systemically than isolation at the same equipment. A light nudge, not a
    // second full axis, so it does not swamp the equipment tier.
    mechanicsMult: {
      compound: 1.0,
      isolation: 0.85
    } as Record<string, number>,

    // Movement-pattern multiplier — the biggest structural lifts (squat/hinge)
    // carry a small premium; dedicated isolation/accessory patterns a small
    // discount. Neutral (1.0) for everything not listed so the axis only speaks
    // where it clearly should.
    patternMult: {
      squat: 1.1,
      hinge: 1.1,
      lunge: 1.0,
      'horizontal push': 1.0,
      'vertical push': 1.0,
      'horizontal pull': 1.0,
      'vertical pull': 1.0,
      carry: 1.0,
      rotation: 0.95,
      core: 0.9,
      isolation: 0.85
    } as Record<string, number>,

    // Per-exercise overrides by name_key (lowercased exercise name — the DB's
    // name_key convention). Escape hatch for exceptions the metadata mapping gets
    // wrong; empty by default so the principled mapping governs unless a real
    // outlier is found. Example (commented, not active): a trap-bar deadlift that
    // should read as a pure max-effort compound regardless of tier quirks.
    //   'trap bar deadlift': 1.0,
    coeffOverride: {} as Record<string, number>
  },

  // --- relative-intensity factor (§ new: this set vs the user's own recent norm)
  // Distinct from loadCoeff: the coefficient is the exercise's fixed intrinsic
  // cost; the intensity factor is how HARD this particular set was relative to
  // what the user usually lifts for THAT exercise. Lifting above your recent
  // working norm fatigues more; well below it (deload / recovery day) less.
  //
  // factor = clamp(load / recentMedian, min, max). This is deliberately a
  // DIFFERENT reference than ref30/hardness above: ref30 uses a 90th-percentile
  // over 30d to detect a genuinely heavy TOP set (hardness term); this uses the
  // trailing-28d MEDIAN working weight to detect whether the whole set sits above
  // or below the user's typical working load. They measure different things (peak
  // vs central tendency) and both feed the same sigma multiplicatively — the
  // hardness term rewards a heavy outlier set, the intensity factor scales the
  // ordinary set by where it sits in the user's normal range.
  relIntensity: {
    windowDays: 28, // trailing window for the personal working-weight median
    min: 0.6, // a set well below the norm still costs at least 60% (bounded)
    max: 1.4, // a set well above the norm costs at most 140% (bounded)
    // Need at least this many prior non-warmup sets of the exercise in-window to
    // trust the median. Below it → neutral 1.0 (first exposures don't get skewed).
    minHistorySets: 4
  }
} as const

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

export interface FatigueStatus {
  label: 'fresh' | 'ready' | 'loaded' | 'fatigued' | 'low data'
  percent: number | null
}

/** Plain-language bands for the recovery estimate shown in the Gym UI. */
export function fatigueStatus(fatigue: number, lowData: boolean): FatigueStatus {
  if (lowData) return { label: 'low data', percent: null }
  const value = clamp01(fatigue)
  // Floor rather than round so a 19.8% fresh reading never displays as "fresh 20%"
  // right beside a 20% threshold for the next band.
  const percent = Math.floor(value * 100)
  if (value < 0.2) return { label: 'fresh', percent }
  if (value < 0.4) return { label: 'ready', percent }
  if (value < 0.65) return { label: 'loaded', percent }
  return { label: 'fatigued', percent }
}

/** Percentile of a numeric array (linear interpolation), or null when empty. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const idx = p * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const frac = idx - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

/**
 * True when an exercise is bodyweight-BEARING — the body itself is the primary
 * resistance (pull-ups, dips, push-ups, air squats, lunges, calf raises, heel
 * walks…). Signal: the catalog `equipment='bodyweight'` tag the exercises table
 * already carries — NOT a hardcoded name list. For these, a logged weight_kg is
 * ADDED external load (a weight belt / dumbbells) on top of the body, and null =
 * pure bodyweight. Everything else treats weight_kg as the whole load.
 */
export function isBodyweightBearing(ex: Exercise | undefined): boolean {
  return ex?.equipment?.trim().toLowerCase() === 'bodyweight'
}

/**
 * Effective mechanical load of a set (kg-equivalent):
 *  - Bodyweight-bearing exercise: bodyWeightKg + (weight_kg ?? 0). This is what
 *    makes a weighted heel-walk / dip / calf-raise read as MORE load than the
 *    same movement unloaded, and a pure-bodyweight set count its own body mass
 *    rather than a flat proxy.
 *  - Everything else: weight_kg, or BW_PROXY when null (unrecorded external load).
 * The bodyweight "fraction loaded" is deliberately 1.0 (no per-exercise
 * biomechanical guess): each exercise is self-normalized against its own recent
 * norm downstream (ref30, intensity median), so only monotonicity in the added
 * weight matters, not the absolute magnitude — inventing per-movement fractions
 * would be unfounded hardcoding.
 */
function setLoad(s: GymSet, ex: Exercise | undefined, bodyWeightKg: number): number {
  if (isBodyweightBearing(ex)) return bodyWeightKg + (s.weight_kg ?? 0)
  return s.weight_kg == null ? MUSCLE_FATIGUE_PARAMS.bwProxy : s.weight_kg
}

/**
 * Body mass (kg) to use for a session on `dayKey` (a "YYYY-MM-DD" local date):
 * the most recent valid reading on or before that day; failing that, the
 * earliest reading available; failing that, the population fallback. Carrying
 * the last known weight forward keeps each past session on the mass the user
 * actually was then, so the retroactive recompute is date-correct rather than
 * pinned to today's weight.
 */
function resolveBodyWeight(series: { date: string; weightKg: number }[] | undefined, dayKey: string): number {
  const fallback = MUSCLE_FATIGUE_PARAMS.bodyWeightFallbackKg
  if (!series || series.length === 0) return fallback
  let onOrBefore: { date: string; weightKg: number } | null = null
  let earliest: { date: string; weightKg: number } | null = null
  for (const r of series) {
    if (!Number.isFinite(r.weightKg) || r.weightKg <= 0) continue
    if (!earliest || r.date < earliest.date) earliest = r
    if (r.date <= dayKey && (!onOrBefore || r.date > onOrBefore.date)) onOrBefore = r
  }
  return (onOrBefore ?? earliest)?.weightKg ?? fallback
}

/** Median of a numeric array, or null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Exercise load coefficient in [floor, ceil]: the exercise's INTRINSIC systemic
 * cost per set, derived from catalog metadata (equipment × mechanics × pattern),
 * not hand-tagged. Degrades to a neutral middle default when metadata is missing.
 * A per-name_key override (keyed on lowercased name, the DB name_key convention)
 * wins outright when present. See MUSCLE_FATIGUE_PARAMS.loadCoeff for the tiers
 * and the rationale behind every value.
 */
export function exerciseLoadCoefficient(ex: Exercise): number {
  const L = MUSCLE_FATIGUE_PARAMS.loadCoeff

  // Override hook: name_key = lowercased exercise name (matches the DB's name_key).
  const key = ex.name.trim().toLowerCase()
  const override = L.coeffOverride[key]
  if (override != null && Number.isFinite(override)) return override

  const equip = ex.equipment?.trim().toLowerCase() || null
  const mech = ex.mechanics?.trim().toLowerCase() || null
  const pattern = ex.movement_pattern?.trim().toLowerCase() || null

  // No usable metadata at all → honest neutral default (don't guess heavy or light).
  if (!equip && !mech && !pattern) return L.defaultCoeff

  // Equipment is the primary axis; unknown/blank equipment falls to the default
  // tier rather than a compound reference.
  const equipTier: number = (equip ? L.equipmentTier[equip] : undefined) ?? L.defaultCoeff
  const mechMult: number = (mech ? L.mechanicsMult[mech] : undefined) ?? 1
  const patternMult: number = (pattern ? L.patternMult[pattern] : undefined) ?? 1

  const raw = equipTier * mechMult * patternMult
  return Math.min(L.ceil, Math.max(L.floor, raw))
}

/**
 * Relative-intensity factor in [min, max]: this set's load versus the user's own
 * trailing-window MEDIAN working weight for the SAME exercise (excluding the
 * current session). Above the personal norm → >1 (fatigues more); below → <1.
 * Neutral 1.0 when: the set carries no logged weight (bodyweight/band), there is
 * no in-window history, or the history is thinner than minHistorySets. Distinct
 * from the hardness term (see loadCoeff/relIntensity comments) — this scales the
 * ordinary set by where its weight sits in the user's normal range, so it must
 * not double-count the exercise's intrinsic cost (that is loadCoeff's job).
 */
export function relIntensityFactor(
  set: GymSet,
  priorLoads: number[] // in-window non-warmup loads for this exercise, current session excluded
): number {
  const R = MUSCLE_FATIGUE_PARAMS.relIntensity
  // No actual weight on the set → the ratio is meaningless; stay neutral. (A
  // bodyweight/band set's cost is already handled by loadCoeff + hard-set volume.)
  if (set.weight_kg == null) return 1
  if (priorLoads.length < R.minHistorySets) return 1
  const norm = median(priorLoads)
  if (norm == null || norm <= 0) return 1
  const ratio = set.weight_kg / norm
  return Math.min(R.max, Math.max(R.min, ratio))
}

// ---------------------------------------------------------------------------
// Per-day per-muscle stimulus s_m(d) = liftStim + cardioStim  (§2)
// ---------------------------------------------------------------------------

/**
 * ref30: the 90th-percentile working weight for an exercise over the trailing
 * refWindowDays before `dayKey`, given that exercise's dated loads. Excluding
 * the current day lets a genuinely heavier session register as harder instead
 * of letting its own top set redefine the reference. With no prior history the
 * caller falls back to the set's own load. Loads are effective loads from
 * setLoad (bodyweight-bearing sets already include body mass; unrecorded
 * external-load sets use BW_PROXY).
 */
function buildRef30(sets: { dayKey: string; load: number }[], dayKey: string): number | null {
  const cutoff = ymdKey(addDays(keyToYMD(dayKey), -MUSCLE_FATIGUE_PARAMS.refWindowDays))
  const window = sets.filter((s) => s.dayKey < dayKey && s.dayKey > cutoff).map((s) => s.load)
  return percentile(window, MUSCLE_FATIGUE_PARAMS.refPercentile)
}

function keyToYMD(key: string): YMD {
  const [y, m, d] = key.split('-').map(Number)
  return { year: y, month: m, day: d }
}

interface DayStim {
  // per-muscle stimulus deposited on this local date
  perMuscle: Map<Muscle, number>
}

/**
 * Build the per-day, per-muscle stimulus map over the trailing window.
 * Returns a Map keyed by "YYYY-MM-DD" local date. Also returns the set of
 * muscles that ever received any stimulus (for the low-data flag).
 */
function buildDailyStimulus(input: MuscleFatigueInput): {
  byDay: Map<string, DayStim>
  everStimulated: Map<Muscle, number> // muscle -> total stimulus over window
} {
  const { sessions, workouts, exercisesById, timezone } = input
  const P = MUSCLE_FATIGUE_PARAMS
  const byDay = new Map<string, DayStim>()
  const everStimulated = new Map<Muscle, number>()

  const deposit = (dayKey: string, muscle: Muscle, amount: number): void => {
    if (amount <= 0) return
    let day = byDay.get(dayKey)
    if (!day) {
      day = { perMuscle: new Map() }
      byDay.set(dayKey, day)
    }
    day.perMuscle.set(muscle, (day.perMuscle.get(muscle) ?? 0) + amount)
    everStimulated.set(muscle, (everStimulated.get(muscle) ?? 0) + amount)
  }

  // --- lifting stimulus ---
  // First, collect per-exercise working-set loads keyed by day, to compute ref30
  // (hardness) and the relative-intensity median. `load` is the EFFECTIVE load
  // from setLoad (body mass + added for bodyweight-bearing; BW_PROXY for
  // unrecorded external load) — needed by ref30; `weightKg` keeps the raw logged
  // added weight so the intensity median only reflects genuinely-loaded sets.
  const exerciseLoads = new Map<string, { dayKey: string; load: number }[]>()
  const exerciseWeights = new Map<string, { dayKey: string; weightKg: number }[]>()
  for (const sess of sessions) {
    const dayKey = localDateKey(sess.performed_at, timezone)
    const bodyWeight = resolveBodyWeight(input.bodyWeightSeries, dayKey)
    for (const set of sess.sets) {
      if (set.is_warmup) continue
      const arr = exerciseLoads.get(set.exercise_id) ?? []
      arr.push({ dayKey, load: setLoad(set, exercisesById.get(set.exercise_id), bodyWeight) })
      exerciseLoads.set(set.exercise_id, arr)
      if (set.weight_kg != null) {
        const warr = exerciseWeights.get(set.exercise_id) ?? []
        warr.push({ dayKey, weightKg: set.weight_kg })
        exerciseWeights.set(set.exercise_id, warr)
      }
    }
  }

  for (const sess of sessions) {
    const dayKey = localDateKey(sess.performed_at, timezone)
    const bodyWeight = resolveBodyWeight(input.bodyWeightSeries, dayKey)
    for (const set of sess.sets) {
      if (set.is_warmup) continue
      const ex = exercisesById.get(set.exercise_id)
      if (!ex) continue // custom without muscle metadata -> honest gap, no guess
      const reps = set.reps ?? 0
      if (reps <= 0) continue
      const load = setLoad(set, ex, bodyWeight)

      // relIntensity = load / ref30 (this set's weight vs the user's recent norm).
      const ref = buildRef30(exerciseLoads.get(set.exercise_id) ?? [], dayKey)
      const referenceLoad = ref && ref > 0 ? ref : load
      const relIntensity = load / referenceLoad
      const hardness = 1 + P.kappaH * Math.max(0, relIntensity - P.r0)
      // One standard working set is roughly 10 reps at the user's own recent
      // working load. This preserves extra fatigue from unusually heavy sets,
      // while avoiding raw kilogram volume as the recovery unit.
      const hardSetEquivalent = (reps * load) / (P.referenceSetReps * referenceLoad)

      // Exercise load coefficient: the exercise's intrinsic systemic cost per set
      // (barbell compound ≈ 1.0, band rehab ≈ 0.3), from catalog metadata.
      const loadCoeff = exerciseLoadCoefficient(ex)

      // Relative-intensity factor: this set's weight vs the user's own trailing-
      // 28d median working weight for the SAME exercise (current session excluded).
      // Distinct from `hardness` (peak-based) — this centers on the personal norm.
      const cutoff = ymdKey(addDays(keyToYMD(dayKey), -P.relIntensity.windowDays))
      const priorLoads = (exerciseWeights.get(set.exercise_id) ?? [])
        .filter((w) => w.dayKey < dayKey && w.dayKey > cutoff)
        .map((w) => w.weightKg)
      const intensityFactor = relIntensityFactor(set, priorLoads)

      // Eccentric work gets a conservative final-stimulus multiplier. It is
      // deliberately applied after reference/history calculations, leaving
      // ref30, relative intensity, and descriptive set counts unchanged.
      const sigma =
        hardSetEquivalent *
        hardness *
        loadCoeff *
        intensityFactor *
        (set.is_eccentric ? P.eccentricStimulusMultiplier : 1)

      for (const m of ex.primary_muscles) {
        if ((MUSCLES as readonly string[]).includes(m)) deposit(dayKey, m as Muscle, sigma * P.primaryShare)
      }
      for (const m of ex.secondary_muscles) {
        if ((MUSCLES as readonly string[]).includes(m)) deposit(dayKey, m as Muscle, sigma * P.secondaryShare)
      }
    }
  }

  // --- cardio stimulus ---
  for (const w of workouts) {
    const modality = cardioModalityOf(w.type)
    if (!modality) continue // strength/core/other -> not cardio, no deposit
    const trimp = w.computed?.trimp
    if (trimp == null || !Number.isFinite(trimp) || trimp <= 0) continue
    const dayKey = localDateKey(w.start_at, timezone)
    const mech = P.mech[modality] ?? 0
    const spill = P.spill[modality] ?? {}
    for (const [m, frac] of Object.entries(spill) as [Muscle, number][]) {
      const amount = trimp * P.kCardio * mech * frac
      deposit(dayKey, m, amount)
    }
  }

  return { byDay, everStimulated }
}

// ---------------------------------------------------------------------------
// §3 compartments: leaky-integrator acute + slow-EWMA capacity → fatigue
// ---------------------------------------------------------------------------

interface MuscleState {
  acute: number
  cap: number
  fatigue: number
  totalStim: number
}

/**
 * Run the daily recurrences for every muscle over the trailing window ending at
 * asOf's local date. Rest days deposit s_m = 0. Seeded at 0.
 */
function runCompartments(input: MuscleFatigueInput): Map<Muscle, MuscleState> {
  const P = MUSCLE_FATIGUE_PARAMS
  const { byDay, everStimulated } = buildDailyStimulus(input)

  const endYMD = toZonedYMD(input.asOf.toISOString(), input.timezone)
  const startYMD = addDays(endYMD, -(P.windowDays - 1))

  // Enumerate the daily axis start..end inclusive.
  const dayKeys: string[] = []
  let cursor = startYMD
  const endKey = ymdKey(endYMD)
  for (let i = 0; i < P.windowDays + 2; i++) {
    const k = ymdKey(cursor)
    dayKeys.push(k)
    if (k === endKey) break
    cursor = addDays(cursor, 1)
  }

  const alphaCap = 1 - Math.exp(-1 / P.tauCapDays)
  const aerobicBase = input.aerobicBase

  const states = new Map<Muscle, MuscleState>()
  for (const m of MUSCLES) {
    let acute = 0
    let cap = 0
    let fatigue = 0
    const fMuscle = P.muscleSizeFactor[m] ?? 1

    for (const dk of dayKeys) {
      const s = byDay.get(dk)?.perMuscle.get(m) ?? 0

      // tau_rec_m(d) = tau0 * f_muscle(size) * g(cap, aerobicBase), floored.
      // g shortens tau as capacity AND aerobic base rise. Uses the running cap
      // (state entering the day) so it is a function of the user's own data.
      const capTerm = 1 / (1 + P.capRecoveryGain * cap)
      const aerobicTerm =
        aerobicBase == null
          ? 1
          : 1 - P.aerobicRecoveryGain * clamp01(aerobicBase / 100)
      const tauRec = Math.max(P.tauRecFloorDays, P.tau0Days * fMuscle * capTerm * aerobicTerm)

      acute = acute * Math.exp(-1 / tauRec) + s
      cap = cap + alphaCap * (s - cap)
      // cap begins at zero; without the neutral floor the first few logged
      // sets saturate to ~100% fatigue. Personal capacity takes over once the
      // long-term EWMA grows beyond this reasonable unobserved baseline.
      const capacityForFatigue = Math.max(cap, P.baselineCapacitySetEquivalents)
      fatigue = 1 - Math.exp(-acute / (capacityForFatigue * P.kappaScale + P.epsilon))
    }

    states.set(m, {
      acute,
      cap,
      fatigue: clamp01(fatigue),
      totalStim: everStimulated.get(m) ?? 0
    })
  }
  return states
}

// ---------------------------------------------------------------------------
// Volume windows (weekly = current ISO week, monthly = calendar MTD, prev week)
// ---------------------------------------------------------------------------

interface VolumeWindows {
  week: Map<Muscle, number>
  prevWeek: Map<Muscle, number>
  month: Map<Muscle, number>
}

function buildVolumeWindows(input: MuscleFatigueInput): VolumeWindows {
  const { sessions, exercisesById, timezone, asOf } = input
  const P = MUSCLE_FATIGUE_PARAMS

  const asOfYMD = toZonedYMD(asOf.toISOString(), timezone)
  const thisWeekKey = isoWeekKey(asOfYMD)
  const prevWeekKey = isoWeekKey(addDays(asOfYMD, -7))

  const week = new Map<Muscle, number>()
  const prevWeek = new Map<Muscle, number>()
  const month = new Map<Muscle, number>()

  const add = (map: Map<Muscle, number>, m: Muscle, amt: number): void => {
    map.set(m, (map.get(m) ?? 0) + amt)
  }

  for (const sess of sessions) {
    const ymd = toZonedYMD(sess.performed_at, timezone)
    const wk = isoWeekKey(ymd)
    const inThisWeek = wk === thisWeekKey
    const inPrevWeek = wk === prevWeekKey
    const inMonth = ymd.year === asOfYMD.year && ymd.month === asOfYMD.month && ymd.day <= asOfYMD.day

    if (!inThisWeek && !inPrevWeek && !inMonth) continue

    for (const set of sess.sets) {
      if (set.is_warmup) continue
      const ex = exercisesById.get(set.exercise_id)
      if (!ex) continue
      const contribs: [Muscle, number][] = []
      for (const m of ex.primary_muscles) {
        if ((MUSCLES as readonly string[]).includes(m)) contribs.push([m as Muscle, P.primaryShare])
      }
      for (const m of ex.secondary_muscles) {
        if ((MUSCLES as readonly string[]).includes(m)) contribs.push([m as Muscle, P.secondaryShare])
      }
      for (const [m, amt] of contribs) {
        if (inThisWeek) add(week, m, amt)
        if (inPrevWeek) add(prevWeek, m, amt)
        if (inMonth) add(month, m, amt)
      }
    }
  }
  return { week, prevWeek, month }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function computeMuscleFatigue(input: MuscleFatigueInput): MuscleFatigueResult {
  const P = MUSCLE_FATIGUE_PARAMS
  const states = runCompartments(input)
  const volumes = buildVolumeWindows(input)

  const groups: GroupFatigue[] = MUSCLE_GROUPS.map((group) => {
    const membership = GROUP_MEMBERSHIP[group]
    const members = Object.entries(membership) as [Muscle, number][]

    // Per-muscle detail rows for this group.
    const muscles: MuscleDetail[] = members.map(([m]) => {
      const st = states.get(m)!
      const lowData = st.totalStim <= P.lowDataStimulusFloor
      return {
        muscle: m,
        fatigue: st.fatigue,
        weekSets: volumes.week.get(m) ?? 0,
        lowData
      }
    })

    // Group fatigue = capacity-weighted mean of member fatigues, using the
    // fractional group memberships as an additional weight (so a group is not
    // dragged by a tiny muscle). Weight = membershipFraction * capacity.
    let wSum = 0
    let fSum = 0
    for (const [m, frac] of members) {
      const st = states.get(m)!
      const w = frac * st.cap
      wSum += w
      fSum += w * st.fatigue
    }
    const fatigue = wSum > 0 ? clamp01(fSum / wSum) : 0

    // Group volume windows = Σ member-muscle sets (fractional membership not
    // applied to volume — volume is descriptive set-count per the existing
    // muscleSetVolume convention; membership fractions govern fatigue only).
    const volWeek = members.reduce((acc, [m]) => acc + (volumes.week.get(m) ?? 0), 0)
    const volPrev = members.reduce((acc, [m]) => acc + (volumes.prevWeek.get(m) ?? 0), 0)
    const volMonth = members.reduce((acc, [m]) => acc + (volumes.month.get(m) ?? 0), 0)

    // Group is low-data when every member muscle is low-data.
    const lowData = muscles.every((m) => m.lowData)

    return {
      group,
      fatigue,
      lowData,
      volumeWeekSets: volWeek,
      volumeMonthSets: volMonth,
      volumePrevWeekSets: volPrev,
      muscles
    }
  })

  return { groups }
}
