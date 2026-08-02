import { describe, expect, it } from 'vitest'
import {
  addDays,
  isoWeekKey,
  isoWeekStart,
  localDateKey,
  todayYMD,
  toZonedYMD,
  ymdKey,
  ymdToIsoStart,
  ymdToZonedIsoEnd,
  ymdToZonedIsoStart
} from '../sessionsDate'

describe('isoWeekKey', () => {
  it('assigns 2025-12-29 (Monday) to 2026-W01 since its Thursday falls in 2026', () => {
    expect(isoWeekKey({ year: 2025, month: 12, day: 29 })).toBe('2026-W01')
  })

  it('assigns 2025-12-31 (Wednesday) to 2026-W01, same week as the 29th', () => {
    expect(isoWeekKey({ year: 2025, month: 12, day: 31 })).toBe('2026-W01')
  })

  it('assigns 2026-01-01 (Thursday) to 2026-W01', () => {
    expect(isoWeekKey({ year: 2026, month: 1, day: 1 })).toBe('2026-W01')
  })

  it('assigns 2026-01-04 (Sunday) to 2026-W01, the last day of that ISO week', () => {
    expect(isoWeekKey({ year: 2026, month: 1, day: 4 })).toBe('2026-W01')
  })

  it('assigns 2026-01-05 (Monday) to 2026-W02, the next ISO week', () => {
    expect(isoWeekKey({ year: 2026, month: 1, day: 5 })).toBe('2026-W02')
  })

  it('assigns 2024-12-30 (Monday) to 2025-W01 across a year boundary', () => {
    expect(isoWeekKey({ year: 2024, month: 12, day: 30 })).toBe('2025-W01')
  })

  it('assigns 2024-12-31 (Tuesday) to 2025-W01', () => {
    expect(isoWeekKey({ year: 2024, month: 12, day: 31 })).toBe('2025-W01')
  })
})

describe('isoWeekStart', () => {
  it('returns the same Monday for a date already on Monday', () => {
    expect(isoWeekStart({ year: 2026, month: 1, day: 5 })).toEqual({
      year: 2026,
      month: 1,
      day: 5
    })
  })

  it('rolls a Sunday back to the preceding Monday', () => {
    expect(isoWeekStart({ year: 2026, month: 1, day: 4 })).toEqual({
      year: 2025,
      month: 12,
      day: 29
    })
  })

  it('rolls a mid-week date back to Monday across a year boundary', () => {
    expect(isoWeekStart({ year: 2026, month: 1, day: 1 })).toEqual({
      year: 2025,
      month: 12,
      day: 29
    })
  })
})

describe('localDateKey', () => {
  it('keeps a UTC-morning timestamp on the same local date for UTC timezone', () => {
    expect(localDateKey('2026-01-15T09:00:00Z', 'UTC')).toBe('2026-01-15')
  })

  it('rolls a late-evening UTC timestamp to the next local date in Europe/Paris (UTC+1 in January)', () => {
    // 23:30 UTC on Jan 15 is 00:30 local time on Jan 16 in Berlin (winter, UTC+1).
    expect(localDateKey('2026-01-15T23:30:00Z', 'Europe/Paris')).toBe('2026-01-16')
  })

  it('keeps an early-evening UTC timestamp on the same local date in Europe/Paris', () => {
    // 20:00 UTC on Jan 15 is 21:00 local time on Jan 15 in Berlin.
    expect(localDateKey('2026-01-15T20:00:00Z', 'Europe/Paris')).toBe('2026-01-15')
  })

  it('falls back to UTC when timezone is null', () => {
    expect(localDateKey('2026-01-15T23:30:00Z', null)).toBe('2026-01-15')
  })

  it('falls back to UTC when timezone is undefined', () => {
    expect(localDateKey('2026-01-15T23:30:00Z', undefined)).toBe('2026-01-15')
  })
})

describe('toZonedYMD', () => {
  it('extracts year/month/day parts in the given timezone', () => {
    expect(toZonedYMD('2026-06-15T12:00:00Z', 'UTC')).toEqual({ year: 2026, month: 6, day: 15 })
  })

  it('shifts the date backward for a negative-offset timezone near midnight UTC', () => {
    // 02:00 UTC is 21:00 the previous day in America/New_York (UTC-5 in January, standard time).
    expect(toZonedYMD('2026-01-15T02:00:00Z', 'America/New_York')).toEqual({
      year: 2026,
      month: 1,
      day: 14
    })
  })
})

describe('todayYMD', () => {
  it('uses the configured timezone instead of the UTC calendar date near midnight', () => {
    expect(todayYMD('Europe/Berlin', new Date('2026-01-15T23:30:00Z'))).toEqual({
      year: 2026,
      month: 1,
      day: 16
    })
  })
})

describe('ymdKey', () => {
  it('zero-pads month and day', () => {
    expect(ymdKey({ year: 2026, month: 1, day: 5 })).toBe('2026-01-05')
  })
})

describe('addDays', () => {
  it('adds days within a month', () => {
    expect(addDays({ year: 2026, month: 1, day: 5 }, 3)).toEqual({ year: 2026, month: 1, day: 8 })
  })

  it('rolls over a month boundary', () => {
    expect(addDays({ year: 2026, month: 1, day: 30 }, 3)).toEqual({
      year: 2026,
      month: 2,
      day: 2
    })
  })

  it('supports negative offsets', () => {
    expect(addDays({ year: 2026, month: 1, day: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
      day: 31
    })
  })
})

describe('ymdToIsoStart', () => {
  it('produces a UTC midnight ISO instant for the given calendar date', () => {
    expect(ymdToIsoStart({ year: 2026, month: 3, day: 9 })).toBe('2026-03-09T00:00:00.000Z')
  })
})

describe('zoned day bounds', () => {
  it('maps a Berlin calendar day to its exact UTC start and inclusive end across spring DST', () => {
    const day = { year: 2026, month: 3, day: 29 }
    expect(ymdToZonedIsoStart(day, 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z')
    expect(ymdToZonedIsoEnd(day, 'Europe/Berlin')).toBe('2026-03-29T21:59:59.999Z')
  })
})
