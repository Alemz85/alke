// Formatting, date, and small-stats helpers scoped to the Recovery view.
import type { DailyMetric } from '@shared/types'

const EM_DASH = '—'

/** Formats a number with fixed decimals, or an em-dash if null/undefined/NaN. */
export function fmtNum(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH
  return value.toFixed(decimals)
}

/** Formats a signed delta, e.g. "+2.3" / "-1.1", or an em-dash. */
export function fmtDelta(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH
  const sign = value > 0 ? '+' : value < 0 ? '' : '±'
  return `${sign}${value.toFixed(decimals)}`
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

/** Number of whole days between a "YYYY-MM-DD" date string and today (UTC-anchored). */
export function daysAgo(dateStr: string): number {
  const then = new Date(`${dateStr}T00:00:00Z`).getTime()
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime()
  return Math.round((today - then) / 86_400_000)
}

/** Sorts DailyMetric rows ascending by date (does not mutate input). */
export function sortByDate(rows: DailyMetric[]): DailyMetric[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date))
}

/** Slices a date-sorted-ascending array of daily metrics to the last N days (inclusive window ending today). */
export function sliceLastNDays(rows: DailyMetric[], days: number): DailyMetric[] {
  const toDate = new Date().toISOString().slice(0, 10)
  const fromDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
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
    const windowStart = Math.max(0, i - windowDays + 1)
    const windowRows = rows.slice(windowStart, i + 1)
    const avg = mean(windowRows.map((r) => r[field] as number | null))
    if (avg !== null) out.set(rows[i].date, avg)
  }
  return out
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

export { EM_DASH }
