import { describe, it, expect } from 'vitest'
import type { Exercise, GymSession, GymSet } from '@shared/types'
import {
  computeStrengthLevels,
  STRENGTH_PARAMS,
  type StrengthInput,
  type StrengthGroup,
  type StrengthResult
} from '../strengthLevel'
import type { MuscleGroup } from '../muscleFatigue'

// ---------------------------------------------------------------------------
// Fixture factories (mirrors muscleFatigue.test.ts's fully-nulled-type +
// Partial-overrides pattern).
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

// Catalog exercises used across tests.
const BENCH = exercise({
  id: 'bench',
  name: 'Barbell Bench Press',
  body_part: 'chest',
  primary_muscles: ['chest'],
  secondary_muscles: ['front delts', 'triceps']
})
const INCLINE = exercise({
  id: 'incline',
  name: 'Incline Bench Press',
  body_part: 'chest',
  primary_muscles: ['chest'],
  secondary_muscles: ['front delts']
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
const PULLUP = exercise({
  id: 'pullup',
  name: 'Pull-up',
  body_part: 'back',
  primary_muscles: ['lats'],
  secondary_muscles: ['biceps']
})

const TZ = 'UTC'

function baseInput(overrides: Partial<StrengthInput> = {}): StrengthInput {
  return {
    sessions: [],
    exercisesById: new Map(),
    timezone: TZ,
    asOf: new Date('2026-07-12T12:00:00.000Z'),
    ...overrides
  }
}

function groupBy(result: StrengthResult, g: MuscleGroup): StrengthGroup {
  const found = result.groups.find((x) => x.group === g)
  if (!found) throw new Error(`group ${g} missing from result`)
  return found
}

const GROUPS: MuscleGroup[] = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core']

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

describe('output shape', () => {
  it('returns exactly the 6 anatomical groups, never a full body group', () => {
    const res = computeStrengthLevels(baseInput())
    const names = res.groups.map((g) => g.group).sort()
    expect(names).toEqual([...GROUPS].sort())
    expect(res.groups.map((g) => g.group)).not.toContain('full body')
  })

  it('clamps every currentPct into [0,100]', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'squat', reps: 5, weight_kg: 150 })])],
        exercisesById: mapOf(SQUAT)
      })
    )
    for (const g of res.groups) {
      expect(g.currentPct).toBeGreaterThanOrEqual(0)
      expect(g.currentPct).toBeLessThanOrEqual(100)
    }
  })
})

describe('benchmark comparisons', () => {
  it('uses an external bodyweight-indexed reference instead of treating a personal peak as 100%', () => {
    const input = {
      ...baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 80 })])],
        exercisesById: mapOf(BENCH)
      }),
      bodyWeightKg: 80
    } as StrengthInput & { bodyWeightKg: number }

    const chest = groupBy(computeStrengthLevels(input), 'chest') as StrengthGroup & {
      benchmarkE1RM: number | null
      benchmarkPct: number | null
      benchmarkName: string | null
    }

    expect(chest.benchmarkName).toBe('Bench press')
    expect(chest.benchmarkE1RM).toBe(80)
    expect(chest.benchmarkPct).toBeCloseTo(116.67, 2)
  })
})

// ---------------------------------------------------------------------------
// Epley e1RM math
// ---------------------------------------------------------------------------

describe('Epley e1RM', () => {
  it('computes e1RM = weight * (1 + reps/30) for a single qualifying set', () => {
    // 100kg x 5 reps -> 100 * (1 + 5/30) = 116.666...
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 100 })])],
        exercisesById: mapOf(BENCH)
      })
    )
    const chest = groupBy(res, 'chest')
    const expected = 100 * (1 + 5 / 30)
    expect(chest.currentE1RM).toBeCloseTo(expected, 6)
    expect(chest.peakE1RM).toBeCloseTo(expected, 6)
    expect(chest.currentPct).toBeCloseTo(100, 6)
  })

  it('takes the MAX e1RM among several sets of the same exercise', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'bench', reps: 10, weight_kg: 80 }), // e1RM 106.67
            set({ exercise_id: 'bench', reps: 3, weight_kg: 110 }), // e1RM 121.0 <- max
            set({ exercise_id: 'bench', reps: 8, weight_kg: 85 }) // e1RM 107.67
          ])
        ],
        exercisesById: mapOf(BENCH)
      })
    )
    const chest = groupBy(res, 'chest')
    expect(chest.peakE1RM).toBeCloseTo(110 * (1 + 3 / 30), 6)
  })
})

