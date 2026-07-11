// Month / year workout summaries for the Sessions and Cardio views.
// Pure and timezone-agnostic: callers map workouts to local date keys first
// (localDateKey(w.start_at, timezone)) so all bucketing here is string math.

export interface SummaryItem {
  dateKey: string // 'YYYY-MM-DD' in the user's timezone
  durationS: number
  type: string | null
  /** Workout start/end (epoch ms), when known — powers visit merging below. */
  startMs?: number
  endMs?: number
}

export function isGymType(type: string | null): boolean {
  return !!type && /strength|core/.test(type)
}

/** Mirrors Zone2View's cardio test: anything that isn't gym/other. */
export function isCardioType(type: string | null): boolean {
  return !!type && !/strength|core|other/.test(type)
}

/** 30 minutes, in milliseconds — the back-to-back merge gap threshold below. */
const VISIT_GAP_MS = 30 * 60 * 1000

/**
 * Counts training VISITS rather than raw workout rows: consecutive items
 * (sorted by start time) merge into a single visit when the gap between one
 * item's end and the next item's start is <= 30 minutes AND they fall on the
 * same calendar day (dateKey) — e.g. gym + a short cardio finisher logged
 * back-to-back is one visit, not two. Items missing startMs/endMs can't be
 * compared for adjacency, so each counts as its own visit.
 */
export function countVisits(items: SummaryItem[]): number {
  const timed = items.filter(
    (i): i is SummaryItem & { startMs: number; endMs: number } =>
      i.startMs !== undefined && i.endMs !== undefined
  )
  const untimed = items.length - timed.length

  const sorted = [...timed].sort((a, b) => a.startMs - b.startMs)

  let visits = untimed
  let lastEndMs: number | null = null
  let lastDateKey: string | null = null

  for (const item of sorted) {
    const isMerge =
      lastEndMs !== null &&
      lastDateKey === item.dateKey &&
      item.startMs - lastEndMs <= VISIT_GAP_MS
    if (!isMerge) visits += 1
    lastEndMs = item.endMs
    lastDateKey = item.dateKey
  }

  return visits
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
  // avgWorkoutsPerMonth counts VISITS (gym + a short cardio finisher logged
  // back-to-back is one training visit), not raw workout rows — but only when
  // start/end times are available to judge adjacency. Gym/cardio per-month
  // averages and the monthly `workouts` stat elsewhere stay raw-session
  // counts; only this yearly metric changes.
  const hasTimes = inYear.some((i) => i.startMs !== undefined && i.endMs !== undefined)
  const avgWorkoutsPerMonth = (hasTimes ? countVisits(inYear) : t.workouts) / n
  return {
    monthsCounted: n,
    avgWorkoutsPerMonth,
    avgDurationSPerMonth: t.totalDurationS / n,
    avgGymPerMonth: t.gymSessions / n,
    avgCardioPerMonth: t.cardioSessions / n
  }
}
