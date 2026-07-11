// Pure derivations over ingest-detected swim sets (swim_sets table).
// Formulas live here — NOT in the DB — so they stay tunable (spec:
// docs/superpowers/specs/2026-07-11-swim-set-analytics-design.md).
//
// SWOLF caveat: Apple counts watch-arm strokes (≈ one cycle for freestyle),
// so swolf25 doubles them to the textbook both-hands convention. Exact for
// alternating strokes (free/back); overcounts breast/fly — acceptable, the
// app assumes freestyle and HAE never sends stroke style.
import type { SwimSet, WorkoutHrSample } from '@shared/types'

export function paceSecPer100m(set: SwimSet): number | null {
  if (set.distance_m <= 0) return null
  return (100 * set.duration_s) / set.distance_m
}

/**
 * SWOLF normalized per 25m: (seconds + both-hands strokes) per 25m swum.
 * Stored strokes are watch-arm cycles, so they count double (freestyle
 * assumption — see header comment).
 */
export function swolf25(set: SwimSet): number | null {
  if (set.distance_m <= 0) return null
  return (set.duration_s + 2 * set.strokes) / (set.distance_m / 25)
}

/**
 * Distance per stroke cycle in meters (strokes are stored as watch-arm
 * cycles, which IS the DPS convention). Longer = better technique/glide.
 */
export function dpsMPerCycle(set: SwimSet): number | null {
  if (set.strokes <= 0) return null
  return set.distance_m / set.strokes
}

