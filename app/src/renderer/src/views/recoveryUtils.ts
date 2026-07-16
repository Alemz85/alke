// Formatting, date, and small-stats helpers scoped to the Recovery view.
// fmtNum/fmtDelta/EM_DASH are pure format-only helpers that live in
// lib/format.ts (THE formatting module — see its header comment) and are
// re-exported here so existing call sites (Recovery view + its tests) keep
// compiling unchanged.
import type { DailyMetric } from '@shared/types'
import { scaleLinear } from 'd3-scale'
import { EM_DASH, fmtDelta, fmtNum } from '../lib/format'
import { addDays, todayYMD, ymdKey } from '../hooks/sessionsDate'

export function chartAxis(
  values: number[],
  { padding = 0, tickCount = 4 }: { padding?: number; tickCount?: number } = {}
): { domain: [number, number]; ticks: number[] } {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return { domain: [0, 1], ticks: [0, 0.5, 1] }
  const low = Math.min(...finite)
  const high = Math.max(...finite)
  const spread = high - low || Math.max(Math.abs(low) * 0.1, 1)
  const scale = scaleLinear()
    .domain([low - Math.max(padding, spread * 0.08), high + Math.max(padding, spread * 0.08)])
    .nice(tickCount)
  return { domain: scale.domain() as [number, number], ticks: scale.ticks(tickCount) }
}

/** Local clock minutes shifted after noon, so 23:30 and 00:30 stay adjacent. */
export function clockMinutesOnSleepAxis(
  iso: string | null | undefined,
  timezone: string | null | undefined
): number | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone ?? 'UTC', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  const minutes = (hour % 24) * 60 + minute
  return minutes < 12 * 60 ? minutes + 24 * 60 : minutes
}

/** Maps a local clock target onto the same continuous overnight axis as sleep starts. */
export function clockGoalMinutesOnSleepAxis(minutesAfterMidnight: number): number {
  const normalized = ((Math.round(minutesAfterMidnight) % (24 * 60)) + 24 * 60) % (24 * 60)
  return normalized < 12 * 60 ? normalized + 24 * 60 : normalized
}

export function fmtSleepAxisTime(minutes: number): string {
  const normalized = ((Math.round(minutes) % (24 * 60)) + 24 * 60) % (24 * 60)
  return `${Math.floor(normalized / 60).toString().padStart(2, '0')}:${(normalized % 60).toString().padStart(2, '0')}`
}

