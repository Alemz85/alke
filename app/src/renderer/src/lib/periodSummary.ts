// Month / year workout summaries for the Sessions and Cardio views.
// Pure and timezone-agnostic: callers map workouts to local date keys first
// (localDateKey(w.start_at, timezone)) so all bucketing here is string math.

export interface SummaryItem {
  dateKey: string // 'YYYY-MM-DD' in the user's timezone
  durationS: number
  type: string | null
}

export function isGymType(type: string | null): boolean {
  return !!type && /strength|core/.test(type)
}

/** Mirrors Zone2View's cardio test: anything that isn't gym/other. */
export function isCardioType(type: string | null): boolean {
  return !!type && !/strength|core|other/.test(type)
}

export interface MonthSummary {
  workouts: number
  totalDurationS: number
  gymSessions: number
  cardioSessions: number
  /**
   * % change of total time vs the PREVIOUS month over a comparable window:
   * viewing the current month compares month-to-date against the previous
   * month cut at the same day-of-month; viewing a past month compares full
   * month against full previous month. Null when the previous window has no
   * training time.
   */
  timeTrendPct: number | null
}

const monthKey = (dateKey: string): string => dateKey.slice(0, 7)
const dayOfMonth = (dateKey: string): number => Number(dateKey.slice(8, 10))

function prevMonthKey(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

function totals(items: SummaryItem[]): Omit<MonthSummary, 'timeTrendPct'> {
  return {
    workouts: items.length,
    totalDurationS: items.reduce((sum, i) => sum + i.durationS, 0),
    gymSessions: items.filter((i) => isGymType(i.type)).length,
    cardioSessions: items.filter((i) => isCardioType(i.type)).length
  }
}

/**
 * Summary of the month containing `viewedYm` ('YYYY-MM'). `todayKey` decides
 * the trend window (see MonthSummary.timeTrendPct).
 */
export function monthSummary(
  items: SummaryItem[],
  viewedYm: string,
  todayKey: string
): MonthSummary {
  const isCurrentMonth = monthKey(todayKey) === viewedYm
  const cutDay = isCurrentMonth ? dayOfMonth(todayKey) : 31

  const inMonth = items.filter((i) => monthKey(i.dateKey) === viewedYm)
  const prevYm = prevMonthKey(viewedYm)
  const prevWindow = items.filter(
    (i) => monthKey(i.dateKey) === prevYm && dayOfMonth(i.dateKey) <= cutDay
  )
  const currentWindow = inMonth.filter((i) => dayOfMonth(i.dateKey) <= cutDay)

  const prevTime = prevWindow.reduce((sum, i) => sum + i.durationS, 0)
  const currentTime = currentWindow.reduce((sum, i) => sum + i.durationS, 0)

  return {
    ...totals(inMonth),
    timeTrendPct: prevTime > 0 ? ((currentTime - prevTime) / prevTime) * 100 : null
  }
}

export interface YearSummary {
  /** Months of the year with at least one workout — the averaging divisor. */
  monthsCounted: number
  avgWorkoutsPerMonth: number
  avgDurationSPerMonth: number
  avgGymPerMonth: number
  avgCardioPerMonth: number
}

/** Per-month averages across the given year, over months that have data. */
export function yearSummary(items: SummaryItem[], year: number): YearSummary {
  const inYear = items.filter((i) => i.dateKey.startsWith(`${year}-`))
  const months = new Set(inYear.map((i) => monthKey(i.dateKey)))
  const n = months.size
  if (n === 0) {
    return {
      monthsCounted: 0,
      avgWorkoutsPerMonth: 0,
      avgDurationSPerMonth: 0,
      avgGymPerMonth: 0,
      avgCardioPerMonth: 0
    }
  }
  const t = totals(inYear)
  return {
    monthsCounted: n,
    avgWorkoutsPerMonth: t.workouts / n,
    avgDurationSPerMonth: t.totalDurationS / n,
    avgGymPerMonth: t.gymSessions / n,
    avgCardioPerMonth: t.cardioSessions / n
  }
}
