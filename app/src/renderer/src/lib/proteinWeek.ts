// Pure weekly-table math for the manual protein tracker (Gym > Main >
// ProteinCard). Kept separate from the component so it's unit-testable with
// mock ProteinDay[] and no live DB — see lib/__tests__/proteinWeek.test.ts.
import type { ProteinDay } from '@shared/types'
import { addDays, ymdKey, type YMD } from '../hooks/sessionsDate'

export interface ProteinWeekDay {
  dateKey: string
  grams: number
}

export interface ProteinWeekTable {
  days: ProteinWeekDay[]
  /** Total grams for the week ÷ 7 — always over the full week length, not just logged days. */
  avg: number
}

/**
 * Build the Mon–Sun row for the ISO week starting at `weekStartDate` (already
 * the Monday — callers pass `isoWeekStart(todayYMD(timezone))` or similar).
 * Days with no protein_log row default to 0g. `avg` is total ÷ 7 always (a
 * day with nothing logged counts as 0, not "not yet happened") — this keeps
 * the average a stable weekly-adherence number rather than one that jumps
 * around as the week fills in.
 */
export function proteinWeekTable(days: ProteinDay[], weekStartDate: YMD): ProteinWeekTable {
  const gramsByDate = new Map(days.map((d) => [d.log_date, d.grams]))

  const week: ProteinWeekDay[] = []
  let cursor = weekStartDate
  for (let i = 0; i < 7; i++) {
    const dateKey = ymdKey(cursor)
    week.push({ dateKey, grams: gramsByDate.get(dateKey) ?? 0 })
    cursor = addDays(cursor, 1)
  }

  const total = week.reduce((sum, d) => sum + d.grams, 0)
  return { days: week, avg: total / 7 }
}
