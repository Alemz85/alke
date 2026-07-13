// Strength Level model — pure functions.
//
// For each of the 6 anatomical groups (see muscleFatigue.ts for the group
// vocabulary and muscle->group rollup), the model keeps two deliberately
// separate readings: personal progression (current vs own peak) and a
// bodyweight-indexed reference benchmark for standardised free-weight lifts.
// The UI's headline uses the external reference; a personal peak is context,
// never the top of the scale.
//
// v1 has no aging/decay model and no cross-user norms — it is pure
// self-comparison. No DB schema, no backend: everything here runs client-side
// over data the app already loaded (mirrors lib/muscleFatigue.ts).
//
// No window.api / DOM access here: everything takes explicit data so it is
// unit-testable in isolation.

import type { Exercise, GymSession, GymSet } from '@shared/types'
import { GROUP_MEMBERSHIP, MUSCLE_GROUPS, type MuscleGroup } from './muscleFatigue'
import { toZonedYMD } from '../hooks/sessionsDate'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface StrengthInput {
  sessions: GymSession[] // logged gym sessions with sets, as much history as loaded
  exercisesById: Map<string, Exercise>
  timezone: string | null
  asOf: Date
  /** Latest valid body-mass reading. Required for bodyweight-indexed references. */
  bodyWeightKg?: number | null
}

export interface StrengthExercise {
  exerciseId: string
  name: string
  currentE1RM: number | null // best est-1RM this calendar month
  peakE1RM: number | null // best est-1RM all-time (in the loaded window)
  currentPct: number // 0-100 = currentE1RM / peakE1RM * 100 (0 if no current)
  benchmarkName: string | null
  benchmarkE1RM: number | null
  benchmarkPct: number | null // current e1RM / external reference, not capped
  peakBenchmarkPct: number | null
}

export interface StrengthGroup {
  group: MuscleGroup // one of the 6
  currentPct: number // 0-100: the group's representative lift's current/peak
  currentE1RM: number | null
  peakE1RM: number | null
  lowData: boolean // no weighted (non-bodyweight, non-warmup) sets for this group
  exercises: StrengthExercise[] // the group's lifts, for the expanded breakdown, sorted by peakE1RM desc
  benchmarkName: string | null
  benchmarkE1RM: number | null
  benchmarkPct: number | null
  peakBenchmarkPct: number | null
  benchmarkExercise: StrengthExercise | null
}

export interface StrengthResult {
  groups: StrengthGroup[]
}

// ---------------------------------------------------------------------------
// Constants — the e1RM formula choice, isolated as the single source of truth.
// ---------------------------------------------------------------------------

export const STRENGTH_PARAMS = {
  // Epley: e1RM = weight_kg * (1 + reps/30). GROUNDED (standard est-1RM
  // formula; matches the app's existing convention elsewhere for e1RM-style
  // estimates).
  epleyRepsDivisor: 30
} as const

/**
 * Standardised, bodyweight-indexed reference lifts. Machine-stack and
 * bodyweight movements are intentionally excluded: their loading is not
 * comparable across equipment or bodies, so the model shows an honest
 * unavailable benchmark instead of inventing one.
 */
export const STRENGTH_BENCHMARKS = {
  'bench press': { name: 'Bench press', bodyWeightRatio: 1 },
  'barbell bench press': { name: 'Bench press', bodyWeightRatio: 1 },
  'incline bench press': { name: 'Incline bench press', bodyWeightRatio: 0.9 },
  'back squat': { name: 'Back squat', bodyWeightRatio: 1.25 },
  'front squat': { name: 'Front squat', bodyWeightRatio: 1 },
  'barbell row': { name: 'Barbell row', bodyWeightRatio: 0.9 },
  'overhead press': { name: 'Overhead press', bodyWeightRatio: 0.6 },
  'barbell curl': { name: 'Barbell curl', bodyWeightRatio: 0.35 }
} as const
type StrengthBenchmark = (typeof STRENGTH_BENCHMARKS)[keyof typeof STRENGTH_BENCHMARKS]

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clampPct(x: number): number {
  if (x < 0) return 0
  if (x > 100) return 100
  return x
}

/** Epley est-1RM for a qualifying (weighted, non-warmup) set. */
function epley1RM(weightKg: number, reps: number): number {
  return weightKg * (1 + reps / STRENGTH_PARAMS.epleyRepsDivisor)
}

function benchmarkForExercise(name: string): StrengthBenchmark | null {
  return STRENGTH_BENCHMARKS[name.trim().toLowerCase() as keyof typeof STRENGTH_BENCHMARKS] ?? null
}

function benchmarkPercent(value: number | null, reference: number | null): number | null {
  if (value == null || reference == null || reference <= 0) return null
  return (value / reference) * 100
}

/** A set "qualifies" for strength level when it has external load and isn't a warmup. */
function isQualifyingSet(s: GymSet): boolean {
  if (s.is_warmup) return false
  if (s.weight_kg == null || s.weight_kg <= 0) return false
  const reps = s.reps ?? 0
  if (reps <= 0) return false
  return true
}

/**
 * Resolve which of the 6 anatomical groups an exercise's PRIMARY muscles map
 * to, with fractional weight. `body_part` is used directly when it is one of
 * the 6; a `full body` (or any other non-group) tag falls back to
 * distributing via primary_muscles through GROUP_MEMBERSHIP — weight-agnostic
 * (a group "has" the lift if it owns any of its primary muscles at all).
 * Secondary muscles are ignored: strength level is about the prime movers.
 */
