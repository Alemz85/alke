// Pure derivations over ingest-detected swim sets (swim_sets table).
// Formulas live here — NOT in the DB — so they stay tunable (spec:
// docs/superpowers/specs/2026-07-11-swim-set-analytics-design.md).
//
// SWOLF caveat: Apple counts watch-arm strokes (≈ one per cycle for
// freestyle), so swolf25 is self-relative — lower than a both-hands count.
import type { SwimSet } from '@shared/types'

export function paceSecPer100m(set: SwimSet): number | null {
  if (set.distance_m <= 0) return null
  return (100 * set.duration_s) / set.distance_m
}

/** SWOLF normalized per 25m: (seconds + watch-arm strokes) per 25m swum. */
export function swolf25(set: SwimSet): number | null {
  if (set.distance_m <= 0) return null
  return (set.duration_s + set.strokes) / (set.distance_m / 25)
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
}

export function summarizeSession(sets: SwimSet[]): SwimSessionSummary {
  const distance = sets.reduce((sum, s) => sum + s.distance_m, 0)
  const duration = sets.reduce((sum, s) => sum + s.duration_s, 0)
  return {
    nSets: sets.length,
    setDistanceM: distance,
    avgPaceSecPer100m: distance > 0 ? (100 * duration) / distance : null,
    medianSwolf25: median(sets.map(swolf25).filter((v): v is number => v !== null)),
    medianRestS: median(
      sets.map((s) => s.rest_after_s).filter((v): v is number => v !== null)
    ),
    fadePct: sessionFadePct(sets),
    structure: clusterStructure(sets)
  }
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
