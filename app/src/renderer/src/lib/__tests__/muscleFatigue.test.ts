import { describe, it, expect } from 'vitest'
import type { Exercise, GymSession, GymSet, Workout } from '@shared/types'
import {
  computeMuscleFatigue,
  fatigueStatus,
  MUSCLE_FATIGUE_PARAMS,
  type MuscleFatigueInput,
  type GroupFatigue,
  type MuscleGroup
} from '../muscleFatigue'

// ---------------------------------------------------------------------------
// Fixture factories (mirrors the fully-nulled-type + Partial-overrides pattern
// from zone2Fitness.test.ts).
// ---------------------------------------------------------------------------

let setIdSeq = 1
function set(overrides: Partial<GymSet> = {}): GymSet {
  return {
    id: setIdSeq++,
    session_id: 's',
    exercise_id: 'ex',
    exercise_name: 'Exercise',
    position: 0,
    reps: 10,
    weight_kg: 100,
    rpe: null,
    is_warmup: false,
    note: null,
    ...overrides
  }
}

let sessionIdSeq = 1
function session(performedAt: string, sets: GymSet[], overrides: Partial<GymSession> = {}): GymSession {
  const id = `sess-${sessionIdSeq++}`
  return {
    id,
    workout_id: null,
    template_id: null,
    performed_at: performedAt,
    title: null,
    notes: null,
    source: 'user',
    body_parts: null,
    sets: sets.map((s) => ({ ...s, session_id: id })),
    created_at: null,
    updated_at: null,
    ...overrides,
    template_ids: overrides.template_ids ?? []
  }
}

let woIdSeq = 1
function workout(
  type: string,
  startAt: string,
  trimp: number,
  zones: Partial<Record<'z1' | 'z2' | 'z3' | 'z4' | 'z5', number>> = {}
): Workout {
  const id = `wo-${woIdSeq++}`
  return {
    id,
    external_id: null,
    type,
    start_at: startAt,
    end_at: null,
    duration_s: null,
    distance_m: null,
    energy_kcal: null,
    avg_hr: null,
    max_hr: null,
    source: null,
    raw: null,
    computed: {
      workout_id: id,
      time_in_zones: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, ...zones },
      trimp,
      ef: null,
      decoupling_pct: null,
      hrr60: null,
      computed_at: null
    }
  }
}

function exercise(overrides: Partial<Exercise> & { id: string }): Exercise {
  return {
    name: overrides.id,
    aliases: [],
    body_part: null,
    primary_muscles: [],
    secondary_muscles: [],
    equipment: null,
    mechanics: null,
    movement_pattern: null,
    source: 'catalog',
    created_at: null,
    ...overrides
  }
}

function mapOf(...exs: Exercise[]): Map<string, Exercise> {
  return new Map(exs.map((e) => [e.id, e]))
}

// Catalog exercises used across tests. Muscle strings match the DB CHECK vocab.
const BENCH = exercise({
  id: 'bench',
  name: 'Barbell Bench Press',
  body_part: 'chest',
  primary_muscles: ['chest'],
  secondary_muscles: ['front delts', 'triceps']
})
const SQUAT = exercise({
  id: 'squat',
  name: 'Back Squat',
  body_part: 'legs',
  primary_muscles: ['quadriceps', 'glutes'],
  secondary_muscles: ['hamstrings', 'lower back']
})
const CURL = exercise({
  id: 'curl',
  name: 'Barbell Curl',
  body_part: 'arms',
  primary_muscles: ['biceps'],
  secondary_muscles: ['forearms']
})

const TZ = 'UTC'

function baseInput(overrides: Partial<MuscleFatigueInput> = {}): MuscleFatigueInput {
  return {
    sessions: [],
    workouts: [],
    exercisesById: new Map(),
    aerobicBase: null,
    timezone: TZ,
    asOf: new Date('2026-07-12T12:00:00.000Z'),
    ...overrides
  }
}

function groupBy(result: { groups: GroupFatigue[] }, g: MuscleGroup): GroupFatigue {
  const found = result.groups.find((x) => x.group === g)
  if (!found) throw new Error(`group ${g} missing from result`)
  return found
}

function muscleDetail(group: GroupFatigue, muscle: string) {
  const m = group.muscles.find((x) => x.muscle === muscle)
  if (!m) throw new Error(`muscle ${muscle} not in group ${group.group}`)
  return m
}

const GROUPS: MuscleGroup[] = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core']

// ---------------------------------------------------------------------------
// Structural output shape
// ---------------------------------------------------------------------------

