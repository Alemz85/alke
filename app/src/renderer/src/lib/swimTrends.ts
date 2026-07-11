// Pure derivations for the Cardio tab's Swim stat area — monthly pace trend
// and fastest-25m effort. Builds on lib/swimSets' set-level primitives; reads
// SwimSet from @shared/types only (lib/swimSets.ts is owned elsewhere).
import type { SwimSet } from '@shared/types'

export interface MonthlyPace {
  /** 'YYYY-MM', the calendar month (in the caller's timezone) the workout falls in. */
  month: string
  /** Set-weighted pace: total set time / total set distance, across all sets in the month. */
  paceSecPer100m: number
}

/**
 * Set-weighted average /100m pace per calendar month, one row per month that
 * has ≥1 swim set. `monthOfWorkout` resolves a workout id to its 'YYYY-MM'
 * local month key (or null if the workout can't be dated), so this stays
 * timezone-agnostic — the caller does the date math.
 */
export function monthlyAvgPace(
  setsByWorkout: Map<string, SwimSet[]>,
  monthOfWorkout: (workoutId: string) => string | null
): MonthlyPace[] {
  const byMonth = new Map<string, { durationS: number; distanceM: number }>()
  for (const [workoutId, sets] of setsByWorkout) {
    const month = monthOfWorkout(workoutId)
    if (month === null) continue
    const acc = byMonth.get(month) ?? { durationS: 0, distanceM: 0 }
    for (const s of sets) {
      acc.durationS += s.duration_s
      acc.distanceM += s.distance_m
    }
    byMonth.set(month, acc)
  }
  return [...byMonth.entries()]
    .filter(([, acc]) => acc.distanceM > 0)
    .map(([month, acc]) => ({ month, paceSecPer100m: (100 * acc.durationS) / acc.distanceM }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

export interface Fastest25 {
  /** Seconds for a 25m effort, scaled from the set's actual distance. */
  seconds: number
  workoutId: string
}

/**
 * Fastest 25m effort: min over sets of distance ≥25m of duration_s scaled to
 * a 25m-equivalent time (duration_s × 25 / distance_m). Null when no set
 * reaches 25m.
 */
export function fastest25(sets: SwimSet[]): Fastest25 | null {
  let best: Fastest25 | null = null
  for (const s of sets) {
    if (s.distance_m < 25) continue
    const seconds = (s.duration_s * 25) / s.distance_m
    if (!best || seconds < best.seconds) {
      best = { seconds, workoutId: s.workout_id }
    }
  }
  return best
}

// A set must be at least this long to count toward "fastest /100m" — 5m below
// the true 100m mark, tolerating the per-second smearing HAE's distance/time
// sampling introduces on real 100m reps (e.g. a 99.4m-recorded set that was
// actually swum as 100m). Shorter sets (e.g. 80m) reward burst pace, not the
// sustained 100m effort this card means to show.
const FASTEST_100_MIN_SET_M = 95

export interface Fastest100 {
  paceSecPer100m: number
  workoutId: string
}

/**
 * Fastest /100m pace among sets of at least ~100m (see FASTEST_100_MIN_SET_M
 * tolerance). Null when no set qualifies.
 */
export function fastest100(sets: SwimSet[]): Fastest100 | null {
  let best: Fastest100 | null = null
  for (const s of sets) {
    if (s.distance_m < FASTEST_100_MIN_SET_M || s.distance_m <= 0) continue
    const pace = (100 * s.duration_s) / s.distance_m
    if (!best || pace < best.paceSecPer100m) {
      best = { paceSecPer100m: pace, workoutId: s.workout_id }
    }
  }
  return best
}
