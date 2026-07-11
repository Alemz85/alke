import { describe, expect, it } from 'vitest'
import { isCardioType, isGymType, monthSummary, yearSummary } from '../periodSummary'
import type { SummaryItem } from '../periodSummary'

function item(dateKey: string, type: string, durationS = 3600): SummaryItem {
  return { dateKey, durationS, type }
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
})