/** Stroke rate in cycles per minute of swim time (rests excluded). */
export function strokeRatePerMin(set: SwimSet): number | null {
  if (set.duration_s <= 0) return null
  return set.strokes / (set.duration_s / 60)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Human structure line: sets clustered by distance rounded to 5m, in first-
 * appearance order — "25×50m", or "8×100m + 4×50m" for mixed sessions.
 */
export function clusterStructure(sets: SwimSet[]): string {
  const groups: { distance: number; count: number }[] = []
  for (const s of sets) {
    const d = Math.round(s.distance_m / 5) * 5
    const group = groups.find((g) => g.distance === d)
    if (group) group.count++
    else groups.push({ distance: d, count: 1 })
  }
  return groups.map((g) => `${g.count}×${g.distance}m`).join(' + ')
}

/**
 * Within-session fade: mean pace of the second half of sets vs the first
 * half, as a percentage (positive = slowing down). Needs ≥4 sets.
 */
export function sessionFadePct(sets: SwimSet[]): number | null {
  if (sets.length < 4) return null
  const paces = sets
    .map(paceSecPer100m)
    .filter((p): p is number => p !== null)
  if (paces.length < 4) return null
  const half = Math.floor(paces.length / 2)
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const first = mean(paces.slice(0, half))
  const second = mean(paces.slice(paces.length - half))
  if (first === 0) return null
  return ((second - first) / first) * 100
}

export interface SwimSessionSummary {
  nSets: number
  setDistanceM: number
  avgPaceSecPer100m: number | null // set-time weighted (total time / total distance)
  medianSwolf25: number | null
  medianRestS: number | null
  fadePct: number | null
  structure: string
  dpsMPerCycle: number | null // total distance / total cycles
  strokeRatePerMin: number | null // total cycles / total swim minutes
}

export function summarizeSession(sets: SwimSet[]): SwimSessionSummary {
  const distance = sets.reduce((sum, s) => sum + s.distance_m, 0)
  const duration = sets.reduce((sum, s) => sum + s.duration_s, 0)
  const strokes = sets.reduce((sum, s) => sum + s.strokes, 0)
  return {
    nSets: sets.length,
    setDistanceM: distance,
    avgPaceSecPer100m: distance > 0 ? (100 * duration) / distance : null,
    medianSwolf25: median(sets.map(swolf25).filter((v): v is number => v !== null)),
    medianRestS: median(
      sets.map((s) => s.rest_after_s).filter((v): v is number => v !== null)
    ),
    fadePct: sessionFadePct(sets),
    structure: clusterStructure(sets),
    dpsMPerCycle: strokes > 0 ? distance / strokes : null,
    strokeRatePerMin: duration > 0 ? strokes / (duration / 60) : null
  }
}

/** Mean bpm over the samples inside a set's swim window; null under 5 samples. */
export function setAvgHr(set: SwimSet, samples: WorkoutHrSample[]): number | null {
  const end = set.start_offset_s + set.duration_s
  const within = samples.filter((s) => s.offset_s >= set.start_offset_s && s.offset_s < end)
  if (within.length < 5) return null
  return within.reduce((sum, s) => sum + s.bpm, 0) / within.length
}

/**
 * HR recovery during the rest after a set: peak bpm in the set's final 15s
 * minus the lowest bpm reached before the next set starts. Positive = the
 * heart came down; shrinking values late in a session signal accumulating
 * fatigue. Null when the rest is under 15s or the trace is too sparse.
 */
export function restRecoveryBpm(set: SwimSet, samples: WorkoutHrSample[]): number | null {
  const restAfter = set.rest_after_s
  if (restAfter === null || restAfter < 15) return null
  const end = set.start_offset_s + set.duration_s
  const tail = samples.filter((s) => s.offset_s >= end - 15 && s.offset_s < end)
  const rest = samples.filter((s) => s.offset_s >= end && s.offset_s < end + restAfter)
  if (tail.length === 0 || rest.length < 5) return null
  const peakEnd = Math.max(...tail.map((s) => s.bpm))
  const minRest = Math.min(...rest.map((s) => s.bpm))
  return peakEnd - minRest
}

// A "set" must be at least this long to qualify for the fastest-set effort —
// short blocks (a single 25m length) reward burst over sustained pace.
const BEST_EFFORT_MIN_SET_M = 45

export interface BestEfforts {
  /** Fastest set of ≥45m, by pace. */
  fastestSet: { paceSecPer100m: number; distanceM: number; workoutId: string } | null
  /** Best session-wide set-weighted pace. */
  bestSessionPace: { paceSecPer100m: number; workoutId: string } | null
  /** Lowest session median SWOLF₍25₎. */
  bestSessionSwolf25: { swolf: number; workoutId: string } | null
}

export function bestEfforts(byWorkout: Map<string, SwimSet[]>): BestEfforts {
  const out: BestEfforts = { fastestSet: null, bestSessionPace: null, bestSessionSwolf25: null }
  for (const [workoutId, sets] of byWorkout) {
    for (const s of sets) {
      const pace = paceSecPer100m(s)
      if (pace === null || s.distance_m < BEST_EFFORT_MIN_SET_M) continue
      if (!out.fastestSet || pace < out.fastestSet.paceSecPer100m) {
        out.fastestSet = { paceSecPer100m: pace, distanceM: s.distance_m, workoutId }
      }
    }
    const summary = summarizeSession(sets)
    if (
      summary.avgPaceSecPer100m !== null &&
      (!out.bestSessionPace || summary.avgPaceSecPer100m < out.bestSessionPace.paceSecPer100m)
    ) {
      out.bestSessionPace = { paceSecPer100m: summary.avgPaceSecPer100m, workoutId }
    }
    if (
      summary.medianSwolf25 !== null &&
      (!out.bestSessionSwolf25 || summary.medianSwolf25 < out.bestSessionSwolf25.swolf)
    ) {
      out.bestSessionSwolf25 = { swolf: summary.medianSwolf25, workoutId }
    }
  }
  return out
}

/**
 * HR trace normalized for a timeline overlay: time and bpm both mapped to
 * [0, 1] over the given window (t: 0 = fromS, 1 = toS; v: 0 = lowest bpm in
 * window, 1 = highest). Empty when the window has <2 samples or no HR range.
 */
export function normalizeHrTrack(
  samples: WorkoutHrSample[],
  fromS: number,
  toS: number
): { t: number; v: number }[] {
  const span = toS - fromS
  if (span <= 0) return []
  const within = samples.filter((s) => s.offset_s >= fromS && s.offset_s <= toS)
  if (within.length < 2) return []
  const min = Math.min(...within.map((s) => s.bpm))
  const max = Math.max(...within.map((s) => s.bpm))
  if (max === min) return []
  return within.map((s) => ({
    t: (s.offset_s - fromS) / span,
    v: (s.bpm - min) / (max - min)
  }))
}

/** Groups a flat swim_sets read by workout, preserving set order. */
export function groupByWorkout(sets: SwimSet[]): Map<string, SwimSet[]> {
  const byWorkout = new Map<string, SwimSet[]>()
  for (const s of sets) {
    const list = byWorkout.get(s.workout_id)
    if (list) list.push(s)
    else byWorkout.set(s.workout_id, [s])
  }
  for (const list of byWorkout.values()) list.sort((a, b) => a.set_index - b.set_index)
  return byWorkout
}
