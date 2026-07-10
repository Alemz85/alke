// Formatting and date helpers scoped to the Dashboard view.
import type { UserConfig, Workout } from '@shared/types'
import { workoutMatchesGoal } from '../lib/modality'

const EM_DASH = '—'

/** Monday 00:00:00 local (of `date`'s calendar day) — ISO week start. */
export function startOfIsoWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay() // 0 = Sun .. 6 = Sat
  const diff = day === 0 ? -6 : 1 - day // days to subtract to reach Monday
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

export function endOfIsoWeek(date: Date): Date {
  const start = startOfIsoWeek(date)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return end
}

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

export { EM_DASH }
