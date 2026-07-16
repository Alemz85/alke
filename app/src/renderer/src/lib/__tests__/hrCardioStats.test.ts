import { describe, expect, it } from 'vitest'
import type { Workout } from '@shared/types'
import { avgHrByMonth, lifetimeCardioStats, monthlyCardioTotals, periodCardioTotals, yearlyCardioTotals } from '../hrCardioStats'

function workout(
  id: string,
  startAt: string,
  durationS: number | null,
  avgHr: number | null,
  energyKcal: number | null = null
): Workout {
  return {
    id,
    external_id: null,
    type: 'indoor_cycling',
    start_at: startAt,
    end_at: null,
    duration_s: durationS,
    distance_m: null,
    energy_kcal: energyKcal,
    avg_hr: avgHr,
    max_hr: null,
    source: 'healthkit',
    raw: null,
    computed: null
  }
}

describe('lifetimeCardioStats', () => {
  it('sums sessions, duration, and energy across all workouts', () => {
    const workouts = [
      workout('a', '2026-01-01T10:00:00Z', 1800, 130, 300),
      workout('b', '2026-02-01T10:00:00Z', 2400, 140, 400)
    ]
    const stats = lifetimeCardioStats(workouts)
    expect(stats.sessions).toBe(2)
    expect(stats.durationS).toBe(4200)
    expect(stats.energyKcal).toBe(700)
  })

  it('handles empty input', () => {
    expect(lifetimeCardioStats([])).toEqual({ sessions: 0, durationS: 0, energyKcal: 0 })
  })
})

describe('periodCardioTotals', () => {
  const now = new Date('2026-07-16T12:00:00Z')
  const workouts = [
    workout('a', '2026-07-01T10:00:00Z', 1800, 130), // this month
    workout('b', '2026-06-01T10:00:00Z', 3600, 150), // this year, last month
    workout('c', '2025-01-01T10:00:00Z', 1200, 100) // last year
  ]

  it('filters and duration-weights avg HR for the month', () => {
    const totals = periodCardioTotals(workouts, 'UTC', 'month', now)
    expect(totals.sessions).toBe(1)
    expect(totals.durationS).toBe(1800)
    expect(totals.avgHr).toBe(130)
  })

  it('filters and duration-weights avg HR for the year', () => {
    const totals = periodCardioTotals(workouts, 'UTC', 'year', now)
    expect(totals.sessions).toBe(2)
    // weighted: (130*1800 + 150*3600) / (1800+3600)
    expect(totals.avgHr).toBeCloseTo((130 * 1800 + 150 * 3600) / 5400, 5)
  })

  it('monthlyCardioTotals and yearlyCardioTotals delegate correctly', () => {
    expect(monthlyCardioTotals(workouts, 'UTC', now).sessions).toBe(1)
    expect(yearlyCardioTotals(workouts, 'UTC', now).sessions).toBe(2)
  })

  it('returns null avgHr when no session in period has HR', () => {
    const noHr = [workout('x', '2026-07-05T10:00:00Z', 1800, null)]
    expect(periodCardioTotals(noHr, 'UTC', 'month', now).avgHr).toBeNull()
  })
})

describe('avgHrByMonth', () => {
  it('buckets duration-weighted avg HR per calendar month, sorted ascending', () => {
    const workouts = [
      workout('a', '2026-02-01T10:00:00Z', 1800, 140),
      workout('b', '2026-01-01T10:00:00Z', 3600, 120),
      workout('c', '2026-01-15T10:00:00Z', 1800, 150)
    ]
    const rows = avgHrByMonth(workouts, 'UTC')
    expect(rows.map((r) => r.month)).toEqual(['2026-01', '2026-02'])
    expect(rows[0].sessions).toBe(2)
    expect(rows[0].avgHr).toBeCloseTo((120 * 3600 + 150 * 1800) / 5400, 5)
    expect(rows[1].avgHr).toBe(140)
  })

  it('reports null avgHr for a month with sessions but no HR data', () => {
    const rows = avgHrByMonth([workout('a', '2026-03-01T10:00:00Z', 1800, null)], 'UTC')
    expect(rows).toEqual([{ month: '2026-03', avgHr: null, sessions: 1 }])
  })

  it('handles empty input', () => {
    expect(avgHrByMonth([], 'UTC')).toEqual([])
  })
})
