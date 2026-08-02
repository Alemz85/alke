// Date / ISO-week helpers for the Sessions tab. No date library is installed
// in this app, so these are hand-rolled. All "local" helpers resolve a
// workout's calendar date using the user's configured IANA timezone via
// Intl.DateTimeFormat, per DESIGN.md: "A workout belongs to the LOCAL
// calendar date of its start_at in that timezone."

import { dateKeyInTimeZone } from '@shared/localDate'

/** Plain calendar date, no time component. Always y/m/d in SOME timezone (see call sites). */
export interface YMD {
  year: number
  month: number // 1-12
  day: number
}

const FALLBACK_TZ = 'UTC'

/** Format an ISO instant into {year, month, day} in the given IANA timezone. */
export function toZonedYMD(iso: string, timezone: string | null | undefined): YMD {
  const [year, month, day] = dateKeyInTimeZone(iso, timezone).split('-').map(Number)
  return { year, month, day }
}

/** "YYYY-MM-DD" key for a YMD — stable, sortable, used as a map key. */
export function ymdKey(ymd: YMD): string {
  return `${ymd.year.toString().padStart(4, '0')}-${ymd.month.toString().padStart(2, '0')}-${ymd.day.toString().padStart(2, '0')}`
}

/** Format an ISO instant straight to its "YYYY-MM-DD" local-date key. */
export function localDateKey(iso: string, timezone: string | null | undefined): string {
  return ymdKey(toZonedYMD(iso, timezone))
}

/** Format a time-of-day (HH:MM) for an ISO instant in the given timezone. */
export function formatLocalTime(iso: string, timezone: string | null | undefined): string {
  const tz = timezone || FALLBACK_TZ
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso))
}

/** A UTC-anchored "calendar day" Date object — safe for date arithmetic (no DST surprises). */
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

/** ISO weekday, 1 (Mon) .. 7 (Sun), for a UTC-anchored calendar date. */
function isoWeekday(d: Date): number {
  const wd = d.getUTCDay() // 0=Sun..6=Sat
  return wd === 0 ? 7 : wd
}

/** Monday of the ISO week containing the given calendar date (as YMD). */
export function isoWeekStart(ymd: YMD): YMD {
  const d = utcDate(ymd.year, ymd.month, ymd.day)
  const offset = isoWeekday(d) - 1
  d.setUTCDate(d.getUTCDate() - offset)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** ISO week key "YYYY-Www" (Monday-anchored) for a calendar date — used to bucket sessions per week. */
export function isoWeekKey(ymd: YMD): string {
  // ISO 8601 week number algorithm.
  const d = utcDate(ymd.year, ymd.month, ymd.day)
  const dayNum = isoWeekday(d)
  d.setUTCDate(d.getUTCDate() + 4 - dayNum) // Thursday of this week
  const isoYear = d.getUTCFullYear()
  const yearStart = utcDate(isoYear, 1, 1)
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${isoYear}-W${weekNo.toString().padStart(2, '0')}`
}

/** Today's YMD in the given timezone. */
export function todayYMD(
  timezone: string | null | undefined,
  now: Date = new Date()
): YMD {
  return toZonedYMD(now.toISOString(), timezone)
}

/** Add N days to a YMD, returning a new YMD (UTC-anchored arithmetic). */
export function addDays(ymd: YMD, n: number): YMD {
  const d = utcDate(ymd.year, ymd.month, ymd.day)
  d.setUTCDate(d.getUTCDate() + n)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Convert a YMD to an ISO instant string at 00:00:00 UTC — used for API range boundaries. */
export function ymdToIsoStart(ymd: YMD): string {
  return utcDate(ymd.year, ymd.month, ymd.day).toISOString()
}

/** Convert local midnight for a YMD in an IANA timezone to its UTC instant. */
export function ymdToZonedIsoStart(
  ymd: YMD,
  timezone: string | null | undefined
): string {
  const tz = timezone || FALLBACK_TZ
  if (tz === 'UTC') return ymdToIsoStart(ymd)

  const targetLocalMs = Date.UTC(ymd.year, ymd.month - 1, ymd.day)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })

  // Start from UTC midnight and iteratively remove the zone offset. Repeating
  // handles dates whose offset differs from the initial UTC guess around DST.
  let instantMs = targetLocalMs
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(instantMs))
    const part = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((p) => p.type === type)?.value)
    const representedLocalMs = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour'),
      part('minute'),
      part('second')
    )
    const correction = targetLocalMs - representedLocalMs
    instantMs += correction
    if (correction === 0) break
  }
  return new Date(instantMs).toISOString()
}

/** Inclusive end instant for a local calendar day, including 23/25-hour DST days. */
export function ymdToZonedIsoEnd(
  ymd: YMD,
  timezone: string | null | undefined
): string {
  const nextStartMs = new Date(ymdToZonedIsoStart(addDays(ymd, 1), timezone)).getTime()
  return new Date(nextStartMs - 1).toISOString()
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Build the 6x7 (or as-needed) grid of cells for a given month, Monday-start.
 * Cells outside the month are marked `inMonth: false` and carry no date meaning
 * beyond grid alignment.
 */
export interface CalendarCell {
  ymd: YMD
  key: string
  inMonth: boolean
}

export function buildMonthGrid(year: number, month: number): CalendarCell[] {
  const firstOfMonth: YMD = { year, month, day: 1 }
  const gridStart = isoWeekStart(firstOfMonth)

  // Determine days in month to find the last day, then extend the grid to the
  // Sunday ending that week.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const lastOfMonth: YMD = { year, month, day: daysInMonth }
  const lastWeekStart = isoWeekStart(lastOfMonth)
  const gridEnd = addDays(lastWeekStart, 6)

  const cells: CalendarCell[] = []
  let cursor = gridStart
  // Guard against runaway loops with a generous cap (max ~6 weeks = 42 days).
  for (let i = 0; i < 42; i++) {
    cells.push({
      ymd: cursor,
      key: ymdKey(cursor),
      inMonth: cursor.month === month && cursor.year === year
    })
    if (ymdKey(cursor) === ymdKey(gridEnd)) break
    cursor = addDays(cursor, 1)
  }
  return cells
}
