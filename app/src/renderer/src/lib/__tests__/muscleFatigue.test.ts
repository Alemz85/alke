import { describe, it, expect } from 'vitest'
import type { Exercise, GymSession, GymSet, Workout } from '@shared/types'
import {
  GROUP_MEMBERSHIP,
  MUSCLES,
  MUSCLE_GROUPS,
  MUSCLE_ISO_JOINT,
  computeMuscleFatigue,
  exerciseLoadCoefficient,
  isBodyweightBearing,
  relIntensityFactor,
  isometricRepEquivalents,
  isometricReferenceSeconds,
  isoJointOf,
  setRepEquivalents,
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
    duration_s: null,
    weight_kg: 100,
    rpe: null,
    is_warmup: false,
    is_eccentric: false,
    is_unilateral: false,
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
  it('pins the conservative eccentric stimulus multiplier at 1.25', () => {
    expect(MUSCLE_FATIGUE_PARAMS.eccentricStimulusMultiplier).toBe(1.25)
  })

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

  it('excludes an eccentric warmup from both fatigue and volume', () => {
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'bench', is_warmup: true, is_eccentric: true })
          ])
        ],
        exercisesById: mapOf(BENCH)
      })
    )
    const chest = groupBy(res, 'chest')
    expect(muscleDetail(chest, 'chest').fatigue).toBe(0)
    expect(chest.volumeWeekSets).toBe(0)
    expect(chest.volumeMonthSets).toBe(0)
  })

  it('increases only a working eccentric set\'s fatigue stimulus, not its set counts', () => {
    const common = {
      sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 10, weight_kg: 70 })])],
      exercisesById: mapOf(BENCH),
      asOf: new Date('2026-07-12T20:00:00.000Z')
    }
    const concentric = computeMuscleFatigue(baseInput(common))
    const eccentric = computeMuscleFatigue(
      baseInput({
        ...common,
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'bench', reps: 10, weight_kg: 70, is_eccentric: true })
          ])
        ]
      })
    )

    expect(muscleDetail(groupBy(eccentric, 'chest'), 'chest').fatigue).toBeGreaterThan(
      muscleDetail(groupBy(concentric, 'chest'), 'chest').fatigue
    )
    expect(groupBy(eccentric, 'chest').volumeWeekSets).toBeCloseTo(
      groupBy(concentric, 'chest').volumeWeekSets,
      10
    )
    expect(groupBy(eccentric, 'chest').volumeMonthSets).toBeCloseTo(
      groupBy(concentric, 'chest').volumeMonthSets,
      10
    )
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
    // deposits exactly 1 hard-set equivalent BEFORE the load coefficient. CURL_PURE
    // carries no catalog metadata (equipment/mechanics/pattern all null), so its
    // exercise load coefficient degrades to the neutral default (0.55) and the
    // intensity factor is neutral 1.0 (fewer than minHistorySets prior sets). Each
    // session therefore deposits 1 * loadCoeff.
    const loadCoeff = MUSCLE_FATIGUE_PARAMS.loadCoeff.defaultCoeff
    const s1 = loadCoeff // stimulus on 07-10
    const s2 = loadCoeff // stimulus on 07-12

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
// Exercise load coefficient — intrinsic systemic cost from catalog metadata
// ---------------------------------------------------------------------------