// ---------------------------------------------------------------------------
// Exclusions: warmup sets and bodyweight sets
// ---------------------------------------------------------------------------

describe('exclusions', () => {
  it('excludes warmup sets from e1RM computation', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'bench', reps: 5, weight_kg: 200, is_warmup: true }), // would dominate if counted
            set({ exercise_id: 'bench', reps: 5, weight_kg: 100, is_warmup: false })
          ])
        ],
        exercisesById: mapOf(BENCH)
      })
    )
    const chest = groupBy(res, 'chest')
    expect(chest.peakE1RM).toBeCloseTo(100 * (1 + 5 / 30), 6)
  })

  it('excludes bodyweight sets (weight_kg null)', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'pullup', reps: 12, weight_kg: null }) // bodyweight, no external load
          ])
        ],
        exercisesById: mapOf(PULLUP)
      })
    )
    const back = groupBy(res, 'back')
    expect(back.lowData).toBe(true)
    expect(back.currentE1RM).toBeNull()
    expect(back.peakE1RM).toBeNull()
    expect(back.currentPct).toBe(0)
  })

  it('excludes bodyweight sets (weight_kg 0)', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'pullup', reps: 12, weight_kg: 0 })])],
        exercisesById: mapOf(PULLUP)
      })
    )
    const back = groupBy(res, 'back')
    expect(back.lowData).toBe(true)
  })

  it('a weighted set still counts even when other sets in the same session are bodyweight/warmup', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'pullup', reps: 12, weight_kg: null }),
            set({ exercise_id: 'pullup', reps: 3, weight_kg: 5, is_warmup: true }),
            set({ exercise_id: 'pullup', reps: 5, weight_kg: 20, is_warmup: false })
          ])
        ],
        exercisesById: mapOf(PULLUP)
      })
    )
    const back = groupBy(res, 'back')
    expect(back.lowData).toBe(false)
    expect(back.peakE1RM).toBeCloseTo(20 * (1 + 5 / 30), 6)
  })
})

// ---------------------------------------------------------------------------
// current (this calendar month) vs peak (all-time) — detraining case
// ---------------------------------------------------------------------------

describe('current vs peak', () => {
  it('a detraining case: heavier lift last month, lighter this month -> currentPct < 100 and currentE1RM < peakE1RM', () => {
    // asOf July 12 2026. Last month (June) hit a heavy top set; this month
    // (July) only a lighter set so far.
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-06-15T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 3, weight_kg: 120 })]), // peak
          session('2026-07-05T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 8, weight_kg: 90 })]) // current (weaker)
        ],
        exercisesById: mapOf(BENCH),
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const chest = groupBy(res, 'chest')
    const peak = 120 * (1 + 3 / 30)
    const current = 90 * (1 + 8 / 30)
    expect(chest.peakE1RM).toBeCloseTo(peak, 6)
    expect(chest.currentE1RM).toBeCloseTo(current, 6)
    expect(chest.currentE1RM!).toBeLessThan(chest.peakE1RM!)
    expect(chest.currentPct).toBeLessThan(100)
    expect(chest.currentPct).toBeCloseTo((current / peak) * 100, 6)
  })

  it('currentE1RM is 0/null-driven when nothing was logged this calendar month (peak still known)', () => {
    // Only logged two months ago; nothing in the current month.
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-05-10T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 100 })])],
        exercisesById: mapOf(BENCH),
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const chest = groupBy(res, 'chest')
    expect(chest.peakE1RM).toBeCloseTo(100 * (1 + 5 / 30), 6)
    expect(chest.currentE1RM).toBeNull()
    expect(chest.currentPct).toBe(0)
  })

  it('respects timezone boundaries for "this calendar month"', () => {
    // asOf is July 1st 00:30 UTC. In a timezone behind UTC (e.g. -02:00), that
    // instant is still June 30th locally, so a set logged at that exact instant
    // should NOT count as "this month" under that timezone.
    const asOf = new Date('2026-07-01T00:30:00.000Z')
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-07-01T00:30:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 100 })])],
        exercisesById: mapOf(BENCH),
        timezone: 'Etc/GMT+2', // UTC-2
        asOf
      })
    )
    const chest = groupBy(res, 'chest')
    // Local date of both the set and asOf is June 30 in this timezone -> matches.
    expect(chest.currentE1RM).not.toBeNull()
  })

  it('a set logged on the last day of the previous month (local) does not count as current', () => {
    const asOf = new Date('2026-07-01T12:00:00.000Z') // clearly July 1 in UTC
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-06-30T23:00:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 100 })])],
        exercisesById: mapOf(BENCH),
        timezone: 'UTC',
        asOf
      })
    )
    const chest = groupBy(res, 'chest')
    expect(chest.currentE1RM).toBeNull()
    expect(chest.peakE1RM).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Representative exercise = strongest peak lift in the group