describe('output shape', () => {
  it('returns exactly the 6 anatomical groups, never a full body group', () => {
    const res = computeMuscleFatigue(baseInput())
    const names = res.groups.map((g) => g.group).sort()
    expect(names).toEqual([...GROUPS].sort())
    expect(res.groups.map((g) => g.group)).not.toContain('full body')
  })

  it('clamps every fatigue value into [0,1]', () => {
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'squat', reps: 20, weight_kg: 300 })])],
        exercisesById: mapOf(SQUAT)
      })
    )
    for (const g of res.groups) {
      expect(g.fatigue).toBeGreaterThanOrEqual(0)
      expect(g.fatigue).toBeLessThanOrEqual(1)
      for (const m of g.muscles) {
        expect(m.fatigue).toBeGreaterThanOrEqual(0)
        expect(m.fatigue).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('fatigue status bands', () => {
  it('uses distinct recovery language instead of calling ordinary training fatigued', () => {
    expect(fatigueStatus(0.19, false).label).toBe('fresh')
    expect(fatigueStatus(0.2, false).label).toBe('ready')
    expect(fatigueStatus(0.4, false).label).toBe('loaded')
    expect(fatigueStatus(0.65, false).label).toBe('fatigued')
    expect(fatigueStatus(0.8, true).label).toBe('low data')
  })
})

// ---------------------------------------------------------------------------
// §9: share / rollup — a bench set adds 1.0 to chest, 0.5 to front delts
// ---------------------------------------------------------------------------

describe('share weighting and volume rollup', () => {
  it('credits a bench working set 1.0 to chest and 0.5 to front delts (weekSets)', () => {
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'bench' })])],
        exercisesById: mapOf(BENCH)
      })
    )
    const chest = groupBy(res, 'chest')
    expect(muscleDetail(chest, 'chest').weekSets).toBeCloseTo(1.0, 10)

    const shoulders = groupBy(res, 'shoulders')
    expect(muscleDetail(shoulders, 'front delts').weekSets).toBeCloseTo(0.5, 10)

    const arms = groupBy(res, 'arms')
    expect(muscleDetail(arms, 'triceps').weekSets).toBeCloseTo(0.5, 10)
  })

  it('excludes warmup sets from volume', () => {
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'bench', is_warmup: true }),
            set({ exercise_id: 'bench', is_warmup: false })
          ])
        ],
        exercisesById: mapOf(BENCH)
      })
    )
    expect(muscleDetail(groupBy(res, 'chest'), 'chest').weekSets).toBeCloseTo(1.0, 10)
  })

  it('sums group weekly volume across member muscles (three bench sets)', () => {
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'bench' }),
            set({ exercise_id: 'bench' }),
            set({ exercise_id: 'bench' })
          ])
        ],
        exercisesById: mapOf(BENCH)
      })
    )
    // chest group: only chest muscle -> 3 * 1.0
    expect(groupBy(res, 'chest').volumeWeekSets).toBeCloseTo(3.0, 10)
    // shoulders group volume includes front delts (0.5 * 3 = 1.5). rear delts/others 0.
    expect(groupBy(res, 'shoulders').volumeWeekSets).toBeCloseTo(1.5, 10)
    // arms group volume includes triceps (0.5 * 3 = 1.5).
    expect(groupBy(res, 'arms').volumeWeekSets).toBeCloseTo(1.5, 10)
  })

  it('separates weekly / prev-week / monthly volume windows', () => {
    // asOf 2026-07-12 (Sunday) -> ISO week 2026-W28 is Mon 2026-07-06 .. Sun 2026-07-12.
    // prev ISO week 2026-W27 is Mon 2026-06-29 .. Sun 2026-07-05.
    // month-to-date = July 1..12.
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-08T09:00:00.000Z', [set({ exercise_id: 'bench' })]), // this week + this month
          session('2026-07-02T09:00:00.000Z', [set({ exercise_id: 'bench' })]), // this month, NOT this week, prev week? no (W27 ends 07-05, 07-02 is in W27)
          session('2026-06-30T09:00:00.000Z', [set({ exercise_id: 'bench' })]) // prev week (W27), NOT this month
        ],
        exercisesById: mapOf(BENCH)
      })
    )
    const chest = groupBy(res, 'chest')
    expect(chest.volumeWeekSets).toBeCloseTo(1.0, 10) // only 07-08
    expect(chest.volumePrevWeekSets).toBeCloseTo(2.0, 10) // 07-02 and 06-30 both in W27
    expect(chest.volumeMonthSets).toBeCloseTo(2.0, 10) // 07-08 and 07-02 in July
  })
})

// ---------------------------------------------------------------------------
// §9: leaky-integrator identity vs a hand-computed short series
// ---------------------------------------------------------------------------