describe('exercise load coefficient', () => {
  // Real catalog metadata (values match the exercises table's vocabularies).
  const BARBELL_SQUAT = exercise({
    id: 'bsquat',
    name: 'Back Squat',
    body_part: 'legs',
    primary_muscles: ['quadriceps'],
    secondary_muscles: [],
    equipment: 'barbell',
    mechanics: 'compound',
    movement_pattern: 'squat'
  })
  const BAND_DORSI = exercise({
    id: 'dorsi',
    name: 'Resisted Band Dorsiflexion',
    body_part: 'legs',
    primary_muscles: ['calves'],
    secondary_muscles: [],
    equipment: 'band',
    mechanics: 'isolation',
    movement_pattern: 'isolation'
  })

  it('ranks a barbell compound at the reference ceiling and a band rehab drill lowest', () => {
    // barbell(1.0) × compound(1.0) × squat(1.1) → clamped to ceil 1.0.
    expect(exerciseLoadCoefficient(BARBELL_SQUAT)).toBeCloseTo(1.0, 10)
    // band(0.3) × isolation(0.85) × isolation(0.85) = 0.21675 → clamped to floor 0.25.
    const band = exerciseLoadCoefficient(BAND_DORSI)
    expect(band).toBeCloseTo(MUSCLE_FATIGUE_PARAMS.loadCoeff.floor, 10)
    expect(band).toBeLessThan(exerciseLoadCoefficient(BARBELL_SQUAT))
  })

  it('orders equipment tiers: barbell > dumbbell > cable/bodyweight > band', () => {
    const mk = (equipment: string): number =>
      exerciseLoadCoefficient(
        exercise({ id: `x-${equipment}`, name: `X ${equipment}`, equipment, mechanics: 'isolation', movement_pattern: 'isolation' })
      )
    expect(mk('barbell')).toBeGreaterThan(mk('dumbbell'))
    expect(mk('dumbbell')).toBeGreaterThan(mk('cable'))
    expect(mk('cable')).toBeGreaterThanOrEqual(mk('band'))
    expect(mk('band')).toBe(MUSCLE_FATIGUE_PARAMS.loadCoeff.floor)
  })

  it('metadata-less custom exercise degrades to the neutral middle default', () => {
    // A custom exercise that carries blank equipment/mechanics/
    // pattern — must NOT be guessed as heavy or trivial.
    const CUSTOM = exercise({ id: 'custom', name: 'Custom Band Drill' })
    expect(exerciseLoadCoefficient(CUSTOM)).toBe(MUSCLE_FATIGUE_PARAMS.loadCoeff.defaultCoeff)
  })

  it('a name_key override wins outright over the metadata mapping', () => {
    const P = MUSCLE_FATIGUE_PARAMS
    const original = { ...P.loadCoeff.coeffOverride }
    try {
      // name_key = lowercased name.
      ;(P.loadCoeff.coeffOverride as Record<string, number>)['back squat'] = 0.42
      expect(exerciseLoadCoefficient(BARBELL_SQUAT)).toBe(0.42)
    } finally {
      ;(P.loadCoeff as { coeffOverride: Record<string, number> }).coeffOverride = original
    }
  })

  it('a band-rehab session contributes a small fraction of an equal-set-count barbell session', () => {
    // Same set count, same reps, both pure-primary into calves, no history so both
    // sit in the cold-start linear band and intensity is neutral. The band drill's
    // deposited stimulus (hence fatigue) must be a small fraction of the barbell's.
    const sets = (exId: string): GymSet[] =>
      Array.from({ length: 3 }, () => set({ exercise_id: exId, reps: 10, weight_kg: 40 }))

    const BARBELL_CALF = exercise({
      id: 'bcalf',
      name: 'Barbell Calf Raise',
      primary_muscles: ['calves'],
      secondary_muscles: [],
      equipment: 'barbell',
      mechanics: 'compound',
      movement_pattern: 'squat'
    })
    const heavy = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', sets('bcalf'))],
        exercisesById: mapOf(BARBELL_CALF),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const band = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', sets('dorsi'))],
        exercisesById: mapOf(BAND_DORSI),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const heavyCalf = muscleDetail(groupBy(heavy, 'legs'), 'calves').fatigue
    const bandCalf = muscleDetail(groupBy(band, 'legs'), 'calves').fatigue
    expect(bandCalf).toBeGreaterThan(0) // still registers, does not vanish
    // band coeff (0.25) vs barbell coeff (1.0): the band deposit is ~1/4 → fatigue
    // clearly a small fraction. Assert well under half as a robust bound.
    expect(bandCalf).toBeLessThan(heavyCalf * 0.5)
  })
})

// ---------------------------------------------------------------------------
// Relative-intensity factor — this set vs the user's own recent working median
// ---------------------------------------------------------------------------

