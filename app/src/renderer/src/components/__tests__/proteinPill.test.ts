import { describe, expect, it } from 'vitest'
import type { ProteinDay } from '@shared/types'
import { deriveProteinGlance, deriveProteinTargetFraction, parseGramsInput } from '../ProteinPill'
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

describe('deriveProteinTargetFraction', () => {
  it('returns null when no target is set', () => {
    expect(deriveProteinTargetFraction(84, null)).toBeNull()
  })

  it('returns null for a non-positive target (defensive, should not occur post-validation)', () => {
    expect(deriveProteinTargetFraction(84, 0)).toBeNull()
    expect(deriveProteinTargetFraction(84, -10)).toBeNull()
  })

  it('computes the fraction and remaining grams under target', () => {
    const result = deriveProteinTargetFraction(84, 120)
    expect(result).not.toBeNull()
    expect(result?.fraction).toBeCloseTo(0.7, 5)
    expect(result?.remainingG).toBe(36)
  })

  it('clamps the fraction at 1 and floors remaining at 0 when over target', () => {
    const result = deriveProteinTargetFraction(150, 120)
    expect(result?.fraction).toBe(1)
    expect(result?.remainingG).toBe(0)
  })

  it('reports 0 fraction and full remaining grams when nothing is logged yet', () => {
    const result = deriveProteinTargetFraction(0, 120)
    expect(result?.fraction).toBe(0)
    expect(result?.remainingG).toBe(120)
  })
})

// Dashboard inline add — mirrors ProteinCard's Gym-tab add flow, scoped to
// today. parseGramsInput backs the pill's own guard against empty/invalid input.
describe('parseGramsInput', () => {
  it('parses a valid positive integer string', () => {
    expect(parseGramsInput('35')).toBe(35)
  })

  it('parses a valid positive decimal string', () => {
    expect(parseGramsInput('27.5')).toBeCloseTo(27.5, 5)
  })

  it('rejects empty input', () => {
    expect(parseGramsInput('')).toBeNull()
  })

  it('rejects non-numeric input', () => {
    expect(parseGramsInput('abc')).toBeNull()
  })

  it('rejects zero and negative input', () => {
    expect(parseGramsInput('0')).toBeNull()
    expect(parseGramsInput('-10')).toBeNull()
  })

  it('rejects non-finite input', () => {
    expect(parseGramsInput('Infinity')).toBeNull()
  })
})
