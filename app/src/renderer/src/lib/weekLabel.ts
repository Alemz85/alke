// Human-friendly labels for ISO week keys ("YYYY-Www", Monday-anchored, as
// produced by hooks/sessionsDate's isoWeekKey). Raw week numbers ("W28") are
// meaningless to a reader — this maps a week to the month its Monday falls
// in, plus which Monday of that month it is (1-5), e.g. "Jun W1".

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

/** UTC-anchored Monday date for an ISO week key, via the ISO week-1 anchor (Jan 4). */
function isoWeekMonday(isoWeekKey: string): Date {
  const [yStr, wStr] = isoWeekKey.split('-W')
  const isoYear = Number(yStr)
  const weekNo = Number(wStr)
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const jan4Weekday = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay() // 1=Mon..7=Sun
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Weekday - 1))
  const monday = new Date(week1Monday)
  monday.setUTCDate(week1Monday.getUTCDate() + (weekNo - 1) * 7)
  return monday
}

/**
 * Human label for an ISO week key: month short-name of that week's Monday,
 * plus which Monday of that month it is (1-5) — "Jun W1", "Dec W5". A week
 * whose Monday sits in a different month/year than the ISO week's nominal
 * year (e.g. week 1 starting in late December) is labeled by the Monday's
 * actual calendar month, not the ISO year.
 */
export function weekLabel(isoWeekKey: string): string {
  const monday = isoWeekMonday(isoWeekKey)
  const monthShort = MONTH_SHORT[monday.getUTCMonth()]
  const nthMonday = Math.floor((monday.getUTCDate() - 1) / 7) + 1
  return `${monthShort} W${nthMonday}`
}
