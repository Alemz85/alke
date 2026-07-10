// Sessions-tab-scoped data hooks. Kept in its own file per the "own file,
// dedupe later" convention shared with useDashboardData.ts — this tab fetches
// overlapping workout ranges (visible month, full year for streaks) with its
// own query keys so it doesn't collide with other views' caches.
import { useQuery } from '@tanstack/react-query'
import type { UserConfig, Workout, WorkoutDetail } from '@shared/types'
import { addDays, isoWeekStart, todayYMD, ymdToIsoStart, type YMD } from './sessionsDate'

export function useUserConfig() {
  return useQuery<UserConfig>({
    queryKey: ['sessions', 'userConfig'],
    queryFn: () => window.api.getUserConfig()
  })
}

/**
 * Workouts spanning a given month, with a small buffer on either side so the
 * calendar grid's leading/trailing days from adjacent months are covered too.
 */
export function useMonthWorkouts(year: number, month: number) {
  const monthStart: YMD = { year, month, day: 1 }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const monthEnd: YMD = { year, month, day: daysInMonth }

  // Buffer of 7 days each side comfortably covers the leading/trailing grid
  // cells from adjacent months regardless of which weekday the month starts on.
  const fromIso = ymdToIsoStart(addDays(monthStart, -7))
  const toIso = ymdToIsoStart(addDays(monthEnd, 8)) // +1 day to make range end-exclusive-safe, +7 buffer

  return useQuery<Workout[]>({
    queryKey: ['sessions', 'monthWorkouts', year, month],
    queryFn: () => window.api.getWorkouts(fromIso, toIso),
    staleTime: 60_000
  })
}

/**
 * A full year of workouts (trailing 365 days from today), fetched once and
 * reused for the longest-streak computation, which needs history wider than
 * any single visible month.
 */
export function useYearWorkouts(timezone: string | null | undefined) {
  const today = todayYMD(timezone)
  const fromIso = ymdToIsoStart(addDays(today, -365))
  const toIso = ymdToIsoStart(addDays(today, 1))

  return useQuery<Workout[]>({
    queryKey: ['sessions', 'yearWorkouts', fromIso.slice(0, 10)],
    queryFn: () => window.api.getWorkouts(fromIso, toIso),
    staleTime: 60_000
  })
}

export function useWorkoutDetail(id: string | null) {
  return useQuery<WorkoutDetail>({
    queryKey: ['sessions', 'workoutDetail', id],
    queryFn: () => window.api.getWorkoutDetail(id as string),
    enabled: id !== null
  })
}

/** Re-exported for convenience so callers importing hooks don't also need the date module. */
export { isoWeekStart }
