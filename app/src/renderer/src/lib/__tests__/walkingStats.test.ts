import { describe, expect, it } from 'vitest'
import type { DailyMetric, Workout } from '@shared/types'
import {
  averageDailySteps,
  dailyStepsSeries,
  explicitWalkStats,
  periodStepsTotals,
  recentWalkDates,
  todayVsAvgSteps,
  weeklyStepsTotals
} from '../walkingStats'

function metric(date: string, steps: number | null): DailyMetric {
  return {
    date,
    resting_hr: null,
    hrv_sdnn_ms: null,
    respiratory_rate: null,
    sleep_start: null,
    sleep_end: null,
    sleep_duration_min: null,
    sleep_stages: null,
    vo2max: null,
    steps,
    active_energy_kcal: null,
    wrist_temp_deviation_c: null,
    weight_kg: null,
    state_of_mind: null
  }
}

function workout(id: string, startAt: string, distanceM: number | null, durationS: number | null): Workout {
  return {
    id,
    external_id: null,
    type: 'outdoor_walk',
    start_at: startAt,
    end_at: null,
    duration_s: durationS,
    distance_m: distanceM,
    energy_kcal: null,
    avg_hr: null,
    max_hr: null,
    source: 'healthkit',
    raw: null,
    computed: null
  }
}

const REAL_NOW = Date.now
function mockToday(iso: string): void {
  Date.now = () => new Date(iso).getTime()
}
function restoreNow(): void {
  Date.now = REAL_NOW
}

describe('dailyStepsSeries', () => {
  it('zero-fills a continuous window ending today, in the given timezone', () => {
    mockToday('2026-07-16T12:00:00Z')
    try {
      const metrics = [metric('2026-07-14', 5000), metric('2026-07-16', 8000)]
      const series = dailyStepsSeries(metrics, 'UTC', 3)
      expect(series).toEqual([
        { date: '2026-07-14', steps: 5000 },
        { date: '2026-07-15', steps: 0 },
        { date: '2026-07-16', steps: 8000 }
      ])
    } finally {
      restoreNow()
    }
  })

  it('sums multiple rows landing on the same date key', () => {
    mockToday('2026-07-16T12:00:00Z')
    try {
      const metrics = [metric('2026-07-16', 3000), metric('2026-07-16', 500)]
      const series = dailyStepsSeries(metrics, 'UTC', 1)
      expect(series).toEqual([{ date: '2026-07-16', steps: 3500 }])
    } finally {
      restoreNow()
    }
  })

  it('treats null steps as absent, not zero contribution beyond the day defaulting to 0', () => {
    const metrics = [metric('2026-07-16', null)]
    mockToday('2026-07-16T12:00:00Z')
    try {
      const series = dailyStepsSeries(metrics, 'UTC', 1)
      expect(series).toEqual([{ date: '2026-07-16', steps: 0 }])
    } finally {
      restoreNow()
    }
  })
})

describe('weeklyStepsTotals', () => {
  it('buckets into Monday-anchored ISO weeks, zero-filled', () => {
    mockToday('2026-07-16T12:00:00Z') // Thursday of 2026-W29
    try {
      const metrics = [
        metric('2026-07-13', 4000), // Monday of W29
        metric('2026-07-06', 2000) // Monday of W28
      ]
      const totals = weeklyStepsTotals(metrics, 'UTC', 3)
      expect(totals.map((t) => t.steps)).toEqual([0, 2000, 4000])
      expect(totals[2].key).toBe('2026-W29')
    } finally {
      restoreNow()
    }
  })
})

describe('periodStepsTotals', () => {
  it('sums this-week and this-month steps up to today', () => {
    mockToday('2026-07-16T12:00:00Z')
    try {
      const metrics = [
        metric('2026-07-01', 1000), // this month, before this week
        metric('2026-07-13', 3000), // this week (Monday)
        metric('2026-07-16', 5000), // today
        metric('2026-06-30', 9999) // last month — excluded
      ]
      const totals = periodStepsTotals(metrics, 'UTC')
      expect(totals.thisWeek).toBe(8000)
      expect(totals.thisMonth).toBe(9000)
    } finally {
      restoreNow()
    }
  })
})

describe('todayVsAvgSteps', () => {
  it('computes delta pct against the trailing baseline, excluding today', () => {
    mockToday('2026-07-16T12:00:00Z')
    try {
      const metrics = [
        metric('2026-07-15', 4000),
        metric('2026-07-14', 6000),
        metric('2026-07-16', 8000) // today — must not be in its own baseline
      ]
      const result = todayVsAvgSteps(metrics, 'UTC', 30)
      expect(result.today).toBe(8000)
      expect(result.avg).toBe(5000)
      expect(result.deltaPct).toBe(60)
    } finally {
      restoreNow()
    }
  })

  it('returns null today and null delta when today has no data yet', () => {
    mockToday('2026-07-16T12:00:00Z')
    try {
      const result = todayVsAvgSteps([metric('2026-07-15', 4000)], 'UTC', 30)
      expect(result.today).toBeNull()
      expect(result.deltaPct).toBeNull()
    } finally {
      restoreNow()
    }
  })
})

describe('averageDailySteps', () => {
  it('averages the zero-filled window', () => {
    mockToday('2026-07-16T12:00:00Z')
    try {
      const metrics = [metric('2026-07-16', 10000)]
      expect(averageDailySteps(metrics, 'UTC', 2)).toBe(5000)
    } finally {
      restoreNow()
    }
  })
})

describe('explicitWalkStats', () => {
  const now = new Date('2026-07-16T12:00:00Z')
  const workouts = [
    workout('a', '2026-07-01T10:00:00Z', 3000, 1800), // this month + year
    workout('b', '2025-01-01T10:00:00Z', 5000, 2400), // last year
    workout('c', '2026-06-01T10:00:00Z', 2000, 1200) // this year, last month
  ]

  it('sums lifetime across all', () => {
    const stats = explicitWalkStats(workouts, 'UTC', 'lifetime', now)
    expect(stats.count).toBe(3)
    expect(stats.distanceKm).toBeCloseTo(10)
    expect(stats.durationS).toBe(5400)
  })

  it('filters to this month', () => {
    const stats = explicitWalkStats(workouts, 'UTC', 'month', now)
    expect(stats.count).toBe(1)
    expect(stats.distanceKm).toBeCloseTo(3)
  })

  it('filters to this year', () => {
    const stats = explicitWalkStats(workouts, 'UTC', 'year', now)
    expect(stats.count).toBe(2)
    expect(stats.distanceKm).toBeCloseTo(5)
  })
})

describe('recentWalkDates', () => {
  it('returns the N most recent dates, newest first', () => {
    const workouts = [
      workout('a', '2026-07-01T10:00:00Z', 1000, 600),
      workout('b', '2026-07-10T10:00:00Z', 1000, 600),
      workout('c', '2026-07-05T10:00:00Z', 1000, 600)
    ]
    expect(recentWalkDates(workouts, 'UTC', 2)).toEqual(['2026-07-10', '2026-07-05'])
  })
})