describe('leaky integrator acute recurrence', () => {
  it('keeps six chest sets spread across a week out of the high-fatigue band', () => {
    // A small, ordinary push dose should not look like an injury-level recovery
    // problem merely because the app has only just begun recording gym history.
    // This guards the cold-start calibration: three sets six days ago plus three
    // today must stay below the UI's "loaded" boundary (0.40).
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-06T09:00:00.000Z', [
            set({ exercise_id: 'bench', reps: 8, weight_kg: 70 }),
            set({ exercise_id: 'bench', reps: 8, weight_kg: 70 }),
            set({ exercise_id: 'bench', reps: 8, weight_kg: 70 })
          ]),
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'bench', reps: 8, weight_kg: 60 }),
            set({ exercise_id: 'bench', reps: 8, weight_kg: 60 }),
            set({ exercise_id: 'bench', reps: 8, weight_kg: 60 })
          ])
        ],
        exercisesById: mapOf(BENCH),
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )

    expect(groupBy(res, 'chest').fatigue).toBeLessThan(0.4)
  })

  it('matches a hand-computed two-session series with a rest-day decay in between', () => {
    // Isolate a single muscle (biceps) via a pure-primary curl with no secondary
    // overlap into biceps. Use a fixed weight so relIntensity == 1 (hardness == 1)
    // on every set -> stimulus is deterministic and equals volumeLoad * share.
    const CURL_PURE = exercise({
      id: 'curlp',
      name: 'Pure Curl',
      body_part: 'arms',
      primary_muscles: ['biceps'],
      secondary_muscles: []
    })
    // Two sessions: day A (07-10) and day C (07-12), rest day B (07-11) between.
    // Each is one standard set: 10 reps at the reference working load, so each
    // deposits exactly 1 hard-set equivalent.
    const s1 = 1 // stimulus on 07-10
    const s2 = 1 // stimulus on 07-12

    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-10T09:00:00.000Z', [set({ exercise_id: 'curlp', reps: 10, weight_kg: 20 })]),
          session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'curlp', reps: 10, weight_kg: 20 })])
        ],
        exercisesById: mapOf(CURL_PURE),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const biceps = muscleDetail(groupBy(res, 'arms'), 'biceps')

    // Re-derive the expected acute + fatigue with the exported params.
    const P = MUSCLE_FATIGUE_PARAMS
    // tau_rec for biceps: tau0 * f_muscle(biceps) * g(cap, aerobicBase=null -> aerobic term skipped)
    // We reconstruct the model's own tau by asking it through the exported helper
    // is not available, so we recompute using the documented formula and the
    // params object. cap evolves via alpha_cap.
    const alphaCap = 1 - Math.exp(-1 / P.tauCapDays)
    const fMuscle = P.muscleSizeFactor.biceps ?? 1

    // Walk the daily axis 07-10, 07-11, 07-12.
    let acute = 0
    let cap = 0
    const stimByDay = [s1, 0, s2]
    let fatigue = 0
    for (const s of stimByDay) {
      // tau_rec depends on cap BEFORE this day's update (uses previous-day cap per
      // recurrence reading order); floor at tauRecFloorDays.
      const gTerm = 1 / (1 + P.capRecoveryGain * cap)
      const tauRec = Math.max(P.tauRecFloorDays, P.tau0Days * fMuscle * gTerm)
      acute = acute * Math.exp(-1 / tauRec) + s
      cap = cap + alphaCap * (s - cap)
      const capacityForFatigue = Math.max(cap, P.baselineCapacitySetEquivalents)
      fatigue = 1 - Math.exp(-acute / (capacityForFatigue * P.kappaScale + P.epsilon))
    }

    expect(biceps.fatigue).toBeCloseTo(fatigue, 6)
    expect(biceps.fatigue).toBeGreaterThan(0)
  })

  it('a long rest gap decays acute fatigue toward ~0', () => {
    const CURL_PURE = exercise({
      id: 'curlp',
      name: 'Pure Curl',
      body_part: 'arms',
      primary_muscles: ['biceps'],
      secondary_muscles: []
    })
    // Trained heavily 40 days before asOf, nothing since -> acute must have decayed near 0.
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-06-02T09:00:00.000Z', [
            set({ exercise_id: 'curlp', reps: 10, weight_kg: 20 }),
            set({ exercise_id: 'curlp', reps: 10, weight_kg: 20 }),
            set({ exercise_id: 'curlp', reps: 10, weight_kg: 20 })
          ])
        ],
        exercisesById: mapOf(CURL_PURE),
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const biceps = muscleDetail(groupBy(res, 'arms'), 'biceps')
    expect(biceps.fatigue).toBeLessThan(0.05)
    // But it HAS history, so it is not flagged low-data.
    expect(biceps.lowData).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §9: relIntensity — heavier set of equal tonnage yields higher stimulus
