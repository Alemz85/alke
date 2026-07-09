// Recovery-tab-scoped data hooks. Kept in its own file per the "own file,
// dedupe later" convention shared with useDashboardData.ts / useSessionsData.ts.
// Each range-aware hook fetches the widest window a chart on this tab may need
// (up to 1y) with its own query keys so it doesn't collide with other views'
// caches, and re-slicing to a shorter range client-side is instant.
import { useQuery } from '@tanstack/react-query'
import type { ComputedDaily, DailyMetric, Flag, UserConfig } from '@shared/types'
import type { ChipRange } from '../components'

const DAY_MS = 24 * 60 * 60 * 1000

export const RANGE_DAYS: Record<ChipRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365
}

function isoDateNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * DAY_MS)
  return d.toISOString().slice(0, 10)
}

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Daily metrics (RHR, HRV, sleep, steps, etc.) for the last N days. */
export function useRecoveryDailyMetrics(days: number) {
  const fromDate = isoDateNDaysAgo(days)
  const toDate = isoDateToday()
  return useQuery<DailyMetric[]>({
    queryKey: ['recovery', 'dailyMetrics', fromDate, toDate],
    queryFn: () => window.api.getDailyMetrics(fromDate, toDate)
  })
}

/** Computed daily rows (rhr_baseline_60d, hrv_baseline_60d, ...) for the last N days. Empty until the nightly job exists. */
export function useRecoveryComputedDaily(days: number) {
  const fromDate = isoDateNDaysAgo(days)
  const toDate = isoDateToday()
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