/** Formats minutes as "7h 31m" / "42m", or an em-dash. */
export function fmtHoursMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return EM_DASH
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Formats hours (decimal) as "1:24" (h:mm), or an em-dash. */
export function fmtHoursAsHm(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return EM_DASH
  const totalMin = Math.round(hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}:${m.toString().padStart(2, '0')}`
}

/**
 * Formats a "YYYY-MM-DD" date string (as returned by daily_metrics, already
 * the user's local calendar date) as "Tue 8 Jul". Deliberately UTC-anchored:
 * the stored value has no time component, so re-projecting it through a
 * named timezone would risk shifting the calendar day for negative-offset
 * zones. The `timezone` param is accepted for call-site symmetry with the
 * other fmt* helpers and reserved for when sleep_start/sleep_end (real
 * instants) need zone-aware formatting.
 */
export function fmtLocalDate(dateStr: string, _timezone: string | null | undefined): string {
  const date = new Date(`${dateStr}T00:00:00Z`)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  }).format(date)
}

/**
 * Formats a real instant (sleep_start / sleep_end, stored timestamptz ISO) as a
 * 24-hour clock time in the user's timezone, e.g. "23:42". Unlike fmtLocalDate,
 * these are true instants, so projecting through the named timezone is correct.
 */
export function fmtClockTime(
  iso: string | null | undefined,
  timezone: string | null | undefined
): string {
  if (!iso) return EM_DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return EM_DASH
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone ?? 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d)
}

/**
 * Number of whole days between a "YYYY-MM-DD" date string and "today". Both
 * ends are plain date-key math (no time component), but "today" itself must
 * be resolved in the user's configured IANA timezone — daily_metrics rows
 * are keyed by the user's local calendar date, so anchoring "today" to UTC
 * instead skewed this by a day for part of the day in every timezone west of
 * UTC (and every timezone at all, near midnight). `timezone` defaults to
 * undefined (→ UTC via toZonedYMD's fallback) for callers that don't have it.
 */
export function daysAgo(dateStr: string, timezone?: string | null): number {
  const then = new Date(`${dateStr}T00:00:00Z`).getTime()
  const today = new Date(`${ymdKey(todayYMD(timezone))}T00:00:00Z`).getTime()
  return Math.round((today - then) / 86_400_000)
}

/** Sorts DailyMetric rows ascending by date (does not mutate input). */
export function sortByDate(rows: DailyMetric[]): DailyMetric[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Slices a date-sorted-ascending array of daily metrics to the last N days
 * (inclusive window ending "today"). "Today" and the N-days-back boundary
 * are both resolved via the user's configured timezone (see daysAgo above
 * for why this must not be UTC) — `timezone` defaults to undefined (UTC)
 * for callers that don't have it.
 */
export function sliceLastNDays(
  rows: DailyMetric[],
  days: number,
  timezone?: string | null
): DailyMetric[] {
  const today = todayYMD(timezone)
  const toDate = ymdKey(today)
  // -(days - 1): the window is `days` calendar days ENDING today — a "30d"
  // slice is today plus the 29 before it, not 31 dates (old off-by-one).
  const fromDate = ymdKey(addDays(today, -(days - 1)))
  return rows.filter((r) => r.date >= fromDate && r.date <= toDate)
}

/** Reads a numeric field out of a sleep_stages jsonb blob (hours), tolerating unknown shapes. */
export function readStageHours(stages: Record<string, unknown> | null, key: string): number | null {
  if (!stages) return null
  const raw = stages[key]
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Simple arithmetic mean of non-null numbers in a list; null if none present. */
export function mean(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => v !== null && v !== undefined && !Number.isNaN(v))
  if (nums.length === 0) return null
  return nums.reduce((sum, v) => sum + v, 0) / nums.length
}

/** Median of non-null numbers in a list; null if none present. */
export function median(values: Array<number | null | undefined>): number | null {
  const nums = values
    .filter((v): v is number => v !== null && v !== undefined && !Number.isNaN(v))
    .sort((a, b) => a - b)
  if (nums.length === 0) return null
  const mid = Math.floor(nums.length / 2)
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid]
}

/**
 * Trailing 7-day rolling average keyed by date, computed only over the values
 * actually present in `rows` (which must be date-ascending and may have gaps).
 * Returns a Map<date, average> including only dates where at least one of the
 * trailing 7 rows had a non-null value.
 */
export function rollingAverage(
  rows: DailyMetric[],
  field: keyof Pick<
    DailyMetric,
    'sleep_duration_min' | 'resting_hr' | 'hrv_sdnn_ms' | 'respiratory_rate'
  >,
  windowDays = 7
): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < rows.length; i++) {
    // Window by CALENDAR distance, not row count — with gaps in
    // daily_metrics a rows-based slice silently averaged a longer period.
    const minKey = shiftDateKey(rows[i].date, -(windowDays - 1))
    const windowRows: DailyMetric[] = []
    for (let j = i; j >= 0 && rows[j].date >= minKey; j--) windowRows.push(rows[j])
    const avg = mean(windowRows.map((r) => r[field] as number | null))
    if (avg !== null) out.set(rows[i].date, avg)
  }
  return out
}

/** Shift a 'YYYY-MM-DD' key by n days (UTC-safe pure string math). */
function shiftDateKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * Buckets date-ascending rows into ISO-week groups and returns the weekly
 * median of `field`, repeated across each date in that week — useful for a
 * "weekly median" line series alongside a daily-dot series.
 */
export function weeklyMedianByDate(
  rows: DailyMetric[],
  field: keyof Pick<DailyMetric, 'hrv_sdnn_ms'>
): Map<string, number> {
  const weekKeyOf = (dateStr: string): string => {
    const d = new Date(`${dateStr}T00:00:00Z`)
    const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
    d.setUTCDate(d.getUTCDate() - (day - 1))
    return d.toISOString().slice(0, 10)
  }

  const buckets = new Map<string, string[]>() // weekKey -> dates in that week
  for (const r of rows) {
    const wk = weekKeyOf(r.date)
    const list = buckets.get(wk) ?? []
    list.push(r.date)
    buckets.set(wk, list)
  }

  const out = new Map<string, number>()
  for (const [wk, dates] of buckets) {
    const values = dates.map((d) => rows.find((r) => r.date === d)?.[field] ?? null)
    const m = median(values as Array<number | null>)
    if (m !== null) {
      // stamp the median onto every date in that week so the line renders
      // as a step across the week rather than one lone point.
      for (const d of dates) out.set(d, m)
    }
    void wk
  }
  return out
}

/** Whole days between two "YYYY-MM-DD" strings (UTC-anchored, b - a). */
function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime()
  const tb = new Date(`${b}T00:00:00Z`).getTime()
  return Math.round((tb - ta) / 86_400_000)
}

export interface WeightPoint {
  date: string
  /** The actual weigh-in (null on days with no reading). */
  weight: number | null
  /**
   * 7-day-bridged rolling-mean trend, nulled out wherever the reading is more
   * than `maxGapDays` from its predecessor — so the trend line (connectNulls
   * false) only draws across densely-sampled stretches and leaves the big gaps
   * honestly blank, like the VO₂max scatter.
   */
  trend: number | null
}

/**
 * Builds the body-weight chart series from sparse weigh-ins. Only rows with a
 * non-null `weight_kg` become points (there is one point per weigh-in, not one
 * per calendar day). Each point carries a trailing rolling mean over the prior
 * `windowDays` of *readings*; that trend is set to null whenever the gap to the
 * previous reading exceeds `maxGapDays`, breaking the line across long gaps.
 */
export function buildWeightSeries(
  rows: DailyMetric[],
  windowDays = 7,
  maxGapDays = 7
): WeightPoint[] {
  const readings = rows
    .filter((r): r is DailyMetric & { weight_kg: number } => typeof r.weight_kg === 'number')
    .sort((a, b) => a.date.localeCompare(b.date))

  return readings.map((r, i) => {
    // Rolling mean over readings whose date is within windowDays of this one.
    const windowVals: number[] = []
    for (let j = i; j >= 0; j--) {
      if (daysBetween(readings[j].date, r.date) > windowDays - 1) break
      windowVals.push(readings[j].weight_kg)
    }
    const rollingMean =
      windowVals.length > 0 ? windowVals.reduce((s, v) => s + v, 0) / windowVals.length : null

    // Break the trend line where this reading is too far from the previous one.
    const prevGap = i > 0 ? daysBetween(readings[i - 1].date, r.date) : 0
    const trend = i > 0 && prevGap > maxGapDays ? null : rollingMean

    return { date: r.date, weight: r.weight_kg, trend }
  })
}

/**
 * Chart granularity. Daily plots every reading (fine for short windows); at
 * longer windows daily points crowd into noise, so we aggregate into weekly or
 * monthly buckets to let the trend read clearly.
 */
export type Granularity = 'daily' | 'weekly' | 'monthly'

/** Bucket size chosen from a window length: daily ≤30d, weekly ≤90d, monthly beyond. */
export function granularityForDays(days: number): Granularity {
  if (days <= 30) return 'daily'
  if (days <= 90) return 'weekly'
  return 'monthly'
}

/** The bucket key (a "YYYY-MM-DD" anchor date) a given date falls into. */
function bucketKeyOf(dateStr: string, g: Granularity): string {
  if (g === 'daily') return dateStr
  if (g === 'monthly') return `${dateStr.slice(0, 7)}-01`
  // weekly: anchor to the ISO Monday of that date's week.
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - (day - 1))
  return d.toISOString().slice(0, 10)
}

export interface BucketPoint {
  /** Anchor date of the bucket (the day itself, the week's Monday, or the 1st of the month). */
  date: string
  /** Aggregated value across the bucket, or null if the bucket had no readings. */
  value: number | null
  /** How many non-null readings fell into the bucket. */
  n: number
}

/**
 * Aggregates a date-ascending metric series into daily / weekly / monthly
 * buckets. At daily granularity every row passes through unchanged (value null
 * where the reading is absent); at coarser granularities each bucket collapses
 * to the mean or median of the readings it contains, and empty buckets are
 * dropped (so the series stays gap-honest rather than plotting phantom zeros).
 */
export function bucketAggregate(
  rows: DailyMetric[],
  field: keyof Pick<
    DailyMetric,
    'sleep_duration_min' | 'resting_hr' | 'hrv_sdnn_ms' | 'respiratory_rate'
  >,
  granularity: Granularity,
  agg: 'mean' | 'median' = 'mean'
): BucketPoint[] {
  if (granularity === 'daily') {
    return rows.map((r) => {
      const v = r[field]
      const num = typeof v === 'number' && !Number.isNaN(v) ? v : null
      return { date: r.date, value: num, n: num === null ? 0 : 1 }
    })
  }

  const buckets = new Map<string, number[]>()
  for (const r of rows) {
    const v = r[field]
    if (typeof v !== 'number' || Number.isNaN(v)) continue
    const key = bucketKeyOf(r.date, granularity)
    const list = buckets.get(key) ?? []
    list.push(v)
    buckets.set(key, list)
  }

  return [...buckets.keys()]
    .sort()
    .map((key) => {
      const vals = buckets.get(key) as number[]
      return { date: key, value: agg === 'median' ? median(vals) : mean(vals), n: vals.length }
    })
}

/**
 * Axis / tooltip label for a bucket anchor date, matched to its granularity:
 * a day reads "Tue 8 Jul", a week "wk 8 Jul", a month "Jul 2026".
 */
export function fmtBucketLabel(
  dateStr: string,
  granularity: Granularity,
  timezone: string | null | undefined
): string {
  if (granularity === 'monthly') {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      year: 'numeric'
    }).format(new Date(`${dateStr}T00:00:00Z`))
  }
  if (granularity === 'weekly') return `wk ${fmtLocalDate(dateStr, timezone)}`
  return fmtLocalDate(dateStr, timezone)
}

export { EM_DASH, fmtDelta, fmtNum }