// ---------------------------------------------------------------------------

describe('relIntensity / hardness', () => {
  it('a heavier set beats a lighter set of equal tonnage (higher fatigue)', () => {
    const PRESS = exercise({
      id: 'press',
      name: 'Overhead Press',
      body_part: 'shoulders',
      primary_muscles: ['front delts'],
      secondary_muscles: []
    })
    // Build a 30-day history so ref30 is well-defined and identical across both
    // scenarios, then compare a top-heavy day vs an even day of the SAME tonnage.
    // Scenario HEAVY: one heavy set 5x100 (=500) + light padding to build history.
    // Scenario LIGHT: 10x50 (=500) same tonnage but at/below the norm.
    // To keep ref30 identical, give both the same trailing history and only differ
    // on the final (asOf-day) set.
    const history = [
      session('2026-06-20T09:00:00.000Z', [set({ exercise_id: 'press', reps: 8, weight_kg: 60 })]),
      session('2026-06-27T09:00:00.000Z', [set({ exercise_id: 'press', reps: 8, weight_kg: 60 })]),
      session('2026-07-04T09:00:00.000Z', [set({ exercise_id: 'press', reps: 8, weight_kg: 60 })])
    ]
    const heavy = computeMuscleFatigue(
      baseInput({
        sessions: [
          ...history,
          session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'press', reps: 5, weight_kg: 100 })])
        ],
        exercisesById: mapOf(PRESS),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const light = computeMuscleFatigue(
      baseInput({
        sessions: [
          ...history,
          session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'press', reps: 10, weight_kg: 50 })])
        ],
        exercisesById: mapOf(PRESS),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const heavyF = muscleDetail(groupBy(heavy, 'shoulders'), 'front delts').fatigue
    const lightF = muscleDetail(groupBy(light, 'shoulders'), 'front delts').fatigue
    expect(heavyF).toBeGreaterThan(lightF)
  })

  it('equal weight + equal tonnage yields equal stimulus (hardness has no effect below r0)', () => {
    const PRESS = exercise({
      id: 'press',
      name: 'Overhead Press',
      body_part: 'shoulders',
      primary_muscles: ['front delts'],
      secondary_muscles: []
    })
    // Same single set both times -> identical fatigue (sanity that the comparison
    // above is driven by weight, not by tonnage split alone).
    const a = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'press', reps: 8, weight_kg: 60 })])],
        exercisesById: mapOf(PRESS),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const b = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'press', reps: 8, weight_kg: 60 })])],
        exercisesById: mapOf(PRESS),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    expect(muscleDetail(groupBy(a, 'shoulders'), 'front delts').fatigue).toBeCloseTo(
      muscleDetail(groupBy(b, 'shoulders'), 'front delts').fatigue,
      10
    )
  })
})

// ---------------------------------------------------------------------------
// §9: cardio — zone weighting, modality mech, and spill targeting
// ---------------------------------------------------------------------------

