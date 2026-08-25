// Pure stats helpers for the HR-led cardio modalities (cycling, rowing):
// most sessions here carry no distance (indoor), so duration and avg-HR/energy
// are the primary volume and effort proxies. Cycling additionally has a
// DAILY watch-tracked total distance (daily_metrics.cycling_distance_m,
// includes unrecorded rides) — see monthRiddenTotals.
import type { DailyMetric, Workout } from '@shared/types'
import { toZonedYMD } from '../hooks/sessionsDate'

export interface LifetimeCardioStats {
  sessions: number
  durationS: number
  energyKcal: number
}

export interface PeriodCardioTotals {
  sessions: number
  durationS: number
  avgHr: number | null
  energyKcal: number
}

export interface MonthlyAvgHr {
  month: string
  avgHr: number | null
  sessions: number
}

/** Lifetime totals across every recorded session of this modality. */
export function lifetimeCardioStats(workouts: Workout[]): LifetimeCardioStats {
  return {
    sessions: workouts.length,
    durationS: workouts.reduce((sum, w) => sum + (w.duration_s ?? 0), 0),
    energyKcal: workouts.reduce((sum, w) => sum + (w.energy_kcal ?? 0), 0)
  }
}

/**
 * Totals for the calendar month or year (in `timezone`) containing `now`.
 * avg HR is duration-weighted (sum of avg_hr*duration / sum of duration),
 * the same convention as the app's other period aggregates.
 */
export function periodCardioTotals(
  workouts: Workout[],
  timezone: string | null | undefined,
  period: 'month' | 'year',
  now: Date = new Date()
): PeriodCardioTotals {
  const { year, month } = toZonedYMD(now.toISOString(), timezone)
  let sessions = 0
  let durationS = 0
  let energyKcal = 0
  let hrWeightedSum = 0
  let hrWeightedDuration = 0

  for (const w of workouts) {
    const ymd = toZonedYMD(w.start_at, timezone)
    const inPeriod = period === 'month' ? ymd.year === year && ymd.month === month : ymd.year === year
    if (!inPeriod) continue
    sessions += 1
    const d = w.duration_s ?? 0
    durationS += d
    energyKcal += w.energy_kcal ?? 0
    if (w.avg_hr != null && d > 0) {
      hrWeightedSum += w.avg_hr * d
      hrWeightedDuration += d
    }
  }

  return {
    sessions,
    durationS,
    energyKcal,
    avgHr: hrWeightedDuration > 0 ? hrWeightedSum / hrWeightedDuration : null
  }
}

/** This calendar month's totals (in `timezone`). */
export function monthlyCardioTotals(
  workouts: Workout[],
  timezone: string | null | undefined,
  now: Date = new Date()
): PeriodCardioTotals {
  return periodCardioTotals(workouts, timezone, 'month', now)
}

export interface MonthRiddenTotals {
  /** Watch-tracked total km this calendar month, incl. unrecorded rides. Null when NO row in the month carries a value (pre-ingest dates), so callers hide rather than show a false 0. */
  totalKm: number | null
  /** Sum of recorded sessions' distance this month; null when no session carries distance (indoor rides). */
  recordedKm: number | null
}

/**
 * This calendar month's ridden distance (in `timezone`): the watch's daily
 * cycling total (daily_metrics.cycling_distance_m — counts unrecorded rides)
 * against what recorded sessions account for. Same null-over-false-zero
 * convention as walkingStats.periodDistanceTotals: a month with no data rows
 * at all yields null, not 0 — cycling_distance_m only exists from when that column was first ingested.
 */
export function monthRiddenTotals(
  workouts: Workout[],
  metrics: DailyMetric[],
  timezone: string | null | undefined,
  now: Date = new Date()
): MonthRiddenTotals {
  const { year, month } = toZonedYMD(now.toISOString(), timezone)
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`

  let totalM = 0
  let hasDaily = false
  for (const m of metrics) {
    if (!m.date.startsWith(monthPrefix)) continue
    if (m.cycling_distance_m != null) {
      totalM += m.cycling_distance_m
      hasDaily = true
    }
  }

  let recordedM = 0
  let hasRecorded = false
  for (const w of workouts) {
    const ymd = toZonedYMD(w.start_at, timezone)
    if (ymd.year !== year || ymd.month !== month) continue
    if (w.distance_m != null) {
      recordedM += w.distance_m
      hasRecorded = true
    }
  }

  return {
    totalKm: hasDaily ? totalM / 1000 : null,
    recordedKm: hasRecorded ? recordedM / 1000 : null
  }
}

/** This calendar year's totals (in `timezone`). */
export function yearlyCardioTotals(
  workouts: Workout[],
  timezone: string | null | undefined,
  now: Date = new Date()
): PeriodCardioTotals {
  return periodCardioTotals(workouts, timezone, 'year', now)
}

/**
 * Duration-weighted average HR per calendar month, oldest to newest — feeds
 * the "Average HR by month" chart. Months with sessions but no HR data are
 * omitted rather than plotted as a false zero.
 */
export function avgHrByMonth(workouts: Workout[], timezone: string | null | undefined): MonthlyAvgHr[] {
  const byMonth = new Map<string, { hrWeightedSum: number; hrWeightedDuration: number; sessions: number }>()
  for (const w of workouts) {
    const month = `${toZonedYMD(w.start_at, timezone).year}-${String(toZonedYMD(w.start_at, timezone).month).padStart(2, '0')}`
    const row = byMonth.get(month) ?? { hrWeightedSum: 0, hrWeightedDuration: 0, sessions: 0 }
    row.sessions += 1
    const d = w.duration_s ?? 0
    if (w.avg_hr != null && d > 0) {
      row.hrWeightedSum += w.avg_hr * d
      row.hrWeightedDuration += d
    }
    byMonth.set(month, row)
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, row]) => ({
      month,
      sessions: row.sessions,
      avgHr: row.hrWeightedDuration > 0 ? row.hrWeightedSum / row.hrWeightedDuration : null
    }))
}
