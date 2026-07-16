// Formatting and date helpers scoped to the Dashboard view. Pure format-only
// helpers (fmtNum/fmtDelta/EM_DASH) now live in lib/format.ts and are
// re-exported here so existing call sites (Dashboard) keep compiling unchanged.
import type { UserConfig, Workout } from '@shared/types'
import { EM_DASH, fmtDelta, fmtNum } from '../lib/format'
import { workoutMatchesGoal } from '../lib/modality'
import { addDays, isoWeekStart, ymdKey, ymdToIsoStart, type YMD } from '../hooks/sessionsDate'

/**
 * The [start, end) ISO-week window containing `todayYmd`, as "YYYY-MM-DD"
 * date keys (end is EXCLUSIVE, matching the `>= start && < end` filters this
 * powers) plus ISO instant boundaries for range-querying workouts.
 *
 * Pure string/YMD math — no `Date`, no machine timezone. Callers resolve
 * "today" via `todayYMD(timezone)` (hooks/sessionsDate.ts) in the user's
 * configured IANA timezone first, so the window this returns is anchored to
 * the SAME calendar day computed_daily rows are keyed by (also user-tz), not
 * whatever day it happens to be on the machine running the app.
 */
export interface IsoWeekWindow {
  /** Monday of the week, "YYYY-MM-DD". */
  startKey: string
  /** Monday of the FOLLOWING week, "YYYY-MM-DD" — exclusive upper bound. */
  endKey: string
  /** startKey as a UTC-midnight ISO instant, for range-querying workouts. */
  startIso: string
  /** endKey as a UTC-midnight ISO instant, for range-querying workouts. */
  endIso: string
}

export function isoWeekWindowFor(todayYmd: YMD): IsoWeekWindow {
  const start = isoWeekStart(todayYmd)
  const end = addDays(start, 7)
  return {
    startKey: ymdKey(start),
    endKey: ymdKey(end),
    startIso: ymdToIsoStart(start),
    endIso: ymdToIsoStart(end)
  }
}

/** Humanizes a workout `type` string, e.g. "open_water_swim" -> "Open Water Swim". */
export function humanizeWorkoutType(type: string): string {
  return type
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Formats seconds as "1h 12m" / "42m" / "38s". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return EM_DASH
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** Formats meters as "1.85 km" or "420 m". */
export function fmtDistance(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || Number.isNaN(meters)) return null
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`
  return `${Math.round(meters)} m`
}

/** Formats a workout's start_at in the user's configured timezone, e.g. "Tue 8 Jul · 6:42 AM". */
export function fmtLocalDateTime(iso: string, timezone: string | null | undefined): string {
  const date = new Date(iso)
  const tz = timezone || undefined
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  }).format(date)
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
  return `${datePart} · ${timePart}`
}

/**
 * Formats a "YYYY-MM-DD" daily-metric date as "Jun 28" (UTC-anchored — the
 * stored value is already the user's local calendar date with no time part, so
 * re-projecting through a named zone could shift the day).
 */
export function fmtShortDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short'
  }).format(date)
}

/** Whole days between two "YYYY-MM-DD" strings (UTC-anchored, b - a). */
export function daysBetweenDates(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime()
  const tb = new Date(`${b}T00:00:00Z`).getTime()
  return Math.round((tb - ta) / 86_400_000)
}

/** Reads weekly_min_sessions as a Record<string, number>, tolerating unknown/absent shapes. */
export function parseWeeklyMinSessions(config: UserConfig | undefined): Record<string, number> {
  const raw = config?.weekly_min_sessions
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isNaN(n)) out[key] = n
  }
  return out
}

/** Counts workouts matching a weekly_min_sessions goal key (e.g. "swim", "lift"). */
export function countSessionsForGoal(workouts: Workout[], goalKey: string): number {
  return workouts.filter((w) => workoutMatchesGoal(w.type, goalKey)).length
}

export { EM_DASH, fmtDelta, fmtNum }
