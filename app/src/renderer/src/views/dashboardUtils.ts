// Formatting and date helpers scoped to the Dashboard view. Pure format-only
// helpers (fmtNum/fmtDelta/EM_DASH) now live in lib/format.ts and are
// re-exported here so existing call sites (Dashboard) keep compiling unchanged.
import type { DailyMetric, UserConfig, Workout } from '@shared/types'
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

/**
 * Everything the compact body-weight pill needs, derived from the (possibly
 * sparse) daily_metrics weigh-ins. Weigh-ins can be weeks apart, so
 * the pill leads with staleness ("weighed N days ago") and a terse trend vs a
 * reading at least ~30 days older than the latest — never a machine-local
 * `new Date()` day comparison. `todayKey` is the caller's user-tz "today"
 * (from `todayYMD(timezone)`), passed in so this stays pure and testable.
 */
export interface BodyWeightSummary {
  /** Latest weigh-in in kg, or null when there is no reading at all. */
  latestKg: number | null
  /** "YYYY-MM-DD" of the latest weigh-in, or null. */
  latestDate: string | null
  /** Short display date of the latest weigh-in, e.g. "28 Jun" (EM dash if none). */
  latestDateLabel: string
  /** Whole days between the latest weigh-in and `todayKey` (>= 0), or null. */
  daysSince: number | null
  /** "Today" / "Yesterday" / "N days ago" / "N weeks ago" for the latest weigh-in. */
  stalenessLabel: string | null
  /** True once the latest weigh-in is more than a week old — the pill dims. */
  isStale: boolean
  /** Signed kg delta vs the comparison reading, or null when none qualifies. */
  deltaKg: number | null
  /** Terse trend label, e.g. "−0.8 kg vs 1 mo ago" (null when no comparison). */
  deltaLabel: string | null
}

/** Humanizes a non-negative day count as "Today" / "Yesterday" / "N days ago" / "N weeks ago". */
export function humanizeDaysSince(days: number): string {
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 14) return `${days} days ago`
  const weeks = Math.round(days / 7)
  return `${weeks} weeks ago`
}

/**
 * Builds the body-weight pill summary from date-ASCENDING daily_metrics rows.
 * Pure: no `Date.now()`, no machine timezone — `todayKey` is the user-tz today.
 * The comparison reading is the one closest to but >= 30 days older than the
 * latest; when nothing is that old it falls back to the oldest reading, and
 * when there is only a single reading there is no delta at all.
 */
export function computeBodyWeightSummary(
  metricsAsc: DailyMetric[],
  todayKey: string
): BodyWeightSummary {
  const readings = metricsAsc.filter(
    (m): m is DailyMetric & { weight_kg: number } => typeof m.weight_kg === 'number'
  )

  if (readings.length === 0) {
    return {
      latestKg: null,
      latestDate: null,
      latestDateLabel: EM_DASH,
      daysSince: null,
      stalenessLabel: null,
      isStale: false,
      deltaKg: null,
      deltaLabel: null
    }
  }

  const latest = readings[readings.length - 1]
  const daysSince = Math.max(0, daysBetweenDates(latest.date, todayKey))

  // Comparison reading: closest to but >= 30 days older than the latest;
  // otherwise the oldest reading; otherwise (single reading) none.
  const olderByMonth = readings
    .filter((m) => daysBetweenDates(m.date, latest.date) >= 30)
    .sort((a, b) => daysBetweenDates(a.date, latest.date) - daysBetweenDates(b.date, latest.date))
  const comparison =
    olderByMonth.length > 0
      ? olderByMonth[0]
      : readings.length > 1
        ? readings[0]
        : undefined

  let deltaKg: number | null = null
  let deltaLabel: string | null = null
  if (comparison && comparison.date !== latest.date) {
    deltaKg = latest.weight_kg - comparison.weight_kg
    const sign = deltaKg > 0 ? '+' : deltaKg < 0 ? '−' : '±'
    const gapDays = daysBetweenDates(comparison.date, latest.date)
    const spanLabel =
      gapDays >= 30 ? `${Math.max(1, Math.round(gapDays / 30))} mo` : `${gapDays}d`
    deltaLabel = `${sign}${Math.abs(deltaKg).toFixed(1)} kg vs ${spanLabel} ago`
  }

  return {
    latestKg: latest.weight_kg,
    latestDate: latest.date,
    latestDateLabel: fmtShortDate(latest.date),
    daysSince,
    stalenessLabel: humanizeDaysSince(daysSince),
    isStale: daysSince > 7,
    deltaKg,
    deltaLabel
  }
}

export { EM_DASH, fmtDelta, fmtNum }