// ---------------------------------------------------------------------------

describe('group representative', () => {
  it('the group representative is the exercise with the highest peakE1RM', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-06-01T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 100 })]), // e1RM 116.67
          session('2026-06-01T09:05:00.000Z', [set({ exercise_id: 'incline', reps: 5, weight_kg: 130 })]) // e1RM 151.67 <- stronger
        ],
        exercisesById: mapOf(BENCH, INCLINE)
      })
    )
    const chest = groupBy(res, 'chest')
    const inclineE1RM = 130 * (1 + 5 / 30)
    expect(chest.peakE1RM).toBeCloseTo(inclineE1RM, 6)
    // exercises[] lists both lifts, sorted by peakE1RM desc.
    expect(chest.exercises.map((e) => e.exerciseId)).toEqual(['incline', 'bench'])
    expect(chest.exercises[0].peakE1RM).toBeCloseTo(inclineE1RM, 6)
  })

  it('the group currentE1RM/currentPct come from the representative lift, not just any lift', () => {
    // Incline is the stronger all-time lift (representative). This month, incline
    // was only trained lightly while bench was trained heavy — the group's
    // current numbers must track incline (the representative), not bench.
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-06-01T09:00:00.000Z', [set({ exercise_id: 'incline', reps: 5, weight_kg: 130 })]), // incline peak (e1RM 151.67)
          session('2026-07-10T09:00:00.000Z', [set({ exercise_id: 'incline', reps: 10, weight_kg: 60 })]), // incline current (weak, e1RM 80)
          session('2026-07-10T09:10:00.000Z', [set({ exercise_id: 'bench', reps: 3, weight_kg: 100 })]) // bench current (e1RM 110, still below incline's peak -> not representative)
        ],
        exercisesById: mapOf(BENCH, INCLINE),
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const chest = groupBy(res, 'chest')
    const inclinePeak = 130 * (1 + 5 / 30)
    const inclineCurrent = 60 * (1 + 10 / 30)
    expect(chest.peakE1RM).toBeCloseTo(inclinePeak, 6)
    expect(chest.currentE1RM).toBeCloseTo(inclineCurrent, 6)
    expect(chest.currentPct).toBeCloseTo((inclineCurrent / inclinePeak) * 100, 6)
  })
})

// ---------------------------------------------------------------------------
// Full-body exercise distribution
// ---------------------------------------------------------------------------

describe('full-body exercise distribution', () => {
  it('a full-body-tagged lift distributes into the groups of its primary muscles via GROUP_MEMBERSHIP, no full body group', () => {
    const THRUSTER = exercise({
      id: 'thruster',
      name: 'Thruster',
      body_part: 'full body',
      primary_muscles: ['quadriceps', 'front delts'],
      secondary_muscles: ['glutes', 'triceps'] // secondary ignored for strength
    })
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'thruster', reps: 6, weight_kg: 60 })])],
        exercisesById: mapOf(THRUSTER)
      })
    )
    expect(res.groups.map((g) => g.group)).not.toContain('full body')
    const legs = groupBy(res, 'legs') // owns quadriceps
    const shoulders = groupBy(res, 'shoulders') // owns front delts
    expect(legs.lowData).toBe(false)
    expect(shoulders.lowData).toBe(false)
    const e1rm = 60 * (1 + 6 / 30)
    expect(legs.peakE1RM).toBeCloseTo(e1rm, 6)
    expect(shoulders.peakE1RM).toBeCloseTo(e1rm, 6)

    // Secondary muscles (glutes, triceps) are ignored for strength: arms group
    // (which owns triceps) must NOT pick up the thruster.
    const arms = groupBy(res, 'arms')
    expect(arms.exercises.map((e) => e.exerciseId)).not.toContain('thruster')
  })

  it('a full-body lift with a primary muscle that has fractional group membership reaches both groups', () => {
    // rear delts has fractional membership: back 0.4, shoulders 0.6 (weight-agnostic
    // per spec: "a group has the lift if it owns any of its primary muscles").
    const FB_REAR = exercise({
      id: 'fbrear',
      name: 'Full Body Rear Delt Thing',
      body_part: 'full body',
      primary_muscles: ['rear delts'],
      secondary_muscles: []
    })
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'fbrear', reps: 10, weight_kg: 15 })])],
        exercisesById: mapOf(FB_REAR)
      })
    )
    expect(groupBy(res, 'back').exercises.map((e) => e.exerciseId)).toContain('fbrear')
    expect(groupBy(res, 'shoulders').exercises.map((e) => e.exerciseId)).toContain('fbrear')
  })
})

