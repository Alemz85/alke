import { describe, expect, it } from 'vitest'
import { weekLabel } from '../weekLabel'

describe('weekLabel', () => {
  it('labels a mid-year week by its Monday month + nth Monday', () => {
    // 2026-W28 Monday = 2026-07-06 -> 1st Monday of July.
    expect(weekLabel('2026-W28')).toBe('Jul W1')
  })

  it('counts the nth Monday within the month, not the week-of-year', () => {
    // 2026-W02 Monday = 2026-01-05 -> 1st Monday of January.
    expect(weekLabel('2026-W02')).toBe('Jan W1')
    // 2025-W52 Monday = 2025-12-22 -> 4th Monday of December.
    expect(weekLabel('2025-W52')).toBe('Dec W4')
  })

  it('handles a late-in-month Monday (5th occurrence)', () => {
    // 2026-W01 Monday = 2025-12-29 -> 5th Monday of December.
    expect(weekLabel('2026-W01')).toBe('Dec W5')
  })

  it('crosses a year boundary when the ISO week-1 Monday falls in the prior December', () => {
    expect(weekLabel('2026-W01')).toBe('Dec W5')
  })

  it('handles an ISO 53-week year', () => {
    // 2026-W53 Monday = 2026-12-28 -> 4th Monday of December.
    expect(weekLabel('2026-W53')).toBe('Dec W4')
  })

  it('is stable across a full year of weeks (no throws, always "Mon Wn")', () => {
    for (let w = 1; w <= 52; w++) {
      const key = `2026-W${String(w).padStart(2, '0')}`
      expect(weekLabel(key)).toMatch(/^[A-Z][a-z]{2} W[1-5]$/)
    }
  })
})
