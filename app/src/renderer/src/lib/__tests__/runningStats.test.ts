import { describe, expect, it } from 'vitest'
import type { Workout } from '@shared/types'
import {
  bestRunAtLeast,
  longestRun,
  monthlyRunningStats,
  monthlyRunningTotals,
  paceSecPerKm,
  periodRunningTotals,
  runningLifetime,
  yearlyRunningTotals
} from '../runningStats'

function workout(
  id: string,
  startAt: string,
  distanceM: number | null,
  durationS: number | null
): Workout {
  return {
    id,
    external_id: null,
    type: 'running',
    start_at: startAt,
    end_at: null,
    duration_s: durationS,
    distance_m: distanceM,
    energy_kcal: null,
    avg_hr: null,
    max_hr: null,
    source: 'runkeeper',
    computed: null
  }
}

describe('paceSecPerKm', () => {
  it('derives elapsed whole-workout pace', () => {
    expect(paceSecPerKm(workout('a', '2026-01-01T10:00:00Z', 5000, 1500))).toBe(300)
  })

  it('rejects missing and non-positive distance or duration', () => {
    expect(paceSecPerKm(workout('a', '2026-01-01T10:00:00Z', null, 1200))).toBeNull()
    expect(paceSecPerKm(workout('b', '2026-01-01T10:00:00Z', 0, 1200))).toBeNull()
    expect(paceSecPerKm(workout('c', '2026-01-01T10:00:00Z', 5000, 0))).toBeNull()
  })
})

describe('bestRunAtLeast', () => {
  const runs = [
    workout('short', '2026-01-01T10:00:00Z', 900, 210),
    workout('five', '2026-02-01T10:00:00Z', 5000, 1500),
    workout('fast', '2026-03-01T10:00:00Z', 6200, 1736)
  ]

  it('finds the fastest whole-run average among eligible runs', () => {
    expect(bestRunAtLeast(runs, 1000)?.workout.id).toBe('fast')
    expect(bestRunAtLeast(runs, 5000)?.paceSecPerKm).toBe(280)
  })

  it('returns null when no run reaches the threshold', () => {
    expect(bestRunAtLeast(runs, 10_000)).toBeNull()
  })
})

describe('monthlyRunningStats', () => {
  it('groups the full history and computes distance-weighted pace', () => {
    const rows = monthlyRunningStats(
      [
        workout('a', '2025-01-02T10:00:00Z', 5000, 1500),
        workout('b', '2025-01-20T10:00:00Z', 10_000, 3600),
        workout('c', '2025-02-01T10:00:00Z', 3000, 900)
      ],
      'UTC'
    )

    expect(rows).toEqual([
      { month: '2025-01', distanceKm: 15, durationS: 5100, runs: 2, paceSecPerKm: 340 },
      { month: '2025-02', distanceKm: 3, durationS: 900, runs: 1, paceSecPerKm: 300 }
    ])
  })
})

describe('longestRun', () => {
  it('returns the run with the greatest distance', () => {
    const runs = [
      workout('short', '2026-01-01T10:00:00Z', 5000, 1500),
      workout('long', '2026-02-01T10:00:00Z', 21_097, 6300),
      workout('mid', '2026-03-01T10:00:00Z', 10_000, 3000)
    ]
    expect(longestRun(runs)).toEqual({ distanceKm: 21.097, durationS: 6300, date: '2026-02-01T10:00:00Z' })
  })

  it('ignores runs with no distance and treats a missing duration as 0', () => {
    const runs = [
      workout('no-distance', '2026-01-01T10:00:00Z', null, 1800),
      workout('zero-distance', '2026-01-02T10:00:00Z', 0, 1200),
      workout('no-duration', '2026-01-03T10:00:00Z', 8000, null)
    ]
    expect(longestRun(runs)).toEqual({ distanceKm: 8, durationS: 0, date: '2026-01-03T10:00:00Z' })
  })

  it('returns null when there are no runs with positive distance', () => {
    expect(longestRun([workout('a', '2026-01-01T10:00:00Z', null, 1200)])).toBeNull()
    expect(longestRun([])).toBeNull()
  })
})

describe('runningLifetime', () => {
  it('counts all runs while summing available duration and distance', () => {
    expect(
      runningLifetime([
        workout('a', '2025-01-02T10:00:00Z', 5000, 1500),
        workout('b', '2025-01-20T10:00:00Z', null, 600)
      ])
    ).toEqual({ runs: 2, distanceKm: 5, durationS: 2100 })
  })
})

describe('periodRunningTotals', () => {
  const now = new Date('2026-03-15T12:00:00Z')
  const runs = [
    workout('a', '2026-03-01T10:00:00Z', 5000, 1500), // this month, this year
    workout('b', '2026-03-10T10:00:00Z', 10_000, 3600), // this month, this year
    workout('c', '2026-02-01T10:00:00Z', 3000, 900), // this year, not this month
    workout('d', '2025-12-01T10:00:00Z', 4000, 1200) // last year
  ]

  it('sums only workouts within the requested calendar month', () => {
    expect(periodRunningTotals(runs, 'UTC', 'month', now)).toEqual({
      runs: 2,
      distanceKm: 15,
      durationS: 5100,
      paceSecPerKm: 340
    })
  })

  it('sums only workouts within the requested calendar year', () => {
    expect(periodRunningTotals(runs, 'UTC', 'year', now)).toEqual({
      runs: 3,
      distanceKm: 18,
      durationS: 6000,
      paceSecPerKm: 6000 / 18
    })
  })

  it('counts runs missing distance/duration without contributing to pace', () => {
    const partial = [...runs, workout('e', '2026-03-05T10:00:00Z', null, 600)]
    expect(periodRunningTotals(partial, 'UTC', 'month', now)).toEqual({
      runs: 3,
      distanceKm: 15,
      durationS: 5100,
      paceSecPerKm: 340
    })
  })

  it('returns zeroed totals and null pace when nothing falls in the period', () => {
    expect(periodRunningTotals(runs, 'UTC', 'month', new Date('2026-06-01T00:00:00Z'))).toEqual({
      runs: 0,
      distanceKm: 0,
      durationS: 0,
      paceSecPerKm: null
    })
  })

  it('monthlyRunningTotals and yearlyRunningTotals delegate to periodRunningTotals', () => {
    expect(monthlyRunningTotals(runs, 'UTC', now)).toEqual(periodRunningTotals(runs, 'UTC', 'month', now))
    expect(yearlyRunningTotals(runs, 'UTC', now)).toEqual(periodRunningTotals(runs, 'UTC', 'year', now))
  })
})