describe('relative-intensity factor', () => {
  const PRESS = exercise({
    id: 'ripress',
    name: 'Overhead Press',
    body_part: 'shoulders',
    primary_muscles: ['front delts'],
    secondary_muscles: [],
    equipment: 'barbell',
    mechanics: 'compound',
    movement_pattern: 'vertical push'
  })

  // A 28-day history of steady 60kg working sets (>= minHistorySets, spread on
  // distinct days) so the trailing median is a firm 60kg on the asOf day.
  const steadyHistory = (): GymSession[] => [
    session('2026-06-20T09:00:00.000Z', [set({ exercise_id: 'ripress', reps: 8, weight_kg: 60 })]),
    session('2026-06-25T09:00:00.000Z', [set({ exercise_id: 'ripress', reps: 8, weight_kg: 60 })]),
    session('2026-07-01T09:00:00.000Z', [set({ exercise_id: 'ripress', reps: 8, weight_kg: 60 })]),
    session('2026-07-06T09:00:00.000Z', [set({ exercise_id: 'ripress', reps: 8, weight_kg: 60 })]),
    session('2026-07-09T09:00:00.000Z', [set({ exercise_id: 'ripress', reps: 8, weight_kg: 60 })])
  ]

  const finalSetFatigue = (finalWeight: number): number => {
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          ...steadyHistory(),
          session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'ripress', reps: 8, weight_kg: finalWeight })])
        ],
        exercisesById: mapOf(PRESS),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    return muscleDetail(groupBy(res, 'shoulders'), 'front delts').fatigue
  }

  it('above-norm weight raises the contribution; below-norm lowers it', () => {
    const atNorm = finalSetFatigue(60)
    const above = finalSetFatigue(80) // ratio 1.33 → factor > 1
    const below = finalSetFatigue(40) // ratio 0.67 → factor < 1
    expect(above).toBeGreaterThan(atNorm)
    expect(below).toBeLessThan(atNorm)
  })

  it('respects the parameterized bounds (extreme ratios saturate at min/max)', () => {
    // Tested directly on the factor helper so the clamp is isolated from the
    // hard-set-equivalent term (which independently scales with weight via ref30).
    const R = MUSCLE_FATIGUE_PARAMS.relIntensity
    // >= minHistorySets prior loads with median 60.
    const priors = [60, 60, 60, 60, 60]
    // Far above norm → clamped to max, and going even higher does not exceed it.
    expect(relIntensityFactor(set({ weight_kg: 300 }), priors)).toBe(R.max)
    expect(relIntensityFactor(set({ weight_kg: 6000 }), priors)).toBe(R.max)
    // Far below norm → clamped to min, and going even lower does not drop under it.
    expect(relIntensityFactor(set({ weight_kg: 6 }), priors)).toBe(R.min)
    expect(relIntensityFactor(set({ weight_kg: 0.5 }), priors)).toBe(R.min)
    // Exactly on the norm → neutral.
    expect(relIntensityFactor(set({ weight_kg: 60 }), priors)).toBeCloseTo(1.0, 10)
  })

  it('the factor helper degrades to neutral 1.0 on thin history and weightless sets', () => {
    const R = MUSCLE_FATIGUE_PARAMS.relIntensity
    // Fewer than minHistorySets prior loads → neutral even if far from them.
    const thin = Array.from({ length: R.minHistorySets - 1 }, () => 60)
    expect(relIntensityFactor(set({ weight_kg: 300 }), thin)).toBe(1)
    // Weightless (null) set → neutral regardless of history depth.
    expect(relIntensityFactor(set({ weight_kg: null }), [60, 60, 60, 60, 60])).toBe(1)
    // No history at all → neutral.
    expect(relIntensityFactor(set({ weight_kg: 100 }), [])).toBe(1)
  })

  it('exposes bounds and window as tunable params', () => {
    const R = MUSCLE_FATIGUE_PARAMS.relIntensity
    expect(R.min).toBeGreaterThan(0)
    expect(R.min).toBeLessThan(1)
    expect(R.max).toBeGreaterThan(1)
    expect(R.windowDays).toBeGreaterThan(0)
    expect(R.minHistorySets).toBeGreaterThan(0)
  })

  it('stays neutral (1.0) with no history — first exposures are not skewed', () => {
    // A single set, no prior history: intensity factor must be neutral, so the
    // result equals what the model gives with the factor logically at 1.0. We
    // assert two very different weights on a FIRST-ever exposure only differ via
    // the hardness/ref30 term, not the intensity factor (which is neutral for
    // both because priorLoads is empty).
    const first = (w: number): number => {
      const res = computeMuscleFatigue(
        baseInput({
          sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'ripress', reps: 8, weight_kg: w })])],
          exercisesById: mapOf(PRESS),
          asOf: new Date('2026-07-12T20:00:00.000Z')
        })
      )
      return muscleDetail(groupBy(res, 'shoulders'), 'front delts').fatigue
    }
    // With only the current session, ref30 falls back to the set's own load AND
    // priorLoads is empty → intensity neutral. Two first-exposure weights then
    // produce IDENTICAL hard-set-equivalent fatigue (10-rep-equivalent cancels the
    // weight, hardness == 1 at relIntensity 1). So they must be equal.
    expect(first(50)).toBeCloseTo(first(120), 10)
  })

  it('stays neutral for a bodyweight (weightless) set even with weighted history', () => {
    // A weightless set has no meaningful ratio → factor 1.0, regardless of any
    // prior weighted median for the exercise.
    const DIP = exercise({
      id: 'dip',
      name: 'Chest Dip',
      primary_muscles: ['chest'],
      secondary_muscles: [],
      equipment: 'bodyweight',
      mechanics: 'compound',
      movement_pattern: 'horizontal push'
    })
    // Give it weighted history then a bodyweight (null) final set — must not crash
    // and must produce a finite, in-range fatigue.
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-06-25T09:00:00.000Z', [set({ exercise_id: 'dip', reps: 8, weight_kg: 20 })]),
          session('2026-07-01T09:00:00.000Z', [set({ exercise_id: 'dip', reps: 8, weight_kg: 20 })]),
          session('2026-07-06T09:00:00.000Z', [set({ exercise_id: 'dip', reps: 8, weight_kg: 20 })]),
          session('2026-07-09T09:00:00.000Z', [set({ exercise_id: 'dip', reps: 8, weight_kg: 20 })]),
          session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'dip', reps: 8, weight_kg: null })])
        ],
        exercisesById: mapOf(DIP),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const chest = muscleDetail(groupBy(res, 'chest'), 'chest').fatigue
    expect(Number.isFinite(chest)).toBe(true)
    expect(chest).toBeGreaterThanOrEqual(0)
    expect(chest).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Bodyweight-bearing load: added weight reads as MORE load than pure bodyweight
