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
  bwProxy: 40, // BW_PROXY nominal load for bodyweight sets (kg-equivalent) — tuning
  kappaH: 0.5, // hardness slope above r0 — tuning
  r0: 1.0, // relIntensity threshold where hardness kicks in — tuning
  refPercentile: 0.9, // ref30 = 90th-pctile working weight over trailing 30 d
  referenceSetReps: 10, // normalizes lifting into 10-rep hard-set equivalents

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
  lowDataStimulusFloor: 1e-6
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

/** Effective load of a set: weight_kg, or BW_PROXY for a bodyweight (null-weight) set. */
function setLoad(s: GymSet): number {
  return s.weight_kg == null ? MUSCLE_FATIGUE_PARAMS.bwProxy : s.weight_kg
}

// ---------------------------------------------------------------------------
// Per-day per-muscle stimulus s_m(d) = liftStim + cardioStim  (§2)
// ---------------------------------------------------------------------------

/**
 * ref30: the 90th-percentile working weight for an exercise over the trailing
 * refWindowDays before `dayKey`, given that exercise's dated loads. Excluding
 * the current day lets a genuinely heavier session register as harder instead
 * of letting its own top set redefine the reference. With no prior history the
 * caller falls back to the set's own load. Bodyweight sets contribute BW_PROXY.
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
  // First, collect per-exercise working-set loads keyed by day, to compute ref30.
  const exerciseLoads = new Map<string, { dayKey: string; load: number }[]>()
  for (const sess of sessions) {
    const dayKey = localDateKey(sess.performed_at, timezone)
    for (const set of sess.sets) {
      if (set.is_warmup) continue
      const arr = exerciseLoads.get(set.exercise_id) ?? []
      arr.push({ dayKey, load: setLoad(set) })
      exerciseLoads.set(set.exercise_id, arr)
    }
  }

  for (const sess of sessions) {
    const dayKey = localDateKey(sess.performed_at, timezone)
    for (const set of sess.sets) {
      if (set.is_warmup) continue
      const ex = exercisesById.get(set.exercise_id)
      if (!ex) continue // custom without muscle metadata -> honest gap, no guess
      const reps = set.reps ?? 0
      if (reps <= 0) continue
      const load = setLoad(set)

      // relIntensity = load / ref30 (this set's weight vs the user's recent norm).
      const ref = buildRef30(exerciseLoads.get(set.exercise_id) ?? [], dayKey)
      const referenceLoad = ref && ref > 0 ? ref : load
      const relIntensity = load / referenceLoad
      const hardness = 1 + P.kappaH * Math.max(0, relIntensity - P.r0)
      // One standard working set is roughly 10 reps at the user's own recent
      // working load. This preserves extra fatigue from unusually heavy sets,
      // while avoiding raw kilogram volume as the recovery unit.
      const hardSetEquivalent = (reps * load) / (P.referenceSetReps * referenceLoad)
      const sigma = hardSetEquivalent * hardness

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
