// Pure stats helpers for the Walking cardio tab: daily-metrics-derived steps
// series (the primary signal — populated almost every day) layered with
// explicit walk/hike workout stats (sparse, but carry distance + HR).
import type { DailyMetric, Workout } from '@shared/types'
import { addDays, isoWeekKey, isoWeekStart, localDateKey, toZonedYMD, type YMD } from '../hooks/sessionsDate'

export interface DailyStepsPoint {
  /** "YYYY-MM-DD" local date key. */
  date: string
  steps: number
  /** Zero-filled walking+running distance in km — null when no metric row exists for the date at all (pre-backfill history), distinct from a real 0. */
  distanceKm: number | null
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

export interface PeriodDistanceTotals {
  /** Distance in km, or null when the period has zero rows with any distance recorded (pre-backfill history) — distinct from a real 0km. */
  todayKm: number | null
  thisWeekKm: number | null
  thisMonthKm: number | null
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
  const stepsByDate = new Map<string, number>()
  const distanceByDate = new Map<string, number>()
  for (const m of metrics) {
    const key = m.date.slice(0, 10)
    if (m.steps != null) stepsByDate.set(key, (stepsByDate.get(key) ?? 0) + m.steps)
    if (m.walking_running_distance_m != null) {
      distanceByDate.set(key, (distanceByDate.get(key) ?? 0) + m.walking_running_distance_m)
    }
  }
  const today = toZonedYMD(new Date().toISOString(), timezone)
  const points: DailyStepsPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const ymd = addDays(today, -i)
    const key = ymdToKey(ymd)
    const distanceM = distanceByDate.get(key)
    points.push({
      date: key,
      steps: stepsByDate.get(key) ?? 0,
      distanceKm: distanceM != null ? distanceM / 1000 : null
    })
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
 * Sum of `walking_running_distance_m` (in meters) for calendar days within
 * [fromKey, toKey] inclusive. Returns `{ total: 0, hasData: false }` when no
 * row in the range carries a distance value at all — e.g. dates before the
 * backfill started — so callers can em-dash instead of showing a false "0".
 */
function distanceMInRange(
  metrics: DailyMetric[],
  fromKey: string,
  toKey: string
): { total: number; hasData: boolean } {
  let total = 0
  let hasData = false
  for (const m of metrics) {
    const key = m.date.slice(0, 10)
    if (key < fromKey || key > toKey) continue
    if (m.walking_running_distance_m != null) {
      total += m.walking_running_distance_m
      hasData = true
    }
  }
  return { total, hasData }
}

/**
 * Walking/running distance (km) for today / this calendar week / this
 * calendar month (in `timezone`), Monday-anchored week — mirrors
 * `periodStepsTotals`'s ranges. Each field is null when the corresponding
 * window has no distance rows at all (as opposed to rows summing to 0km),
 * so the view can em-dash rather than print "0.0 km" for pre-backfill dates.
 */
export function periodDistanceTotals(
  metrics: DailyMetric[],
  timezone: string | null | undefined
): PeriodDistanceTotals {
  const today = toZonedYMD(new Date().toISOString(), timezone)
  const todayKey = ymdToKey(today)
  const monday = isoWeekStart(today)
  const monthStart = ymdToKey({ year: today.year, month: today.month, day: 1 })

  const day = distanceMInRange(metrics, todayKey, todayKey)
  const week = distanceMInRange(metrics, ymdToKey(monday), todayKey)
  const month = distanceMInRange(metrics, monthStart, todayKey)

  return {
    todayKm: day.hasData ? day.total / 1000 : null,
    thisWeekKm: week.hasData ? week.total / 1000 : null,
    thisMonthKm: month.hasData ? month.total / 1000 : null
  }
}

/**
 * Flights climbed so far this calendar week (Monday-anchored, in
 * `timezone`). Null when no row in the week carries a flights value at all,
 * distinct from a real 0.
 */
export function flightsThisWeek(
  metrics: DailyMetric[],
  timezone: string | null | undefined
): number | null {
  const today = toZonedYMD(new Date().toISOString(), timezone)
  const todayKey = ymdToKey(today)
  const monday = isoWeekStart(today)
  const mondayKey = ymdToKey(monday)

  let total = 0
  let hasData = false
  for (const m of metrics) {
    const key = m.date.slice(0, 10)
    if (key < mondayKey || key > todayKey) continue
    if (m.flights_climbed != null) {
      total += m.flights_climbed
      hasData = true
    }
  }
  return hasData ? total : null
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
