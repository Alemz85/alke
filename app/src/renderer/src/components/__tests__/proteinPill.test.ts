import { describe, expect, it } from 'vitest'
import type { ProteinDay } from '@shared/types'
import { deriveProteinGlance } from '../ProteinPill'
import { isoWeekStart } from '../../hooks/sessionsDate'

// Mon 2026-07-13 anchors the ISO week containing Thu 2026-07-16.
const WEEK_START = isoWeekStart({ year: 2026, month: 7, day: 13 })
const TODAY_KEY = '2026-07-16'

function day(log_date: string, grams: number): ProteinDay {
  return { log_date, grams }
}

describe('deriveProteinGlance', () => {
  it('reports 0g today and 0 average when nothing is logged', () => {
    const glance = deriveProteinGlance([], WEEK_START, TODAY_KEY)
    expect(glance.todayGrams).toBe(0)
    expect(glance.weekAvg).toBe(0)
  })

  it("picks today's grams out of the week's rows", () => {
    const glance = deriveProteinGlance(
      [day('2026-07-14', 120), day(TODAY_KEY, 95)],
      WEEK_START,
      TODAY_KEY
    )
    expect(glance.todayGrams).toBe(95)
  })

  it('averages the whole 7-day week (unlogged days count as 0)', () => {
    // 140 total over Mon..Sun ÷ 7 = 20.
    const glance = deriveProteinGlance(
      [day('2026-07-13', 70), day('2026-07-15', 70)],
      WEEK_START,
      TODAY_KEY
    )
    expect(glance.weekAvg).toBeCloseTo(20, 5)
    expect(glance.todayGrams).toBe(0) // nothing logged for 07-16 yet
  })
})