// ---------------------------------------------------------------------------
// lowData
// ---------------------------------------------------------------------------

describe('lowData', () => {
  it('a group with zero qualifying sets reads currentPct 0, null e1RMs, lowData true', () => {
    const res = computeStrengthLevels(baseInput()) // nothing logged
    for (const g of GROUPS) {
      const grp = groupBy(res, g)
      expect(grp.lowData).toBe(true)
      expect(grp.currentPct).toBe(0)
      expect(grp.currentE1RM).toBeNull()
      expect(grp.peakE1RM).toBeNull()
      expect(grp.exercises).toEqual([])
    }
  })

  it('a group with only warmup/bodyweight sets is still lowData (no qualifying sets)', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-07-12T09:00:00.000Z', [
            set({ exercise_id: 'bench', reps: 5, weight_kg: 100, is_warmup: true }),
            set({ exercise_id: 'pullup', reps: 12, weight_kg: null })
          ])
        ],
        exercisesById: mapOf(BENCH, PULLUP)
      })
    )
    expect(groupBy(res, 'chest').lowData).toBe(true)
    expect(groupBy(res, 'back').lowData).toBe(true)
  })

  it('one trained group does not affect an untrained sibling group', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-07-12T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 100 })])],
        exercisesById: mapOf(BENCH)
      })
    )
    expect(groupBy(res, 'chest').lowData).toBe(false)
    expect(groupBy(res, 'legs').lowData).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Per-exercise breakdown contract (exercises[])
// ---------------------------------------------------------------------------

describe('exercises[] breakdown', () => {
  it('lists each qualifying exercise with its own current/peak/pct, sorted by peakE1RM desc', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-06-01T09:00:00.000Z', [set({ exercise_id: 'squat', reps: 5, weight_kg: 140 })]),
          session('2026-07-10T09:00:00.000Z', [set({ exercise_id: 'squat', reps: 5, weight_kg: 130 })])
        ],
        exercisesById: mapOf(SQUAT),
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const legs = groupBy(res, 'legs')
    const squatEx = legs.exercises.find((e) => e.exerciseId === 'squat')
    expect(squatEx).toBeTruthy()
    expect(squatEx!.name).toBe('Back Squat')
    expect(squatEx!.peakE1RM).toBeCloseTo(140 * (1 + 5 / 30), 6)
    expect(squatEx!.currentE1RM).toBeCloseTo(130 * (1 + 5 / 30), 6)
    expect(squatEx!.currentPct).toBeCloseTo((squatEx!.currentE1RM! / squatEx!.peakE1RM!) * 100, 6)
  })

  it('an exercise with no current-month e1RM has currentPct 0 and currentE1RM null in its own row', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [session('2026-05-01T09:00:00.000Z', [set({ exercise_id: 'curl', reps: 10, weight_kg: 20 })])],
        exercisesById: mapOf(CURL),
        asOf: new Date('2026-07-12T12:00:00.000Z')
      })
    )
    const arms = groupBy(res, 'arms')
    const curlEx = arms.exercises.find((e) => e.exerciseId === 'curl')
    expect(curlEx!.currentE1RM).toBeNull()
    expect(curlEx!.currentPct).toBe(0)
    expect(curlEx!.peakE1RM).toBeCloseTo(20 * (1 + 10 / 30), 6)
  })
})

// ---------------------------------------------------------------------------
// STRENGTH_PARAMS exposes the formula choice
// ---------------------------------------------------------------------------

describe('STRENGTH_PARAMS', () => {
  it('is defined and exposes at least the e1RM formula choice', () => {
    expect(STRENGTH_PARAMS).toBeTruthy()
    expect(typeof STRENGTH_PARAMS).toBe('object')
  })
})

// ---------------------------------------------------------------------------
// Realistic end-to-end scenario (mock data)
// ---------------------------------------------------------------------------