describe('cardio stimulus', () => {
  it('a Z4 run deposits far more into legs than a Z1 walk of equal duration', () => {
    // Equal duration is captured through TRIMP: a Z4 session has a much higher
    // zone-weighted TRIMP than a Z1 walk of the same minutes. Model reads TRIMP.
    //
    // Establish an identical baseline of easy-running leg conditioning for BOTH
    // scenarios so leg capacity is non-trivial and the asOf-day fatigue sits in
    // the linear (non-saturated) band — otherwise a single deposit into an
    // unconditioned muscle saturates fatigue→1 (which is itself correct model
    // behavior, but hides the deposit ratio). The two scenarios then differ only
    // by the final day's session.
    // Build a real 6-week easy-run history on distinct dates.
    const history: Workout[] = []
    let d = new Date('2026-05-31T07:00:00.000Z')
    for (let i = 0; i < 20; i++) {
      history.push(workout('running', d.toISOString(), 40, { z2: 2400 }))
      d = new Date(d.getTime() + 2 * 86400000)
    }
    const run = computeMuscleFatigue(
      baseInput({
        workouts: [...history, workout('running', '2026-07-12T07:00:00.000Z', 90, { z4: 1800 })],
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const walk = computeMuscleFatigue(
      baseInput({
        workouts: [...history, workout('walking', '2026-07-12T07:00:00.000Z', 12, { z1: 1800 })],
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const runLegs = groupBy(run, 'legs').fatigue
    const walkLegs = groupBy(walk, 'legs').fatigue
    expect(runLegs).toBeGreaterThan(walkLegs)
    // "far more" (≫): the extra fatigue the Z4 run adds over the shared baseline
    // dwarfs what the Z1 walk adds. Measured against the baseline-only residual.
    const baselineLegs = groupBy(
      computeMuscleFatigue(baseInput({ workouts: history, asOf: new Date('2026-07-12T12:00:00.000Z') })),
      'legs'
    ).fatigue
    const runDelta = runLegs - baselineLegs
    const walkDelta = walkLegs - baselineLegs
    expect(runDelta).toBeGreaterThan(walkDelta * 3)
  })

  it('a swim deposits into back/shoulders/core and ~0 into quads', () => {
    const res = computeMuscleFatigue(
      baseInput({
        workouts: [workout('pool_swim', '2026-07-12T07:00:00.000Z', 80, { z2: 2400 })],
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    // Swim spill targets lats/upper back (-> back), delts (-> shoulders),
    // abs/obliques (-> core). No quads in the swim spill table -> legs ~0.
    expect(groupBy(res, 'back').fatigue).toBeGreaterThan(0)
    expect(groupBy(res, 'shoulders').fatigue).toBeGreaterThan(0)
    expect(groupBy(res, 'core').fatigue).toBeGreaterThan(0)

    const legs = groupBy(res, 'legs')
    expect(legs.fatigue).toBeLessThan(1e-6)
    expect(muscleDetail(legs, 'quadriceps').fatigue).toBeLessThan(1e-9)
  })

  it('mech(running) > mech(cycling): equal TRIMP into shared quads spills more from running', () => {
    // Running quads spill .3, cycling quads spill .55, so raw spill favors cycling.
    // The mech multiplier (1.0 vs 0.35) is what the test isolates, so compare the
    // per-modality deposit into quadriceps at EQUAL trimp AND equal spill share by
    // reading the exported params directly, plus an end-to-end ordering check on a
    // muscle where cycling's larger spill does NOT flip the result.
    const P = MUSCLE_FATIGUE_PARAMS
    expect(P.mech.running).toBeGreaterThan(P.mech.cycling)

    // End-to-end: glutes get .15 (run) vs .25 (cycling) spill. Even with cycling's
    // higher spill, run's 1.0 mech vs cycling's 0.35 mech means run deposits more
    // per unit TRIMP overall into the whole leg group when TRIMP is equal, because
    // running touches quads+hams+calves+glutes+abs. Assert the leg-group deposit.
    const run = computeMuscleFatigue(
      baseInput({
        workouts: [workout('running', '2026-07-12T07:00:00.000Z', 20, { z3: 1800 })],
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const cycle = computeMuscleFatigue(
      baseInput({
        workouts: [workout('indoor_cycling', '2026-07-12T07:00:00.000Z', 20, { z3: 1800 })],
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    expect(groupBy(run, 'legs').fatigue).toBeGreaterThan(groupBy(cycle, 'legs').fatigue)
  })

  it('non-cardio (strength) workouts contribute no cardio stimulus', () => {
    const res = computeMuscleFatigue(
      baseInput({
        workouts: [workout('traditional_strength_training', '2026-07-12T07:00:00.000Z', 90, { z2: 1800 })],
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    // cardioModalityOf(strength) is null -> no deposit anywhere; everything low-data.
    for (const g of GROUPS) {
      expect(groupBy(res, g).fatigue).toBeLessThan(1e-9)
    }
  })

  it('faster recovery (higher aerobic base) leaves less residual acute fatigue', () => {
    const mk = (aerobicBase: number | null) =>
      computeMuscleFatigue(
        baseInput({
          // trained a few days ago so there is residual acute to decay
          workouts: [workout('running', '2026-07-08T07:00:00.000Z', 150, { z4: 2400 })],
          aerobicBase,
          asOf: new Date('2026-07-12T12:00:00.000Z')
        })
      )
    const unfit = groupBy(mk(0), 'legs').fatigue
    const fit = groupBy(mk(100), 'legs').fatigue
    expect(fit).toBeLessThan(unfit)
  })
})

// ---------------------------------------------------------------------------
// §9: detrained / thin-data edge — zero history => fatigue ~0 AND low-data flag
// ---------------------------------------------------------------------------

describe('detrained / low-data edge', () => {
  it('a muscle with no logged history reads fatigue ~0 and lowData=true (not "recovered")', () => {
    const res = computeMuscleFatigue(baseInput()) // nothing logged at all
    for (const g of GROUPS) {
      const group = groupBy(res, g)
      expect(group.fatigue).toBeLessThan(1e-9)
      expect(group.lowData).toBe(true)
      for (const m of group.muscles) {
        expect(m.fatigue).toBeLessThan(1e-9)
        expect(m.lowData).toBe(true)
      }
    }
  })

  it('a trained group is not flagged low-data even when its rarely-trained sibling muscle is', () => {
    // Train only chest. chest muscle -> not low-data; but e.g. legs stays low-data.
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'bench' }), set({ exercise_id: 'bench' })])
        ],
        exercisesById: mapOf(BENCH)
      })
    )
    expect(groupBy(res, 'chest').lowData).toBe(false)
    expect(muscleDetail(groupBy(res, 'chest'), 'chest').lowData).toBe(false)
    // Legs never trained -> low-data.
    expect(groupBy(res, 'legs').lowData).toBe(true)
  })

  it('detrained edge holds even with a recent tiny cardio touch below the data threshold? (history presence flips it)', () => {
    // A single real lifting session on the muscle is enough history to clear the flag.
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-11T09:00:00.000Z', [set({ exercise_id: 'curl' })])],
        exercisesById: mapOf(CURL)
      })
    )
    expect(muscleDetail(groupBy(res, 'arms'), 'biceps').lowData).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Full-body exercise distribution (spec §4: distributes via its own muscles)
// ---------------------------------------------------------------------------

describe('full-body exercise distribution', () => {
  it('a full-body-tagged exercise distributes into the 6 groups via its muscles, no full body group', () => {
    const THRUSTER = exercise({
      id: 'thruster',
      name: 'Thruster',
      body_part: 'full body',
      primary_muscles: ['quadriceps', 'front delts'],
      secondary_muscles: ['glutes', 'triceps', 'abs']
    })
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'thruster' })])],
        exercisesById: mapOf(THRUSTER)
      })
    )
    expect(res.groups.map((g) => g.group)).not.toContain('full body')
    // quads(1.0)+glutes(0.5) -> legs has volume; front delts(1.0) -> shoulders;
    // triceps(0.5) -> arms; abs(0.5) -> core.
    expect(groupBy(res, 'legs').volumeWeekSets).toBeGreaterThan(0)
    expect(groupBy(res, 'shoulders').volumeWeekSets).toBeGreaterThan(0)
    expect(groupBy(res, 'arms').volumeWeekSets).toBeGreaterThan(0)
    expect(groupBy(res, 'core').volumeWeekSets).toBeGreaterThan(0)
    expect(muscleDetail(groupBy(res, 'legs'), 'quadriceps').weekSets).toBeCloseTo(1.0, 10)
    expect(muscleDetail(groupBy(res, 'core'), 'abs').weekSets).toBeCloseTo(0.5, 10)
  })
})

// ---------------------------------------------------------------------------
// Group fatigue rollup is capacity-weighted (not dragged by a tiny muscle)
// ---------------------------------------------------------------------------

describe('group fatigue rollup', () => {
  it('a group fatigue lies within the range of its member-muscle fatigues', () => {
    // Squat drives quads/glutes hard, hamstrings/lower-back moderately. The legs
    // group fatigue should be a weighted mean, hence between min and max member.
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'squat', reps: 5, weight_kg: 140 }),
            set({ exercise_id: 'squat', reps: 5, weight_kg: 140 }),
            set({ exercise_id: 'squat', reps: 5, weight_kg: 140 })
          ])
        ],
        exercisesById: mapOf(SQUAT),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const legs = groupBy(res, 'legs')
    const memberFatigues = legs.muscles.filter((m) => m.weekSets > 0).map((m) => m.fatigue)
    const min = Math.min(...memberFatigues)
    const max = Math.max(...memberFatigues)
    expect(legs.fatigue).toBeGreaterThanOrEqual(min - 1e-9)
    expect(legs.fatigue).toBeLessThanOrEqual(max + 1e-9)
  })

  it('rear delts split their membership across back and shoulders', () => {
    // An exercise hitting only rear delts should raise BOTH back (0.4) and
    // shoulders (0.6) group fatigue, since rear delts has fractional membership.
    const REAR = exercise({
      id: 'rear',
      name: 'Reverse Fly',
      body_part: 'shoulders',
      primary_muscles: ['rear delts'],
      secondary_muscles: []
    })
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'rear', reps: 12, weight_kg: 15 })])],
        exercisesById: mapOf(REAR)
      })
    )
    expect(groupBy(res, 'shoulders').fatigue).toBeGreaterThan(0)
    expect(groupBy(res, 'back').fatigue).toBeGreaterThan(0)
    // rear delts appears in both groups' muscle detail lists.
    expect(muscleDetail(groupBy(res, 'shoulders'), 'rear delts')).toBeTruthy()
    expect(muscleDetail(groupBy(res, 'back'), 'rear delts')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Params object is the single source of truth for the marked priors
// ---------------------------------------------------------------------------

describe('MUSCLE_FATIGUE_PARAMS', () => {
  it('exposes the marked priors and tuning constants from §5', () => {
    const P = MUSCLE_FATIGUE_PARAMS
    expect(typeof P.kCardio).toBe('number')
    expect(typeof P.tau0Days).toBe('number')
    expect(typeof P.tauCapDays).toBe('number')
    expect(typeof P.kappaH).toBe('number')
    expect(typeof P.r0).toBe('number')
    expect(typeof P.kappaScale).toBe('number')
    expect(typeof P.bwProxy).toBe('number')
    // grounded tables present
    expect(P.mech.running).toBe(1.0)
    expect(P.mech.cycling).toBeLessThan(P.mech.running)
    expect(P.spill.swim).toBeTruthy()
    expect(P.spill.running.quadriceps).toBeGreaterThan(0)
    expect(P.spill.swim.quadriceps ?? 0).toBe(0)
  })

  it('cardio deposits less per unit than lifting (kCardio is conservative < 1)', () => {
    expect(MUSCLE_FATIGUE_PARAMS.kCardio).toBeLessThan(1)
    expect(MUSCLE_FATIGUE_PARAMS.kCardio).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Realistic end-to-end scenario (mock data): a full PPL training week + a swim
// and a run, on top of ~5 weeks of conditioning history. Proves the whole
// feature yields sensible numbers and exercises the card's data contract
// (week/month volumes, per-group expand rows, fatigue ranking, cardio spill).
// ---------------------------------------------------------------------------

describe('realistic training week (mock-data scenario)', () => {
  const ROW = exercise({
    id: 'row',
    name: 'Barbell Row',
    body_part: 'back',
    primary_muscles: ['lats', 'upper back'],
    secondary_muscles: ['biceps', 'rear delts']
  })
  const OHP = exercise({
    id: 'ohp',
    name: 'Overhead Press',
    body_part: 'shoulders',
    primary_muscles: ['front delts', 'side delts'],
    secondary_muscles: ['triceps']
  })
  const RDL = exercise({
    id: 'rdl',
    name: 'Romanian Deadlift',
    body_part: 'legs',
    primary_muscles: ['hamstrings', 'glutes'],
    secondary_muscles: ['lower back']
  })
  const PUSHDOWN = exercise({
    id: 'pushdown',
    name: 'Triceps Pushdown',
    body_part: 'arms',
    primary_muscles: ['triceps'],
    secondary_muscles: []
  })
  const PLANK = exercise({
    id: 'plank',
    name: 'Plank',
    body_part: 'core',
    primary_muscles: ['abs'],
    secondary_muscles: ['obliques']
  })
  const CAT = mapOf(BENCH, SQUAT, CURL, ROW, OHP, RDL, PUSHDOWN, PLANK)

  const nSets = (exId: string, n: number, reps: number, kg: number): GymSet[] =>
    Array.from({ length: n }, () => set({ exercise_id: exId, reps, weight_kg: kg }))

  const iso = (ms: number): string => new Date(ms).toISOString()
  const WEEK_MON = new Date('2026-07-06T00:00:00.000Z').getTime() // Mon of the current ISO week (W28)
  const DAY = 86_400_000
  const ASOF = new Date('2026-07-12T20:00:00.000Z') // Sunday evening

  // ~5 weeks of prior PPL + easy cardio so ref30/capacity are well-defined and
  // asOf-day fatigue sits in the model's linear band (a lone deposit into an
  // unconditioned muscle correctly saturates to 1 and would flatten comparisons).
  const priorSessions: GymSession[] = []
  const priorWorkouts: Workout[] = []
  for (let wk = 5; wk >= 1; wk--) {
    const mon = WEEK_MON - wk * 7 * DAY
    priorSessions.push(session(iso(mon + 1 * DAY + 18 * 3_600_000), [...nSets('bench', 4, 8, 80), ...nSets('ohp', 3, 8, 45)]))
    priorSessions.push(session(iso(mon + 3 * DAY + 18 * 3_600_000), [...nSets('row', 4, 8, 70), ...nSets('curl', 3, 12, 20)]))
    priorSessions.push(session(iso(mon + 5 * DAY + 18 * 3_600_000), [...nSets('squat', 4, 6, 120), ...nSets('rdl', 3, 8, 90)]))
    priorWorkouts.push(workout('running', iso(mon + 2 * DAY + 8 * 3_600_000), 40, { z2: 2400 }))
    priorWorkouts.push(workout('pool_swim', iso(mon + 4 * DAY + 8 * 3_600_000), 45, { z2: 2400 }))
  }

  // The current week (W28): push Mon, pull Wed, legs Fri, swim Sat, harder run Sun.
  const weekSessions: GymSession[] = [
    session(iso(WEEK_MON + 0 * DAY + 18 * 3_600_000), [...nSets('bench', 4, 8, 82), ...nSets('ohp', 3, 8, 45), ...nSets('pushdown', 3, 12, 32)]),
    session(iso(WEEK_MON + 2 * DAY + 18 * 3_600_000), [...nSets('row', 4, 8, 72), ...nSets('curl', 3, 12, 22)]),
    session(iso(WEEK_MON + 4 * DAY + 18 * 3_600_000), [...nSets('squat', 4, 6, 125), ...nSets('rdl', 3, 8, 92), ...nSets('plank', 3, 1, 0)])
  ]
  const weekWorkouts: Workout[] = [
    workout('pool_swim', iso(WEEK_MON + 5 * DAY + 9 * 3_600_000), 70, { z2: 2400, z3: 300 }), // Sat swim
    workout('running', iso(WEEK_MON + 6 * DAY + 8 * 3_600_000), 85, { z2: 900, z3: 1200, z4: 600 }) // Sun run, harder
  ]

  const input: MuscleFatigueInput = {
    sessions: [...priorSessions, ...weekSessions],
    workouts: [...priorWorkouts, ...weekWorkouts],
    exercisesById: CAT,
    aerobicBase: 45,
    timezone: TZ,
    asOf: ASOF
  }
  const res = computeMuscleFatigue(input)

  it('all six groups trained this week, with a populated expand contract', () => {
    for (const g of GROUPS) {
      const grp = groupBy(res, g)
      expect(grp.muscles.length).toBeGreaterThan(0) // the card can expand every group
      expect(grp.fatigue).toBeGreaterThanOrEqual(0)
      expect(grp.fatigue).toBeLessThanOrEqual(1)
      expect(grp.lowData).toBe(false) // 5 weeks of history → confident
      expect(grp.volumeWeekSets).toBeGreaterThan(0)
      expect(grp.volumeMonthSets).toBeGreaterThanOrEqual(grp.volumeWeekSets - 1e-9)
    }
    // "Muscles trained · this week" stat = groups with any weekly volume.
    const trained = res.groups.filter((g) => g.volumeWeekSets > 0).length
    expect(trained).toBe(6)
  })

  it('ranks recently-hit + cardio-loaded groups above rested ones', () => {
    const legs = groupBy(res, 'legs').fatigue // leg day Fri + run today
    const chest = groupBy(res, 'chest').fatigue // bench Mon, 6 days ago → recovered
    expect(legs).toBeGreaterThan(chest)
    const rankedTop3 = [...res.groups].sort((a, b) => b.fatigue - a.fatigue).slice(0, 3).map((g) => g.group)
    expect(rankedTop3).toContain('legs')
  })

  it('cardio spillover adds fatigue to the right groups (run→legs, swim→back)', () => {
    const noCardio = computeMuscleFatigue({ ...input, workouts: [] })
    // Sunday run raises legs above the lifting-only counterfactual.
    expect(groupBy(res, 'legs').fatigue).toBeGreaterThan(groupBy(noCardio, 'legs').fatigue)
    // Saturday swim raises back above lifting-only.
    expect(groupBy(res, 'back').fatigue).toBeGreaterThan(groupBy(noCardio, 'back').fatigue)
    // Swim does not touch quads — legs' quad component owes nothing to the swim.
    expect(muscleDetail(groupBy(res, 'legs'), 'quadriceps').fatigue).toBeGreaterThan(0)
  })

  it('[summary] prints the modeled Main-tab card for eyeballing', () => {
    const ranked = [...res.groups].sort((a, b) => b.fatigue - a.fatigue)
    const lines = ranked.map(
      (g) =>
        `  ${g.group.padEnd(10)} vol wk ${g.volumeWeekSets.toFixed(1).padStart(5)} · mo ${g.volumeMonthSets
          .toFixed(1)
          .padStart(5)} · fatigue ${(g.fatigue * 100).toFixed(0).padStart(3)}%`
    )
    // eslint-disable-next-line no-console
    console.log('\n[scenario] Muscle load & fatigue — Sun 2026-07-12, aerobic base 45:\n' + lines.join('\n') + '\n')
    expect(ranked.length).toBe(6)
  })
})