function groupsForExercise(ex: Exercise): Set<MuscleGroup> {
  const groups = new Set<MuscleGroup>()
  if ((MUSCLE_GROUPS as string[]).includes(ex.body_part ?? '')) {
    groups.add(ex.body_part as MuscleGroup)
    return groups
  }
  // full body (or unrecognized body_part) -> distribute via primary muscles.
  for (const muscle of ex.primary_muscles) {
    for (const group of MUSCLE_GROUPS) {
      const membership = GROUP_MEMBERSHIP[group]
      if (Object.prototype.hasOwnProperty.call(membership, muscle)) {
        groups.add(group)
      }
    }
  }
  return groups
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function computeStrengthLevels(input: StrengthInput): StrengthResult {
  const { sessions, exercisesById, timezone, asOf } = input
  const bodyWeightKg =
    typeof input.bodyWeightKg === 'number' && Number.isFinite(input.bodyWeightKg) && input.bodyWeightKg > 0
      ? input.bodyWeightKg
      : null
  const asOfYMD = toZonedYMD(asOf.toISOString(), timezone)

  // Per-exercise: best current-month e1RM and best all-time e1RM.
  interface ExerciseAgg {
    exerciseId: string
    name: string
    currentE1RM: number | null
    peakE1RM: number | null
  }
  const byExercise = new Map<string, ExerciseAgg>()

  for (const sess of sessions) {
    const ymd = toZonedYMD(sess.performed_at, timezone)
    const isCurrentMonth = ymd.year === asOfYMD.year && ymd.month === asOfYMD.month

    for (const set of sess.sets) {
      if (!isQualifyingSet(set)) continue
      const ex = exercisesById.get(set.exercise_id)
      if (!ex) continue // custom without metadata -> honest gap, no guess

      const e1rm = epley1RM(set.weight_kg as number, set.reps as number)

      let agg = byExercise.get(set.exercise_id)
      if (!agg) {
        agg = {
          exerciseId: set.exercise_id,
          name: ex.name,
          currentE1RM: null,
          peakE1RM: null
        }
        byExercise.set(set.exercise_id, agg)
      }

      agg.peakE1RM = agg.peakE1RM == null ? e1rm : Math.max(agg.peakE1RM, e1rm)
      if (isCurrentMonth) {
        agg.currentE1RM = agg.currentE1RM == null ? e1rm : Math.max(agg.currentE1RM, e1rm)
      }
    }
  }

  // Bucket each qualifying exercise into its group(s).
  const exercisesByGroup = new Map<MuscleGroup, ExerciseAgg[]>()
  for (const group of MUSCLE_GROUPS) exercisesByGroup.set(group, [])

  for (const agg of byExercise.values()) {
    const ex = exercisesById.get(agg.exerciseId)
    if (!ex) continue
    for (const group of groupsForExercise(ex)) {
      exercisesByGroup.get(group)!.push(agg)
    }
  }

  const groups: StrengthGroup[] = MUSCLE_GROUPS.map((group) => {
    const aggs = exercisesByGroup.get(group) ?? []

    const exercises: StrengthExercise[] = aggs
      .map((a) => {
        const benchmark = benchmarkForExercise(a.name)
        const benchmarkE1RM = benchmark && bodyWeightKg ? benchmark.bodyWeightRatio * bodyWeightKg : null
        return {
          exerciseId: a.exerciseId,
          name: a.name,
          currentE1RM: a.currentE1RM,
          peakE1RM: a.peakE1RM,
          currentPct: a.peakE1RM && a.currentE1RM ? clampPct((a.currentE1RM / a.peakE1RM) * 100) : 0,
          benchmarkName: benchmark?.name ?? null,
          benchmarkE1RM,
          benchmarkPct: benchmarkPercent(a.currentE1RM, benchmarkE1RM),
          peakBenchmarkPct: benchmarkPercent(a.peakE1RM, benchmarkE1RM)
        }
      })
      .sort((a, b) => (b.peakE1RM ?? 0) - (a.peakE1RM ?? 0))

    if (exercises.length === 0) {
      return {
        group,
        currentPct: 0,
        currentE1RM: null,
        peakE1RM: null,
        lowData: true,
        exercises: [],
        benchmarkName: null,
        benchmarkE1RM: null,
        benchmarkPct: null,
        peakBenchmarkPct: null,
        benchmarkExercise: null
      }
    }

    // Representative = the exercise with the highest peakE1RM (exercises[0]
    // after the desc sort above).
    const rep = exercises[0]
    const benchmarkExercise = [...exercises]
      .filter((exercise) => exercise.benchmarkE1RM != null)
      .sort((a, b) => (b.peakBenchmarkPct ?? 0) - (a.peakBenchmarkPct ?? 0))[0] ?? null

    return {
      group,
      currentPct: rep.currentPct,
      currentE1RM: rep.currentE1RM,
      peakE1RM: rep.peakE1RM,
      lowData: false,
      exercises,
      benchmarkName: benchmarkExercise?.benchmarkName ?? null,
      benchmarkE1RM: benchmarkExercise?.benchmarkE1RM ?? null,
      benchmarkPct: benchmarkExercise?.benchmarkPct ?? null,
      peakBenchmarkPct: benchmarkExercise?.peakBenchmarkPct ?? null,
      benchmarkExercise
    }
  })

  return { groups }
}