// (body mass + added), and null = pure bodyweight — not a flat sub-bodyweight
// proxy that used to invert the two.
// ---------------------------------------------------------------------------

describe('bodyweight-bearing effective load', () => {
  // Heel Walk: equipment='bodyweight' → body IS the resistance; a logged weight
  // is ADDED load on top (e.g. dumbbells). tibialis so it lands in legs.
  const HEEL = exercise({
    id: 'heel',
    name: 'Heel Walk',
    body_part: 'legs',
    primary_muscles: ['tibialis'],
    secondary_muscles: [],
    equipment: 'bodyweight',
    mechanics: 'isolation',
    movement_pattern: 'carry'
  })
  const BW: { date: string; weightKg: number }[] = [{ date: '2026-05-01', weightKg: 90 }]

  // Prior weeks of pure-bodyweight heel walks so ref30 is well-defined (a single
  // isolated set can't distinguish loads — the ref falls back to the set's own
  // load and the magnitude cancels; that's the model's relative design).
  const bwHistory = (): GymSession[] => [
    session('2026-06-20T09:00:00.000Z', [set({ exercise_id: 'heel', reps: 20, weight_kg: null })]),
    session('2026-06-27T09:00:00.000Z', [set({ exercise_id: 'heel', reps: 20, weight_kg: null })]),
    session('2026-07-04T09:00:00.000Z', [set({ exercise_id: 'heel', reps: 20, weight_kg: null })]),
    session('2026-07-09T09:00:00.000Z', [set({ exercise_id: 'heel', reps: 20, weight_kg: null })])
  ]

  const tibialisFatigue = (finalWeight: number | null, bodyWeightSeries = BW): number => {
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [
          ...bwHistory(),
          session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'heel', reps: 20, weight_kg: finalWeight })])
        ],
        exercisesById: mapOf(HEEL),
        bodyWeightSeries,
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    return muscleDetail(groupBy(res, 'legs'), 'tibialis').fatigue
  }

  it('the core fix: adding 12kg reads as MORE load than pure bodyweight (no inversion)', () => {
    // The exact bug from the diagnosis: with a bodyweight history, a +12kg set
    // used to deposit LESS than a bodyweight set (12 < BW_PROXY 40). Now the
    // weighted set (90+12) beats the bodyweight set (90).
    const bodyweight = tibialisFatigue(null)
    const plus12 = tibialisFatigue(12)
    expect(plus12).toBeGreaterThan(bodyweight)
  })

  it('is monotone in added weight: +12kg > +6kg > bodyweight', () => {
    const bw = tibialisFatigue(null)
    const plus6 = tibialisFatigue(6)
    const plus12 = tibialisFatigue(12)
    expect(plus6).toBeGreaterThan(bw)
    expect(plus12).toBeGreaterThan(plus6)
  })

  it('null weight counts the body mass, not a flat proxy (registers real load)', () => {
    // A single pure-bodyweight heel walk deposits load into tibialis and clears
    // the low-data flag — it is no longer invisible.
    const res = computeMuscleFatigue(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'heel', reps: 20, weight_kg: null })])],
        exercisesById: mapOf(HEEL),
        bodyWeightSeries: BW,
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const tib = muscleDetail(groupBy(res, 'legs'), 'tibialis')
    expect(tib.fatigue).toBeGreaterThan(0)
    expect(tib.lowData).toBe(false)
  })

  it('uses the body mass as of each session date (a heavier body today = more relative load)', () => {
    // History logged while at 80kg; today weighed either 80 or 95. Same set, but
    // the 95kg-today body deposits more relative to the 80kg ref30 history.
    const runToday = (todayKg: number): number => {
      const series = [
        { date: '2026-06-01', weightKg: 80 },
        { date: '2026-07-10', weightKg: todayKg }
      ]
      return tibialisFatigue(null, series)
    }
    expect(runToday(95)).toBeGreaterThan(runToday(80))
  })

  it('does not touch external-load exercises: bodyweight series is irrelevant to a barbell lift', () => {
    // BENCH is equipment=null (not bodyweight-bearing) → weight_kg is the whole
    // load; supplying a body-mass series must not change its fatigue at all.
    const bench = (bodyWeightSeries?: { date: string; weightKg: number }[]): number => {
      const res = computeMuscleFatigue(
        baseInput({
          sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 8, weight_kg: 80 })])],
          exercisesById: mapOf(BENCH),
          bodyWeightSeries,
          asOf: new Date('2026-07-12T20:00:00.000Z')
        })
      )
      return muscleDetail(groupBy(res, 'chest'), 'chest').fatigue
    }
    expect(bench(BW)).toBeCloseTo(bench(undefined), 12)
  })

  it('classifies bodyweight-bearing exercises from the equipment tag alone', () => {
    expect(isBodyweightBearing(HEEL)).toBe(true)
    expect(isBodyweightBearing(exercise({ id: 'x', equipment: '  BodyWeight ' }))).toBe(true) // trim + case
    expect(isBodyweightBearing(BENCH)).toBe(false) // equipment null
    expect(isBodyweightBearing(exercise({ id: 'm', equipment: 'machine' }))).toBe(false)
    expect(isBodyweightBearing(undefined)).toBe(false)
  })

  it('with no body-mass reading at all, the fallback still makes added weight monotone', () => {
    // Omit the series entirely → bodyWeightFallbackKg. The user's core property
    // (added weight > bodyweight) must still hold on the fallback mass.
    const bw = tibialisFatigue(null, [])
    const plus12 = tibialisFatigue(12, [])
    expect(plus12).toBeGreaterThan(bw)
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
    console.log('\n[scenario] Muscle load & fatigue — Sun 2026-07-12, aerobic base 45:\n' + lines.join('\n') + '\n')
    expect(ranked.length).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// Isometric holds. Time-counted sets used to deposit ZERO fatigue — a 45-second
// wall sit and a rest day were identical to the model, which is the wrong
// direction for a rehab plan built on isometrics.
// ---------------------------------------------------------------------------

const WALL_SIT = exercise({
  id: 'wall-sit',
  name: 'Wall Sit',
  body_part: 'legs',
  primary_muscles: ['quadriceps'],
  secondary_muscles: ['glutes'],
  equipment: 'bodyweight',
  mechanics: 'isolation',
  movement_pattern: 'squat'
})

describe('isometricRepEquivalents', () => {
  const KNEE_T = MUSCLE_FATIGUE_PARAMS.iso.jointReferenceSeconds.knee

  it('converts a hold to rep-equivalents on the saturating curve for its joint', () => {
    // T·(1 − e^(−t/T)) / 3 s per rep, knee T = 71 s (Frey Law & Avin at 50% MVC).
    expect(isometricRepEquivalents(30, KNEE_T)).toBeCloseTo((KNEE_T * (1 - Math.exp(-30 / KNEE_T))) / 3, 6)
    expect(isometricRepEquivalents(45, KNEE_T)).toBeCloseTo(11.11, 1)
  })

  it('is monotonic in duration — a longer hold never counts for less', () => {
    const durations = [5, 15, 30, 45, 60, 90, 120, 300, 900]
    const values = durations.map((d) => isometricRepEquivalents(d, KNEE_T))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })

  it('saturates, so a very long hold cannot run away with the load budget', () => {
    // A hold sustainable for minutes is necessarily at a low %MVC, so later
    // seconds are cheaper. Linear would make a 5-min plank 100 rep-equivalents.
    const asymptote = KNEE_T / MUSCLE_FATIGUE_PARAMS.iso.secondsPerRepEquivalent
    expect(isometricRepEquivalents(300, KNEE_T)).toBeLessThan(asymptote)
    expect(isometricRepEquivalents(3600, KNEE_T)).toBeLessThanOrEqual(asymptote)
  })

  it('is near-linear at short durations, where saturation has barely bitten', () => {
    const linear = 10 / MUSCLE_FATIGUE_PARAMS.iso.secondsPerRepEquivalent
    expect(isometricRepEquivalents(10, KNEE_T)).toBeGreaterThan(linear * 0.9)
    expect(isometricRepEquivalents(10, KNEE_T)).toBeLessThan(linear)
  })

  it('scales the same hold by the joint reference it is given', () => {
    // The whole point of the joint table: 45 s at the ankle (T = 145 s, the
    // most fatigue-resistant joint) is a smaller fraction of capacity than the
    // same 45 s at the shoulder (T = 53 s), so it counts for MORE raw seconds
    // before saturation bites.
    const J = MUSCLE_FATIGUE_PARAMS.iso.jointReferenceSeconds
    expect(isometricRepEquivalents(45, J.ankle)).toBeGreaterThan(isometricRepEquivalents(45, J.knee))
    expect(isometricRepEquivalents(45, J.knee)).toBeGreaterThan(isometricRepEquivalents(45, J.shoulder))
  })

  it('defaults to the general (pooled) reference when none is supplied', () => {
    const general = MUSCLE_FATIGUE_PARAMS.iso.jointReferenceSeconds.general
    expect(isometricRepEquivalents(45)).toBeCloseTo(isometricRepEquivalents(45, general), 10)
  })

  it('returns 0 for a non-positive or malformed duration rather than negative load', () => {
    expect(isometricRepEquivalents(0, KNEE_T)).toBe(0)
    expect(isometricRepEquivalents(-30, KNEE_T)).toBe(0)
    expect(isometricRepEquivalents(Number.NaN, KNEE_T)).toBe(0)
  })

  it('falls back rather than dividing by a nonsense reference', () => {
    expect(isometricRepEquivalents(45, 0)).toBeCloseTo(isometricRepEquivalents(45), 10)
    expect(isometricRepEquivalents(45, -5)).toBeCloseTo(isometricRepEquivalents(45), 10)
  })
})

describe('isoJointOf', () => {
  it('reads the joint from an exercise\'s primary muscles', () => {
    expect(isoJointOf(exercise({ id: 'a', primary_muscles: ['quadriceps'] }))).toBe('knee')
    expect(isoJointOf(exercise({ id: 'b', primary_muscles: ['calves'] }))).toBe('ankle')
    expect(isoJointOf(exercise({ id: 'c', primary_muscles: ['abs'] }))).toBe('trunk')
    expect(isoJointOf(exercise({ id: 'd', primary_muscles: ['side delts'] }))).toBe('shoulder')
  })

  it('falls back to general when the primaries straddle joints, rather than picking one', () => {
    expect(isoJointOf(exercise({ id: 'e', primary_muscles: ['quadriceps', 'side delts'] }))).toBe('general')
  })

  it('falls back to general for an exercise with no muscle metadata', () => {
    expect(isoJointOf(exercise({ id: 'f', primary_muscles: [] }))).toBe('general')
    expect(isoJointOf(undefined)).toBe('general')
  })

  it('maps arms to general — no published joint fit to borrow', () => {
    expect(isoJointOf(exercise({ id: 'g', primary_muscles: ['biceps'] }))).toBe('general')
  })
})

describe('isometricReferenceSeconds', () => {
  const KNEE = exercise({ id: 'k', primary_muscles: ['quadriceps'] })
  const ISO = MUSCLE_FATIGUE_PARAMS.iso

  it('uses the joint literature value when there is no personal history', () => {
    expect(isometricReferenceSeconds(KNEE, [])).toBe(ISO.jointReferenceSeconds.knee)
  })

  it('keeps the literature value until the history gate is met', () => {
    const thin = Array.from({ length: ISO.minHistoryHolds - 1 }, () => 120)
    expect(isometricReferenceSeconds(KNEE, thin)).toBe(ISO.jointReferenceSeconds.knee)
  })

  it('switches to the user\'s own demonstrated capacity once history exists', () => {
    // Someone who routinely holds ~120 s has a different curve from the pooled
    // fit, and their own data is the better evidence about them.
    const holds = [110, 115, 120, 118, 122]
    const ref = isometricReferenceSeconds(KNEE, holds)
    expect(ref).toBeGreaterThan(ISO.jointReferenceSeconds.knee)
    expect(ref).toBeLessThanOrEqual(122)
  })

  it('clamps a personal reference so one mis-logged hold cannot rewrite the scale', () => {
    expect(isometricReferenceSeconds(KNEE, [7200, 7200, 7200, 7200])).toBe(ISO.maxReferenceSeconds)
    expect(isometricReferenceSeconds(KNEE, [2, 3, 2, 3])).toBe(ISO.minReferenceSeconds)
  })
})

describe('setRepEquivalents', () => {
  it('reads a rep-counted set by its reps', () => {
    expect(setRepEquivalents({ reps: 8, duration_s: null })).toBe(8)
  })

  it('reads a time-counted set through the hold conversion', () => {
    expect(setRepEquivalents({ reps: null, duration_s: 45 })).toBeCloseTo(
      isometricRepEquivalents(45),
      10
    )
  })

  it('passes a supplied reference through to the hold conversion', () => {
    const ankle = MUSCLE_FATIGUE_PARAMS.iso.jointReferenceSeconds.ankle
    expect(setRepEquivalents({ reps: null, duration_s: 45 }, ankle)).toBeCloseTo(
      isometricRepEquivalents(45, ankle),
      10
    )
  })

  it('treats a set carrying neither measure as no dose', () => {
    expect(setRepEquivalents({ reps: null, duration_s: null })).toBe(0)
  })
})

describe('isometric holds in the fatigue model', () => {
  const asOf = new Date('2026-07-12T20:00:00.000Z')
  const holdInput = (durationS: number): MuscleFatigueInput =>
    baseInput({
      sessions: [
        session('2026-07-12T09:00:00.000Z', [
          set({ exercise_id: 'wall-sit', reps: null, duration_s: durationS, weight_kg: null })
        ])
      ],
      exercisesById: mapOf(WALL_SIT),
      asOf
    })

  it('deposits real quadriceps load — the zero-load bug this fixes', () => {
    const res = computeMuscleFatigue(holdInput(45))
    expect(muscleDetail(groupBy(res, 'legs'), 'quadriceps').fatigue).toBeGreaterThan(0)
  })

  it('scales with hold duration', () => {
    const short = muscleDetail(groupBy(computeMuscleFatigue(holdInput(20)), 'legs'), 'quadriceps')
    const long = muscleDetail(groupBy(computeMuscleFatigue(holdInput(60)), 'legs'), 'quadriceps')
    expect(long.fatigue).toBeGreaterThan(short.fatigue)
  })

  it('costs less than dynamic work of the same rep-equivalent dose', () => {
    // A hold has no lengthening-under-load phase; eccentric actions drive most
    // exercise-induced damage, and isometric sessions recover markedly faster.
    const holdReps = isometricRepEquivalents(45)
    const hold = computeMuscleFatigue(holdInput(45))
    const dynamic = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'wall-sit', reps: holdReps, duration_s: null, weight_kg: null })
          ])
        ],
        exercisesById: mapOf(WALL_SIT),
        asOf
      })
    )
    const holdFatigue = muscleDetail(groupBy(hold, 'legs'), 'quadriceps').fatigue
    const dynamicFatigue = muscleDetail(groupBy(dynamic, 'legs'), 'quadriceps').fatigue
    expect(holdFatigue).toBeLessThan(dynamicFatigue)
    // Near the stimulus multiplier, not exactly it: fatigue is a saturating
    // function of deposited stimulus, so the ratio of outcomes is slightly
    // compressed relative to the ratio of inputs.
    expect(holdFatigue / dynamicFatigue).toBeCloseTo(MUSCLE_FATIGUE_PARAMS.iso.stimulusMultiplier, 1)
  })

  it('still counts as one working set in descriptive volume', () => {
    // The set-count layer was never rep-based, so a hold has always been a set
    // there — the discount applies to the fatigue stimulus only.
    const res = computeMuscleFatigue(holdInput(45))
    expect(groupBy(res, 'legs').volumeWeekSets).toBeGreaterThan(0)
  })

  it('credits secondary muscles at the usual share', () => {
    const legs = groupBy(computeMuscleFatigue(holdInput(45)), 'legs')
    const quads = muscleDetail(legs, 'quadriceps').fatigue
    const glutes = muscleDetail(legs, 'glutes').fatigue
    expect(glutes).toBeGreaterThan(0)
    expect(glutes).toBeLessThan(quads)
  })

  it('does not double-count an eccentric flag on a hold', () => {
    // A hold cannot also be an eccentric action; the isometric factor wins.
    const plain = computeMuscleFatigue(holdInput(45))
    const flagged = computeMuscleFatigue(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({
              exercise_id: 'wall-sit',
              reps: null,
              duration_s: 45,
              weight_kg: null,
              is_eccentric: true
            })
          ])
        ],
        exercisesById: mapOf(WALL_SIT),
        asOf
      })
    )
    expect(muscleDetail(groupBy(flagged, 'legs'), 'quadriceps').fatigue).toBeCloseTo(
      muscleDetail(groupBy(plain, 'legs'), 'quadriceps').fatigue,
      10
    )
  })

  it('leaves a plank-length hold well below a heavy compound session', () => {
    // The saturation guard, end to end: 5 minutes of core holds must not
    // out-fatigue five heavy squat sets.
    const plank = computeMuscleFatigue(holdInput(300))
    const squats = computeMuscleFatigue(
      baseInput({
        sessions: [
          session(
            '2026-07-12T09:00:00.000Z',
            Array.from({ length: 5 }, () =>
              set({ exercise_id: 'wall-sit', reps: 10, duration_s: null, weight_kg: null })
            )
          )
        ],
        exercisesById: mapOf(WALL_SIT),
        asOf
      })
    )
    expect(muscleDetail(groupBy(plank, 'legs'), 'quadriceps').fatigue).toBeLessThan(
      muscleDetail(groupBy(squats, 'legs'), 'quadriceps').fatigue
    )
  })
})

