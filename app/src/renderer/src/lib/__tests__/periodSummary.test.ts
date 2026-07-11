import { describe, expect, it } from 'vitest'
import { countVisits, isCardioType, isGymType, monthSummary, yearSummary } from '../periodSummary'
import type { SummaryItem } from '../periodSummary'

function item(dateKey: string, type: string, durationS = 3600): SummaryItem {
  return { dateKey, durationS, type }
}

function timedItem(
  dateKey: string,
  type: string,
  startMs: number,
  endMs: number
): SummaryItem {
  return { dateKey, type, durationS: (endMs - startMs) / 1000, startMs, endMs }
}

describe('type classification', () => {
  it('splits gym from cardio the way Zone2View does', () => {
    expect(isGymType('functional_strength_training')).toBe(true)
    expect(isGymType('core_training')).toBe(true)
    expect(isGymType('pool_swim')).toBe(false)
    expect(isCardioType('pool_swim')).toBe(true)
    expect(isCardioType('indoor_cycling')).toBe(true)
    expect(isCardioType('functional_strength_training')).toBe(false)
    expect(isCardioType(null)).toBe(false)
  })
})

describe('monthSummary', () => {
  const items = [
    item('2026-06-05', 'pool_swim', 1800),
    item('2026-06-20', 'functional_strength_training', 3600),
    item('2026-07-03', 'pool_swim', 2400),
    item('2026-07-08', 'functional_strength_training', 3600),
    item('2026-07-09', 'pool_swim', 2400)
  ]

  it('totals the viewed month', () => {
    const s = monthSummary(items, '2026-07', '2026-07-11')
    expect(s.workouts).toBe(3)
    expect(s.totalDurationS).toBe(8400)
    expect(s.gymSessions).toBe(1)
    expect(s.cardioSessions).toBe(2)
  })

  it('trends current month-to-date against previous month cut at the same day', () => {
    // Through day 11: July = 8400s, June (through Jun 11) = 1800s -> +366.7%
    const s = monthSummary(items, '2026-07', '2026-07-11')
    expect(s.timeTrendPct).toBeCloseTo(((8400 - 1800) / 1800) * 100)
  })

  it('trends a past month against the FULL previous month', () => {
    const s = monthSummary(items, '2026-07', '2026-08-02') // August: July is now a past month
    expect(s.timeTrendPct).toBeCloseTo(((8400 - 5400) / 5400) * 100)
  })

  it('is null when the previous window has no time', () => {
    expect(monthSummary(items, '2026-06', '2026-07-11').timeTrendPct).toBeNull()
  })

  it('handles the January -> December year boundary', () => {
    const jan = [item('2025-12-30', 'pool_swim', 1000), item('2026-01-02', 'pool_swim', 2000)]
    const s = monthSummary(jan, '2026-01', '2026-02-05')
    expect(s.timeTrendPct).toBeCloseTo(100)
  })
})

describe('yearSummary', () => {
  it('averages over months that have data', () => {
    const s = yearSummary(
      [
        item('2026-06-05', 'pool_swim', 1800),
        item('2026-06-20', 'functional_strength_training', 3600),
        item('2026-07-03', 'pool_swim', 2400),
        item('2025-11-01', 'pool_swim', 900) // other year — excluded
      ],
      2026
    )
    expect(s.monthsCounted).toBe(2)
    expect(s.avgWorkoutsPerMonth).toBeCloseTo(1.5)
    expect(s.avgDurationSPerMonth).toBeCloseTo((1800 + 3600 + 2400) / 2)
    expect(s.avgGymPerMonth).toBeCloseTo(0.5)
    expect(s.avgCardioPerMonth).toBeCloseTo(1)
  })

  it('zeroes out an empty year', () => {
    expect(yearSummary([], 2026).monthsCounted).toBe(0)
  })

  it('avgWorkoutsPerMonth counts visits (merged) when start/end times are present', () => {
    const day = '2026-07-08'
    const base = Date.UTC(2026, 6, 8, 8, 0, 0) // 08:00 UTC
    const items = [
      // Back-to-back gym + cardio same day -> merges to 1 visit.
      timedItem(day, 'functional_strength_training', base, base + 45 * 60 * 1000),
      timedItem(day, 'indoor_cycling', base + 50 * 60 * 1000, base + 65 * 60 * 1000)
    ]
    const s = yearSummary(items, 2026)
    expect(s.monthsCounted).toBe(1)
    expect(s.avgWorkoutsPerMonth).toBe(1) // visits, not the 2 raw rows
  })

  it('falls back to raw workout counts when no items have times', () => {
    const items = [item('2026-07-08', 'functional_strength_training'), item('2026-07-08', 'indoor_cycling')]
    const s = yearSummary(items, 2026)
    expect(s.avgWorkoutsPerMonth).toBe(2)
  })
})

describe('countVisits', () => {
  it('merges back-to-back gym + cardio into one visit', () => {
    const day = '2026-07-08'
    const base = Date.UTC(2026, 6, 8, 8, 0, 0)
    const items = [
      timedItem(day, 'functional_strength_training', base, base + 45 * 60 * 1000),
      timedItem(day, 'indoor_cycling', base + 50 * 60 * 1000, base + 65 * 60 * 1000)
    ]
    expect(countVisits(items)).toBe(1)
  })

  it('a 2-hour gap between sessions stays 2 visits', () => {
    const day = '2026-07-08'
    const base = Date.UTC(2026, 6, 8, 8, 0, 0)
    const items = [
      timedItem(day, 'functional_strength_training', base, base + 45 * 60 * 1000),
      timedItem(day, 'indoor_cycling', base + 165 * 60 * 1000, base + 200 * 60 * 1000) // 2h gap after end
    ]
    expect(countVisits(items)).toBe(2)
  })

  it('a morning swim and an evening gym on the same day stay 2 visits', () => {
    const day = '2026-07-08'
    const morningStart = Date.UTC(2026, 6, 8, 6, 0, 0)
    const eveningStart = Date.UTC(2026, 6, 8, 18, 0, 0)
    const items = [
      timedItem(day, 'pool_swim', morningStart, morningStart + 40 * 60 * 1000),
      timedItem(day, 'functional_strength_training', eveningStart, eveningStart + 50 * 60 * 1000)
    ]
    expect(countVisits(items)).toBe(2)
  })

  it('does not merge across midnight even if the gap is small', () => {
    const day1Start = Date.UTC(2026, 6, 8, 23, 45, 0)
    const day2Start = Date.UTC(2026, 6, 9, 0, 5, 0) // 20 min later, next calendar day
    const items = [
      timedItem('2026-07-08', 'functional_strength_training', day1Start, day1Start + 10 * 60 * 1000),
      timedItem('2026-07-09', 'indoor_cycling', day2Start, day2Start + 30 * 60 * 1000)
    ]
    expect(countVisits(items)).toBe(2)
  })

  it('items missing times each count as their own visit', () => {
    const items = [item('2026-07-08', 'pool_swim'), item('2026-07-08', 'functional_strength_training')]
    expect(countVisits(items)).toBe(2)
  })
})
