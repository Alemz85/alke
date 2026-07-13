import { toZonedYMD } from '../../hooks/sessionsDate'

/** "Mon, Jul 7" in the user's timezone (noon-anchored to avoid DST edges). */
export function formatDateShort(iso: string, timezone: string | null | undefined): string {
  const ymd = toZonedYMD(iso, timezone)
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12))
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })
}

/** "6:30 PM" in the user's timezone. */
export function formatTime(iso: string, timezone: string | null | undefined): string {
  const tz = timezone || 'UTC'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso))
}

/** "12" / "7.5" — fractional set counts only show the half. */
export function fmtSets(sets: number): string {
  return Number.isInteger(sets) ? String(sets) : sets.toFixed(1)
}