describe('sharpened isometric load: personal scale and hold intensity', () => {
  const asOf = new Date('2026-07-20T20:00:00.000Z')

  const holdSession = (day: string, seconds: number) =>
    session(`2026-07-${day}T09:00:00.000Z`, [
      set({ exercise_id: 'wall-sit', reps: null, duration_s: seconds, weight_kg: null })
    ])

  const quadFatigue = (sessions: GymSession[]): number =>
    muscleDetail(
      groupBy(
        computeMuscleFatigue(baseInput({ sessions, exercisesById: mapOf(WALL_SIT), asOf })),
        'legs'
      ),
      'quadriceps'
    ).fatigue

  it('rates a hold above the personal norm harder than one below it', () => {
    // The mechanism that was dead before: a bodyweight hold has no weight_kg,
    // so relIntensityFactor sat at a flat 1.0 and the model could not tell a
    // near-limit hold from an easy one. Duration is the intensity signal.
    const history = ['13', '15', '17'].map((d) => holdSession(d, 40))
    const easy = quadFatigue([...history, holdSession('20', 20)])
    const hard = quadFatigue([...history, holdSession('20', 80)])
    expect(hard).toBeGreaterThan(easy)
  })

  it('reads the same absolute hold differently against different personal norms', () => {
    // 60 s is a hard set for someone whose norm is 30 s and an easy one for
    // someone whose norm is 120 s. Same seconds, different meaning.
    const lowNorm = ['13', '15', '17'].map((d) => holdSession(d, 30))
    const highNorm = ['13', '15', '17'].map((d) => holdSession(d, 120))
    const forLowNorm = quadFatigue([...lowNorm, holdSession('20', 60)])
    const forHighNorm = quadFatigue([...highNorm, holdSession('20', 60)])
    // The high-norm athlete's own capacity also rescales saturation, so this
    // asserts only that the two are genuinely distinguished.
    expect(forLowNorm).not.toBeCloseTo(forHighNorm, 6)
  })

  it('still produces a finite, bounded stimulus with no history at all', () => {
    const cold = quadFatigue([holdSession('20', 45)])
    expect(cold).toBeGreaterThan(0)
    expect(Number.isFinite(cold)).toBe(true)
  })

  it('routes a knee hold through the knee reference, not the pooled one', () => {
    // WALL_SIT's primary is quadriceps → knee (T = 71 s), which is shorter than
    // the pooled general reference (86 s), so the same hold saturates sooner.
    expect(isoJointOf(WALL_SIT)).toBe('knee')
    const J = MUSCLE_FATIGUE_PARAMS.iso.jointReferenceSeconds
    expect(isometricRepEquivalents(45, J.knee)).toBeLessThan(isometricRepEquivalents(45, J.general))
  })
})

