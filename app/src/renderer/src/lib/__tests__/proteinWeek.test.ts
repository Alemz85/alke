import { describe, expect, it } from 'vitest'
import { proteinWeekTable } from '../proteinWeek'
import type { ProteinDay } from '@shared/types'

// Monday of a fixed ISO week, matching isoWeekStart's YMD shape.
const MON = { year: 2026, month: 7, day: 6 } // 2026-07-06 .. 2026-07-12 (Mon..Sun)

function day(log_date: string, grams: number): ProteinDay {
  return { log_date, grams }
}

describe('proteinWeekTable', () => {
  it('fills all 7 days Mon..Sun with 0g for a fully empty week', () => {
    const result = proteinWeekTable([], MON)
    expect(result.days).toEqual([
      { dateKey: '2026-07-06', grams: 0 },
      { dateKey: '2026-07-07', grams: 0 },
      { dateKey: '2026-07-08', grams: 0 },
      { dateKey: '2026-07-09', grams: 0 },
      { dateKey: '2026-07-10', grams: 0 },
      { dateKey: '2026-07-11', grams: 0 },
      { dateKey: '2026-07-12', grams: 0 }
    ])
    expect(result.avg).toBe(0)
  })

  it('fills only logged days for a partial week and defaults the rest to 0', () => {
    const days = [day('2026-07-06', 120), day('2026-07-08', 80)]
    const result = proteinWeekTable(days, MON)
    expect(result.days.map((d) => d.grams)).toEqual([120, 0, 80, 0, 0, 0, 0])
    // avg is total / 7, NOT total / logged-days-count (2 days logged, still / 7).
    expect(result.avg).toBeCloseTo(200 / 7)
  })

  it('averages a fully logged week as a simple mean', () => {
    const days = [
      day('2026-07-06', 100),
      day('2026-07-07', 110),
      day('2026-07-08', 90),
      day('2026-07-09', 120),
      day('2026-07-10', 100),
      day('2026-07-11', 130),
      day('2026-07-12', 105)
    ]
    const result = proteinWeekTable(days, MON)
    expect(result.days.map((d) => d.grams)).toEqual([100, 110, 90, 120, 100, 130, 105])
    const total = 100 + 110 + 90 + 120 + 100 + 130 + 105
    expect(result.avg).toBeCloseTo(total / 7)
  })

  it('ignores protein_log rows outside the requested week', () => {
    const days = [day('2026-06-29', 999), day('2026-07-13', 999), day('2026-07-06', 50)]
    const result = proteinWeekTable(days, MON)
    expect(result.days.map((d) => d.grams)).toEqual([50, 0, 0, 0, 0, 0, 0])
    expect(result.avg).toBeCloseTo(50 / 7)
  })

  it('sums additive stacked entries as a single day total (upsert semantics happen in db.ts, not here)', () => {
    // The pure function only ever sees the already-stacked daily total —
    // this test documents that assumption rather than re-testing db.ts.
    const days = [day('2026-07-06', 40 + 40)]
    const result = proteinWeekTable(days, MON)
    expect(result.days[0].grams).toBe(80)
  })
})
