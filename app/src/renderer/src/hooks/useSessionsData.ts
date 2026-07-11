// THE canonical data-hooks module ("dedupe later" arrived): every view that
// needs config, workouts, daily metrics, or the zone2 model fetches through
// these hooks. Query keys are view-neutral ('health', …) so consumers share
// one cache entry by construction instead of by key-string convention.
import { useQuery } from '@tanstack/react-query'
import type { DailyMetric, UserConfig, Workout, WorkoutDetail, Zone2Fitness } from '@shared/types'
import { addDays, isoWeekStart, todayYMD, ymdToIsoStart, type YMD } from './sessionsDate'

export function useUserConfig() {
  return useQuery<UserConfig>({
    queryKey: ['health', 'userConfig'],
    queryFn: () => window.api.getUserConfig()
  })
}

/** Daily metrics rows for [fromDate, toDate] ('YYYY-MM-DD', inclusive). */
export function useDailyMetricsRange(fromDate: string, toDate: string) {
  return useQuery<DailyMetric[]>({
    queryKey: ['health', 'dailyMetrics', fromDate, toDate],
    queryFn: () => window.api.getDailyMetrics(fromDate, toDate),
    staleTime: 60_000
  })
}

/** Nightly zone2 model rows for [fromDate, toDate] ('YYYY-MM-DD', inclusive). */
export function useZone2FitnessRange(fromDate: string, toDate: string) {
  return useQuery<Zone2Fitness[]>({
    queryKey: ['health', 'zone2Fitness', fromDate, toDate],
    queryFn: () => window.api.getZone2Fitness(fromDate, toDate),
    staleTime: 60_000
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
    queryKey: ['health', 'monthWorkouts', year, month],
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
    queryKey: ['health', 'yearWorkouts', fromIso.slice(0, 10)],
    queryFn: () => window.api.getWorkouts(fromIso, toIso),
    staleTime: 60_000
  })
}

export function useWorkoutDetail(id: string | null) {
  return useQuery<WorkoutDetail>({
    queryKey: ['health', 'workoutDetail', id],
    queryFn: () => window.api.getWorkoutDetail(id as string),
    enabled: id !== null
  })
}

/** Re-exported for convenience so callers importing hooks don't also need the date module. */
export { isoWeekStart }