describe('relIntensityFactor with holds', () => {
  const hold = (seconds: number): GymSet =>
    set({ reps: null, duration_s: seconds, weight_kg: null })

  it('stays neutral until there is enough hold history', () => {
    expect(relIntensityFactor(hold(60), [], [30])).toBe(1)
  })

  it('scales a hold by its duration against the personal median', () => {
    const R = MUSCLE_FATIGUE_PARAMS.relIntensity
    // Ratios beyond the bounds clamp, exactly as on the weight path: doubling
    // your usual hold is capped at max, halving it floored at min.
    expect(relIntensityFactor(hold(60), [], [30, 30, 30, 30])).toBe(R.max)
    expect(relIntensityFactor(hold(15), [], [30, 30, 30, 30])).toBe(R.min)
    // Inside the bounds the ratio passes through untouched.
    expect(relIntensityFactor(hold(36), [], [30, 30, 30, 30])).toBeCloseTo(1.2, 5)
    expect(relIntensityFactor(hold(24), [], [30, 30, 30, 30])).toBeCloseTo(0.8, 5)
  })

  it('clamps to the same bounds as the weighted path', () => {
    const R = MUSCLE_FATIGUE_PARAMS.relIntensity
    expect(relIntensityFactor(hold(6000), [], [30, 30, 30, 30])).toBe(R.max)
    expect(relIntensityFactor(hold(1), [], [300, 300, 300, 300])).toBe(R.min)
  })

  it('leaves rep-counted sets on the weight path, untouched by hold history', () => {
    const weighted = set({ reps: 10, duration_s: null, weight_kg: 100 })
    // 100 kg against an 50 kg norm → clamped max, and the hold history beside
    // it changes nothing.
    expect(relIntensityFactor(weighted, [50, 50, 50, 50], [30, 30, 30, 30])).toBe(
      MUSCLE_FATIGUE_PARAMS.relIntensity.max
    )
    expect(relIntensityFactor(weighted, [90, 90, 90, 90], [30, 30, 30, 30])).toBeCloseTo(100 / 90, 5)
  })
})