describe('realistic training scenario (mock-data)', () => {
  it('a mixed PPL history yields sensible per-group current/peak/pct across multiple months', () => {
    const ROW = exercise({
      id: 'row',
      name: 'Barbell Row',
      body_part: 'back',
      primary_muscles: ['lats', 'upper back'],
      secondary_muscles: ['biceps']
    })
    const OHP = exercise({
      id: 'ohp',
      name: 'Overhead Press',
      body_part: 'shoulders',
      primary_muscles: ['front delts', 'side delts'],
      secondary_muscles: ['triceps']
    })
    const PLANK = exercise({
      id: 'plank',
      name: 'Plank',
      body_part: 'core',
      primary_muscles: ['abs'],
      secondary_muscles: []
    })
    const CAT = mapOf(BENCH, SQUAT, CURL, ROW, OHP, PLANK)

    const sessions: GymSession[] = [
      // May (older peak month)
      session('2026-05-05T18:00:00.000Z', [set({ exercise_id: 'bench', reps: 3, weight_kg: 115 })]),
      session('2026-05-12T18:00:00.000Z', [set({ exercise_id: 'squat', reps: 3, weight_kg: 160 })]),
      // June
      session('2026-06-03T18:00:00.000Z', [set({ exercise_id: 'row', reps: 6, weight_kg: 90 })]),
      session('2026-06-10T18:00:00.000Z', [set({ exercise_id: 'ohp', reps: 5, weight_kg: 55 })]),
      session('2026-06-17T18:00:00.000Z', [set({ exercise_id: 'plank', reps: 1, weight_kg: 20 })]), // weighted plank
      // July (current month, asOf July 12) — all lighter than their all-time peaks
      session('2026-07-03T18:00:00.000Z', [set({ exercise_id: 'bench', reps: 8, weight_kg: 90 })]),
      session('2026-07-05T18:00:00.000Z', [set({ exercise_id: 'squat', reps: 8, weight_kg: 130 })]),
      session('2026-07-08T18:00:00.000Z', [set({ exercise_id: 'curl', reps: 10, weight_kg: 22 })])
    ]

    const res = computeStrengthLevels(
      baseInput({
        sessions,
        exercisesById: CAT,
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )

    // chest/legs: trained this month but lighter than their May peak -> currentPct < 100.
    const chest = groupBy(res, 'chest')
    expect(chest.lowData).toBe(false)
    expect(chest.currentE1RM).not.toBeNull()
    expect(chest.currentPct).toBeLessThan(100)
    expect(chest.currentPct).toBeGreaterThan(0)

    const legs = groupBy(res, 'legs')
    expect(legs.currentPct).toBeLessThan(100)

    // back/shoulders/core: trained in June only, nothing in July -> currentPct 0 but has a peak.
    const back = groupBy(res, 'back')
    expect(back.lowData).toBe(false)
    expect(back.currentE1RM).toBeNull()
    expect(back.currentPct).toBe(0)
    expect(back.peakE1RM).not.toBeNull()

    // arms: trained only this month (curl) -> current == peak -> currentPct 100.
    const arms = groupBy(res, 'arms')
    expect(arms.currentPct).toBeCloseTo(100, 6)

    for (const g of res.groups) {
      expect(g.currentPct).toBeGreaterThanOrEqual(0)
      expect(g.currentPct).toBeLessThanOrEqual(100)
    }
  })

  it('[summary] prints the modeled Strength card for eyeballing', () => {
    const res = computeStrengthLevels(
      baseInput({
        sessions: [
          session('2026-06-01T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 110 })]),
          session('2026-07-08T09:00:00.000Z', [set({ exercise_id: 'bench', reps: 5, weight_kg: 100 })]),
          session('2026-06-01T09:10:00.000Z', [set({ exercise_id: 'squat', reps: 5, weight_kg: 150 })]),
          session('2026-07-08T09:10:00.000Z', [set({ exercise_id: 'squat', reps: 5, weight_kg: 150 })])
        ],
        exercisesById: mapOf(BENCH, SQUAT),
        asOf: new Date('2026-07-12T20:00:00.000Z')
      })
    )
    const lines = res.groups.map(
      (g) =>
        `  ${g.group.padEnd(10)} current ${(g.currentE1RM ?? 0).toFixed(1).padStart(6)} · peak ${(g.peakE1RM ?? 0)
          .toFixed(1)
          .padStart(6)} · pct ${g.currentPct.toFixed(0).padStart(3)}% · lowData ${g.lowData}`
    )
    // eslint-disable-next-line no-console
    console.log('\n[scenario] Strength level — Sun 2026-07-12:\n' + lines.join('\n') + '\n')
    expect(res.groups.length).toBe(6)
  })
})
