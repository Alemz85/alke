// Pure stats helpers for the Walking cardio tab: daily-metrics-derived steps
// series (the primary signal — populated almost every day) layered with
// explicit walk/hike workout stats (sparse, but carry distance + HR).
import type { DailyMetric, Workout } from '@shared/types'
import { addDays, isoWeekKey, isoWeekStart, localDateKey, toZonedYMD, type YMD } from '../hooks/sessionsDate'

export interface DailyStepsPoint {
  /** "YYYY-MM-DD" local date key. */
  date: string
  steps: number
}

export interface WeeklyStepsTotal {
  /** ISO week key, e.g. "2026-W29". */
  key: string
  /** Short label for chart ticks, e.g. "W29". */
  week: string
  steps: number
}

export interface ExplicitWalkStats {
  count: number
  distanceKm: number
  durationS: number
}

export interface TodayVsAvgSteps {
  today: number | null
  avg: number
  deltaPct: number | null
}

/**
 * Zero-filled daily steps for the continuous last `days` days ending today
 * (in `timezone`) — a missing day is 0, not absent, so trend charts don't
 * silently skip gaps.
 */
export function dailyStepsSeries(
  metrics: DailyMetric[],
  timezone: string | null | undefined,
  days: number
): DailyStepsPoint[] {
  const byDate = new Map<string, number>()
  for (const m of metrics) {
    if (m.steps != null) byDate.set(m.date.slice(0, 10), (byDate.get(m.date.slice(0, 10)) ?? 0) + m.steps)
  }
  const today = toZonedYMD(new Date().toISOString(), timezone)
  const points: DailyStepsPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const ymd = addDays(today, -i)
    const key = ymdToKey(ymd)
    points.push({ date: key, steps: byDate.get(key) ?? 0 })
  }
  return points
}

function ymdToKey(ymd: YMD): string {
  return `${ymd.year.toString().padStart(4, '0')}-${ymd.month.toString().padStart(2, '0')}-${ymd.day.toString().padStart(2, '0')}`
}

/**
 * Weekly step totals over the continuous last `count` ISO weeks ending at the
 * current week (Monday-anchored), zero-filled — mirrors weeklyZ2's bucketing
 * convention in Zone2View.
 */
export function weeklyStepsTotals(
  metrics: DailyMetric[],
  timezone: string | null | undefined,
  count: number
): WeeklyStepsTotal[] {
  const byWeek = new Map<string, number>()
  for (const m of metrics) {
    if (m.steps == null) continue
    const dateKey = m.date.slice(0, 10)
    const [y, mo, d] = dateKey.split('-').map(Number)
    const key = isoWeekKey({ year: y, month: mo, day: d })
    byWeek.set(key, (byWeek.get(key) ?? 0) + m.steps)
  }
  const thisMonday = isoWeekStart(toZonedYMD(new Date().toISOString(), timezone))
  const keys: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    keys.push(isoWeekKey(addDays(thisMonday, -7 * i)))
  }
  return keys.map((k) => ({
    key: k,
    week: k.slice(6),
    steps: byWeek.get(k) ?? 0
  }))
}

/** Sum of steps for calendar days within [fromKey, toKey] inclusive ("YYYY-MM-DD" keys). */
function stepsInRange(metrics: DailyMetric[], fromKey: string, toKey: string): number {
  let total = 0
  for (const m of metrics) {
    const key = m.date.slice(0, 10)
    if (m.steps != null && key >= fromKey && key <= toKey) total += m.steps
  }
  return total
}

/** Steps so far this calendar week / month (in `timezone`), Monday-anchored week. */
export function periodStepsTotals(
  metrics: DailyMetric[],
  timezone: string | null | undefined
): { thisWeek: number; thisMonth: number } {
  const today = toZonedYMD(new Date().toISOString(), timezone)
  const todayKey = ymdToKey(today)
  const monday = isoWeekStart(today)
  const monthStart = ymdToKey({ year: today.year, month: today.month, day: 1 })
  return {
    thisWeek: stepsInRange(metrics, ymdToKey(monday), todayKey),
    thisMonth: stepsInRange(metrics, monthStart, todayKey)
  }
}

/**
 * Today's steps vs the trailing `baselineDays`-day average (baseline computed
 * over the days STRICTLY BEFORE today, so today can't skew its own baseline).
 */
export function todayVsAvgSteps(
  metrics: DailyMetric[],
  timezone: string | null | undefined,
  baselineDays = 30
): TodayVsAvgSteps {
  const today = toZonedYMD(new Date().toISOString(), timezone)
  const todayKey = ymdToKey(today)
  const byDate = new Map<string, number>()
  for (const m of metrics) {
    if (m.steps != null) byDate.set(m.date.slice(0, 10), (byDate.get(m.date.slice(0, 10)) ?? 0) + m.steps)
  }

  let sum = 0
  let n = 0
  for (let i = 1; i <= baselineDays; i++) {
    const key = ymdToKey(addDays(today, -i))
    const v = byDate.get(key)
    if (v != null) {
      sum += v
      n += 1
    }
  }
  const avg = n > 0 ? sum / n : 0
  const todaySteps = byDate.get(todayKey) ?? null
  const deltaPct = todaySteps != null && avg > 0 ? ((todaySteps - avg) / avg) * 100 : null
  return { today: todaySteps, avg, deltaPct }
}

/** Average of the last `days` days' steps (zero-filled), e.g. "last 30d average". */
export function averageDailySteps(
  metrics: DailyMetric[],
  timezone: string | null | undefined,
  days: number
): number {
  const series = dailyStepsSeries(metrics, timezone, days)
  if (series.length === 0) return 0
  return series.reduce((sum, p) => sum + p.steps, 0) / series.length
}

/** Lifetime, this-month, and this-year totals for explicit walk/hike workouts (have distance + duration). */
export function explicitWalkStats(
  workouts: Workout[],
  timezone: string | null | undefined,
  period: 'lifetime' | 'month' | 'year',
  now: Date = new Date()
): ExplicitWalkStats {
  const { year, month } = toZonedYMD(now.toISOString(), timezone)
  let count = 0
  let distanceM = 0
  let durationS = 0
  for (const w of workouts) {
    if (period !== 'lifetime') {
      const ymd = toZonedYMD(w.start_at, timezone)
      const inPeriod = period === 'month' ? ymd.year === year && ymd.month === month : ymd.year === year
      if (!inPeriod) continue
    }
    count += 1
    distanceM += w.distance_m ?? 0
    durationS += w.duration_s ?? 0
  }
  return { count, distanceKm: distanceM / 1000, durationS }
}

/** Convenience: the `count` most recent explicit walk workouts, newest first — feeds RecentSessionsCard callers that want a header stat. */
export function recentWalkDates(workouts: Workout[], timezone: string | null | undefined, count: number): string[] {
  return [...workouts]
    .sort((a, b) => b.start_at.localeCompare(a.start_at))
    .slice(0, count)
    .map((w) => localDateKey(w.start_at, timezone))
}