// The tibialis bug (20260722120000) and the rotator-cuff/serratus one
// (agent_log #22) had the same shape: a muscle that exists in the vocabulary
// but belongs to no group deposits stimulus nothing ever rolls up, and nothing
// errors to say so. These lock the vocabulary and its rollup together.
describe('muscle vocabulary completeness', () => {
  it('rolls every muscle up into at least one group', () => {
    const grouped = new Set(
      MUSCLE_GROUPS.flatMap((group) => Object.keys(GROUP_MEMBERSHIP[group]))
    )
    expect(MUSCLES.filter((muscle) => !grouped.has(muscle))).toEqual([])
  })

  it('gives every muscle a total group membership of exactly 1', () => {
    for (const muscle of MUSCLES) {
      const total = MUSCLE_GROUPS.reduce(
        (sum, group) => sum + (GROUP_MEMBERSHIP[group][muscle] ?? 0),
        0
      )
      expect([muscle, total]).toEqual([muscle, 1])
    }
  })

  it('references no muscle outside the vocabulary in any group', () => {
    const vocab = new Set<string>(MUSCLES)
    for (const group of MUSCLE_GROUPS) {
      for (const muscle of Object.keys(GROUP_MEMBERSHIP[group])) {
        expect([group, muscle, vocab.has(muscle)]).toEqual([group, muscle, true])
      }
    }
  })

  it('carries the shoulder-stabilizer additions that cuff rehab needs', () => {
    // Without these, cuff and scapular work lands on the delts and inflates
    // rear/front-delt volume with rehab that is not delt training.
    expect(MUSCLES).toContain('rotator cuff')
    expect(MUSCLES).toContain('serratus')
    expect(GROUP_MEMBERSHIP.shoulders['rotator cuff']).toBe(1)
    expect(MUSCLE_ISO_JOINT['rotator cuff']).toBe('shoulder')
  })
})
