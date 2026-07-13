// Month / year workout summaries for the Sessions and Cardio views.
// Pure and timezone-agnostic: callers map workouts to local date keys first
// (localDateKey(w.start_at, timezone)) so all bucketing here is string math.

import { activityEnvironment } from './modality'

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
 * Groups workout rows into training VISITS (single sittings). Consecutive
 * items (sorted by start time) merge into one visit when:
 *   - the gap between one item's end and the next item's start is <= 30 min,
 *   - they fall on the same calendar day (dateKey), and
 *   - they happen in the same ENVIRONMENT (water / indoor / outdoor) — a
 *     rowing-erg warm-up + bike + lifting at the gym is ONE visit, while a
 *     swim followed straight by a gym session is two (pool -> gym floor is a
 *     different sitting, per user rule).
 * Items missing startMs/endMs (or type) can't be compared for adjacency, so
 * each counts as its own visit.
 */
export function groupVisits(items: SummaryItem[]): SummaryItem[][] {
  const timed: (SummaryItem & { startMs: number; endMs: number })[] = []
  const untimed: SummaryItem[] = []
  for (const i of items) {
    if (i.startMs !== undefined && i.endMs !== undefined && i.type !== null) {
      timed.push(i as SummaryItem & { startMs: number; endMs: number })
    } else {
      untimed.push(i)
    }
  }

  const sorted = [...timed].sort((a, b) => a.startMs - b.startMs)

  const visits: SummaryItem[][] = untimed.map((i) => [i])
  let current: SummaryItem[] | null = null
  let lastEndMs: number | null = null
  let lastDateKey: string | null = null
  let lastEnv: string | null = null

  for (const item of sorted) {
    const env = activityEnvironment(item.type ?? '')
    const isMerge =
      current !== null &&
      lastEndMs !== null &&
      lastDateKey === item.dateKey &&
      lastEnv === env &&
      item.startMs - lastEndMs <= VISIT_GAP_MS
    if (isMerge && current) {
      current.push(item)
    } else {
      current = [item]
      visits.push(current)
    }
    // The visit's reach extends to the latest end seen so far, so a long
    // workout followed by a short one logged inside it still chains.
    lastEndMs = lastEndMs !== null && current.length > 1 ? Math.max(lastEndMs, item.endMs) : item.endMs
    lastDateKey = item.dateKey
    lastEnv = env
  }

  return visits
}

/** Number of single-sitting training visits — see groupVisits. */
export function countVisits(items: SummaryItem[]): number {
  return groupVisits(items).length
}

/** A visit containing ANY gym item counts as a gym session (mixed sittings — cardio warm-up + lifting — are gym). */
function isGymVisit(visit: SummaryItem[]): boolean {
  return visit.some((i) => isGymType(i.type))
}

/** A cardio session is a visit that has cardio work and no gym work. */
function isCardioVisit(visit: SummaryItem[]): boolean {
  return !isGymVisit(visit) && visit.some((i) => isCardioType(i.type))
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

// All session COUNTS are visit-based (single sittings, see groupVisits) so a
// cardio warm-up logged separately from the lifting that followed it doesn't
// double-count. Total time still sums every row. Items without start/end
// times degrade gracefully: each is its own visit, i.e. the old raw count.
function totals(items: SummaryItem[]): Omit<MonthSummary, 'timeTrendPct'> {
  const visits = groupVisits(items)
  return {
    workouts: visits.length,
    totalDurationS: items.reduce((sum, i) => sum + i.durationS, 0),
    gymSessions: visits.filter(isGymVisit).length,
    cardioSessions: visits.filter(isCardioVisit).length
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
  // totals() is visit-based across the board (see groupVisits), so every
  // per-month average here counts single sittings, not raw workout rows.
  const t = totals(inYear)
  return {
    monthsCounted: n,
    avgWorkoutsPerMonth: t.workouts / n,
    avgDurationSPerMonth: t.totalDurationS / n,
    avgGymPerMonth: t.gymSessions / n,
    avgCardioPerMonth: t.cardioSessions / n
  }
}
