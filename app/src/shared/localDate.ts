/**
 * Calendar-date key for an instant in an IANA timezone.
 *
 * Date-only health rows are keyed to the athlete's configured calendar, not
 * UTC. Invalid/missing zones fall back to UTC so a bad persisted setting can
 * never turn a write into an invalid date.
 */
export function dateKeyInTimeZone(
  instant: string | number | Date,
  timezone: string | null | undefined
): string {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) throw new Error('invalid date instant')

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((candidate) => candidate.type === type)?.value ?? ''
    const year = part('year')
    const month = part('month')
    const day = part('day')
    if (year && month && day) return `${year}-${month}-${day}`
  } catch {
    // Fall through to the instant's UTC date for an invalid timezone.
  }

  return date.toISOString().slice(0, 10)
}
