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
