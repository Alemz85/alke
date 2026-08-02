import { extent } from 'd3-array'
import { scaleLinear } from 'd3-scale'
import { addDays, todayYMD, toZonedYMD, ymdKey } from '../hooks/sessionsDate'

const CORRELATION_WINDOW_DAYS = 180

export interface InsightScatterPoint {
  x: number
  y: number
  date: string
}

/**
 * Actual sleep midpoint expressed as hours on the wake-date local clock.
 * The midpoint is found on the UTC timeline first, then localized, so a DST
 * transition cannot turn a seven-hour sleep into an eight-hour interval.
 */
export function sleepMidpointHours(
  sleepStart: string,
  sleepEnd: string,
  timezone: string | null | undefined
): number | null {
  const startMs = new Date(sleepStart).getTime()
  const endMs = new Date(sleepEnd).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null

  const midpointMs = startMs + (endMs - startMs) / 2
  const midpointDay = toZonedYMD(new Date(midpointMs).toISOString(), timezone)
  const wakeDay = toZonedYMD(sleepEnd, timezone)
  const dayOffset =
    (Date.UTC(midpointDay.year, midpointDay.month - 1, midpointDay.day) -
      Date.UTC(wakeDay.year, wakeDay.month - 1, wakeDay.day)) /
    86_400_000
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(midpointMs))
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value)
  return dayOffset * 24 + part('hour') + part('minute') / 60 + part('second') / 3600
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() - days)
  return shifted.toISOString().slice(0, 10)
}

/** Build the raw click-through points for the exact date window modeled. */
export function buildInsightScatter(
  xs: Map<string, number>,
  ys: Map<string, number>,
  lagDays: number,
  fromDate: string,
  outcomePositiveOnly = false
): InsightScatterPoint[] {
  const points: InsightScatterPoint[] = []
  for (const [date, y] of ys) {
    if (date < fromDate || (outcomePositiveOnly && y <= 0)) continue
    const x = xs.get(shiftDate(date, lagDays))
    if (x !== undefined) points.push({ x, y, date })
  }
  return points
}

/** First local date represented by the nightly trailing correlation window. */
export function insightWindowStart(
  computedAt: string | null,
  timezone: string | null | undefined,
  now: Date = new Date()
): string {
  const throughDate = computedAt ? toZonedYMD(computedAt, timezone) : todayYMD(timezone, now)
  return ymdKey(addDays(throughDate, -(CORRELATION_WINDOW_DAYS - 1)))
}

/** Absolute deviation from a rolling median over calendar days, not observations. */
export function rollingCalendarMedianDeviation(
  values: Map<string, number>,
  windowDays: number,
  minPeriods: number
): Map<string, number> {
  return new Map(
    [...rollingCalendarMedianDelta(values, windowDays, minPeriods)].map(([date, value]) => [
      date,
      Math.abs(value)
    ])
  )
}

/** Current value minus the median of prior values in a calendar-day window. */
export function rollingCalendarMedianDelta(
  values: Map<string, number>,
  windowDays: number,
  minPeriods: number
): Map<string, number> {
  const entries = [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
  const deviations = new Map<string, number>()
  let left = 0
  for (let i = 0; i < entries.length; i++) {
    const currentMs = Date.parse(`${entries[i][0]}T00:00:00Z`)
    while (
      left < i &&
      currentMs - Date.parse(`${entries[left][0]}T00:00:00Z`) >
        windowDays * 86_400_000
    ) {
      left++
    }
    const window = entries
      .slice(left, i)
      .map(([, value]) => value)
      .sort((a, b) => a - b)
    if (window.length < minPeriods) continue
    const middle = Math.floor(window.length / 2)
    const median =
      window.length % 2 ? window[middle] : (window[middle - 1] + window[middle]) / 2
    deviations.set(entries[i][0], entries[i][1] - median)
  }
  return deviations
}

/** Conservative sleep-continuity proxy from the stage aggregate. */
export function sleepAwakeFraction(stages: Record<string, unknown> | null): number | null {
  if (!stages) return null
  const values = ['awake', 'core', 'deep', 'rem'].map((name) => Number(stages[name]))
  if (values.some((value) => !Number.isFinite(value))) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return total > 0 ? values[0] / total : null
}

export interface DatedNullableValue {
  date: string
  value: number | null
}

/** Mirrors metrics.insights.weight_series over a complete daily calendar. */
export function rollingWeightTrend(rows: DatedNullableValue[]): Map<string, number> {
  const sorted = [...rows].sort((left, right) => left.date.localeCompare(right.date))
  const filled: Array<number | null> = []
  let last: number | null = null
  let missingDays = 0
  for (const row of sorted) {
    if (row.value !== null && Number.isFinite(row.value)) {
      last = row.value
      missingDays = 0
      filled.push(row.value)
    } else {
      missingDays++
      filled.push(last !== null && missingDays <= 3 ? last : null)
    }
  }
  const means: Array<number | null> = filled.map((_, index) => {
    const window = filled
      .slice(Math.max(0, index - 6), index + 1)
      .filter((value): value is number => value !== null)
    return window.length >= 4 ? window.reduce((sum, value) => sum + value, 0) / window.length : null
  })
  const trend = new Map<string, number>()
  for (let index = 7; index < sorted.length; index++) {
    const current = means[index]
    const prior = means[index - 7]
    if (current !== null && prior !== null) {
      trend.set(sorted[index].date, current - prior)
    }
  }
  return trend
}

export interface InsightAxis {
  domain: [number, number]
  ticks: number[]
}

/** D3-owned numeric domain/ticks for the Recharts scatter axes. */
export function insightAxis(values: number[], tickCount = 5): InsightAxis {
  const [minimum, maximum] = extent(values.filter(Number.isFinite))
  let lower = minimum ?? 0
  let upper = maximum ?? 1
  if (lower === upper) {
    const padding = Math.max(Math.abs(lower) * 0.05, 1)
    lower -= padding
    upper += padding
  }
  const scale = scaleLinear().domain([lower, upper]).nice(tickCount)
  const domain = scale.domain() as [number, number]
  return { domain, ticks: scale.ticks(tickCount) }
}
