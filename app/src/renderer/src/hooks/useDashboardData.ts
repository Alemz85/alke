// Dashboard-scoped data hooks. Kept separate from other tabs' hooks per the
// "own file, dedupe later" convention — other views may grow their own
// equivalents that fetch overlapping ranges with different windows.
import { useQuery } from '@tanstack/react-query'
import type { ComputedDaily, DailyMetric, UserConfig, Workout } from '@shared/types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Exported so views can build date-filtered slices of a widened query window (e.g. the dashboard's 90d CTL/ATL card carved out of a 365d pull). */
export function isoDateNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * DAY_MS)
  return d.toISOString().slice(0, 10)
}

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Recent workouts (dashboard's last-4 box) — fetch a generous 90d window and
 * slice, since there's no
 * "limit" API. The window bounds are snapped to whole calendar days so the
 * query key is stable within a day; using millisecond-precision ISO timestamps
 * here made the key change on every render, spawning an endless refetch loop
 * that left the query perpetually `pending` (and the list perpetually empty).
 */
export function useRecentWorkouts() {
  const fromIso = `${isoDateNDaysAgo(90)}T00:00:00.000Z`
  const toIso = `${isoDateToday()}T23:59:59.999Z`
  return useQuery<Workout[]>({
    queryKey: ['dashboard', 'workouts', fromIso, toIso],
    queryFn: () => window.api.getWorkouts(fromIso, toIso)
  })
}

/** All workouts in the current ISO week (for session-adherence counting). */
export function useWorkoutsInRange(fromIso: string, toIso: string) {
  return useQuery<Workout[]>({
    queryKey: ['dashboard', 'workoutsRange', fromIso, toIso],
    queryFn: () => window.api.getWorkouts(fromIso, toIso)
  })
}

/**
 * Daily metrics (RHR, HRV, sleep, steps) for the last N days. Callers wanting
 * a richer history graph (e.g. the dashboard's metric-detail popups) may pass
 * a wide window like 365 — the existing calcs filter to their own narrower
 * range by date, so widening this pull is safe.
 */
export function useDailyMetrics(days: number) {
  const fromDate = isoDateNDaysAgo(days)
  const toDate = isoDateToday()
  return useQuery<DailyMetric[]>({
    queryKey: ['dashboard', 'dailyMetrics', fromDate, toDate],
    queryFn: () => window.api.getDailyMetrics(fromDate, toDate)
  })
}

/**
 * Computed daily rows (CTL/ATL/TSB/TRIMP) for the last N days. Empty until
 * the nightly job exists. See `useDailyMetrics` re: widening for history graphs.
 */
export function useComputedDaily(days: number) {
  const fromDate = isoDateNDaysAgo(days)
  const toDate = isoDateToday()
  return useQuery<ComputedDaily[]>({
    queryKey: ['dashboard', 'computedDaily', fromDate, toDate],
    queryFn: () => window.api.getComputedDaily(fromDate, toDate)
  })
}

export function useUserConfig() {
  return useQuery<UserConfig>({
    queryKey: ['dashboard', 'userConfig'],
    queryFn: () => window.api.getUserConfig()
  })
}

