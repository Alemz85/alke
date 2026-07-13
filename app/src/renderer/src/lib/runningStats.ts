import type { Workout, WorkoutPlace } from '@shared/types'
import { localDateKey, toZonedYMD } from '../hooks/sessionsDate'

export interface RunBenchmark {
  workout: Workout
  paceSecPerKm: number
}

export interface MonthlyRunningStat {
  month: string
  distanceKm: number
  durationS: number
  runs: number
  paceSecPerKm: number | null
}

export interface RunningPlaceStat {
  key: string
  city: string | null
  country: string
  runs: number
  distanceKm: number
}

export interface PeriodRunningTotals {
  runs: number
  distanceKm: number
  durationS: number
  paceSecPerKm: number | null
}

export interface LongestRun {
  distanceKm: number
  durationS: number
  date: string
}

/** Elapsed whole-workout pace. This is not a GPS segment or moving-time pace. */
export function paceSecPerKm(workout: Workout): number | null {
  const distanceM = workout.distance_m
  const durationS = workout.duration_s
  if (distanceM == null || durationS == null || distanceM <= 0 || durationS <= 0) return null
  return durationS / (distanceM / 1000)
}

/** Fastest whole-workout average pace among runs whose total distance clears the threshold. */
export function bestRunAtLeast(workouts: Workout[], minimumDistanceM: number): RunBenchmark | null {
  let best: RunBenchmark | null = null
  for (const workout of workouts) {
    if ((workout.distance_m ?? 0) < minimumDistanceM) continue
    const pace = paceSecPerKm(workout)
    if (pace == null) continue
    if (best == null || pace < best.paceSecPerKm) best = { workout, paceSecPerKm: pace }
  }
  return best
}

/** The single longest run by distance. */
export function longestRun(workouts: Workout[]): LongestRun | null {
  let bestWorkout: Workout | null = null
  let bestDistanceM = 0
  for (const workout of workouts) {
    const distanceM = workout.distance_m ?? 0
    if (distanceM <= 0) continue
    if (bestWorkout == null || distanceM > bestDistanceM) {
      bestWorkout = workout
      bestDistanceM = distanceM
    }
  }
  if (bestWorkout == null) return null
  return {
    distanceKm: bestDistanceM / 1000,
    durationS: bestWorkout.duration_s ?? 0,
    date: bestWorkout.start_at
  }
}

export function runningLifetime(workouts: Workout[]): {
  runs: number
  distanceKm: number
  durationS: number
} {
  return {
    runs: workouts.length,
    distanceKm: workouts.reduce((sum, workout) => sum + (workout.distance_m ?? 0), 0) / 1000,
    durationS: workouts.reduce((sum, workout) => sum + (workout.duration_s ?? 0), 0)
  }
}

/** Distance-weighted monthly pace, equivalent to total elapsed time / total distance. */
export function monthlyRunningStats(
  workouts: Workout[],
  timezone: string | null | undefined
): MonthlyRunningStat[] {
  const byMonth = new Map<string, { distanceM: number; durationS: number; runs: number }>()
  for (const workout of workouts) {
    const month = localDateKey(workout.start_at, timezone).slice(0, 7)
    const row = byMonth.get(month) ?? { distanceM: 0, durationS: 0, runs: 0 }
    row.runs += 1
    if ((workout.distance_m ?? 0) > 0 && (workout.duration_s ?? 0) > 0) {
      row.distanceM += workout.distance_m as number
      row.durationS += workout.duration_s as number
    }
    byMonth.set(month, row)
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, row]) => ({
      month,
      distanceKm: row.distanceM / 1000,
      durationS: row.durationS,
      runs: row.runs,
      paceSecPerKm: row.distanceM > 0 ? row.durationS / (row.distanceM / 1000) : null
    }))
}

/**
 * Totals for the calendar month or year (in `timezone`) containing `now`.
 * Pace is distance-weighted (total elapsed time / total distance), same
 * convention as `monthlyRunningStats`.
 */
export function periodRunningTotals(
  workouts: Workout[],
  timezone: string | null | undefined,
  period: 'month' | 'year',
  now: Date = new Date()
): PeriodRunningTotals {
  const { year, month } = toZonedYMD(now.toISOString(), timezone)
  let runs = 0
  let distanceM = 0
  let durationS = 0

  for (const workout of workouts) {
    const ymd = toZonedYMD(workout.start_at, timezone)
    const inPeriod = period === 'month' ? ymd.year === year && ymd.month === month : ymd.year === year
    if (!inPeriod) continue
    runs += 1
    if ((workout.distance_m ?? 0) > 0 && (workout.duration_s ?? 0) > 0) {
      distanceM += workout.distance_m as number
      durationS += workout.duration_s as number
    }
  }

  return {
    runs,
    distanceKm: distanceM / 1000,
    durationS,
    paceSecPerKm: distanceM > 0 ? durationS / (distanceM / 1000) : null
  }
}

/** This calendar month's running totals (in `timezone`). */
export function monthlyRunningTotals(
  workouts: Workout[],
  timezone: string | null | undefined,
  now: Date = new Date()
): PeriodRunningTotals {
  return periodRunningTotals(workouts, timezone, 'month', now)
}

/** This calendar year's running totals (in `timezone`). */
export function yearlyRunningTotals(
  workouts: Workout[],
  timezone: string | null | undefined,
  now: Date = new Date()
): PeriodRunningTotals {
  return periodRunningTotals(workouts, timezone, 'year', now)
}

export function runningPlaces(workouts: Workout[], places: WorkoutPlace[]): RunningPlaceStat[] {
  const workoutById = new Map(workouts.map((workout) => [workout.id, workout]))
  const grouped = new Map<string, RunningPlaceStat>()

  for (const place of places) {
    const workout = workoutById.get(place.workout_id)
    if (!workout || (!place.city && !place.country)) continue
    const country = place.country ?? 'Unknown country'
    const key = place.city ? `${place.city}|${country}` : country
    const row = grouped.get(key) ?? {
      key,
      city: place.city,
      country,
      runs: 0,
      distanceKm: 0
    }
    row.runs += 1
    row.distanceKm += (workout.distance_m ?? 0) / 1000
    grouped.set(key, row)
  }

  return [...grouped.values()].sort(
    (a, b) => b.distanceKm - a.distanceKm || b.runs - a.runs || a.key.localeCompare(b.key)
  )
}
