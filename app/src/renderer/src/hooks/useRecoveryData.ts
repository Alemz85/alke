// Recovery-tab-scoped data hooks. Kept in its own file per the "own file,
// dedupe later" convention shared with useDashboardData.ts / useSessionsData.ts.
// Each range-aware hook fetches the widest window a chart on this tab may need
// (up to 1y) with its own query keys so it doesn't collide with other views'
// caches, and re-slicing to a shorter range client-side is instant.
import { useQuery } from '@tanstack/react-query'
import type { ComputedDaily, DailyMetric, Flag, UserConfig } from '@shared/types'
import type { ChipRange } from '../components'
import { addDays, todayYMD, ymdKey } from './sessionsDate'

export const RANGE_DAYS: Record<ChipRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365
}

function isoDateNDaysAgo(n: number, timezone?: string | null): string {
  return ymdKey(addDays(todayYMD(timezone), -n))
}

function isoDateToday(timezone?: string | null): string {
  return ymdKey(todayYMD(timezone))
}

/** Daily metrics (RHR, HRV, sleep, steps, etc.) for the last N days. */
export function useRecoveryDailyMetrics(days: number, timezone?: string | null) {
  const fromDate = isoDateNDaysAgo(days, timezone)
  const toDate = isoDateToday(timezone)
  return useQuery<DailyMetric[]>({
    queryKey: ['recovery', 'dailyMetrics', fromDate, toDate],
    queryFn: () => window.api.getDailyMetrics(fromDate, toDate)
  })
}

/** Computed daily rows (rhr_baseline_60d, hrv_baseline_60d, ...) for the last N days. Empty until the nightly job exists. */
export function useRecoveryComputedDaily(days: number, timezone?: string | null) {
  const fromDate = isoDateNDaysAgo(days, timezone)
  const toDate = isoDateToday(timezone)
  return useQuery<ComputedDaily[]>({
    queryKey: ['recovery', 'computedDaily', fromDate, toDate],
    queryFn: () => window.api.getComputedDaily(fromDate, toDate)
  })
}

export function useRecoveryUserConfig() {
  return useQuery<UserConfig>({
    queryKey: ['recovery', 'userConfig'],
    queryFn: () => window.api.getUserConfig()
  })
}

export function useRecoveryTodayFlags() {
  return useQuery<Flag[]>({
    queryKey: ['recovery', 'todayFlags'],
    queryFn: () => window.api.getTodayFlags()
  })
}
