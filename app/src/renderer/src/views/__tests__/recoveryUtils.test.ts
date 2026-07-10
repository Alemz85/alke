import { describe, expect, it } from 'vitest'
import type { DailyMetric } from '@shared/types'
import {
  daysAgo,
  EM_DASH,
  fmtDelta,
  fmtHoursAsHm,
  fmtHoursMinutes,
  fmtLocalDate,
  fmtNum,
  mean,
  median,
  readStageHours,
  rollingAverage,
  sliceLastNDays,
  sortByDate,
  weeklyMedianByDate
} from '../recoveryUtils'

function makeMetric(overrides: Partial<DailyMetric> & { date: string }): DailyMetric {
  return {
    date: overrides.date,
    resting_hr: overrides.resting_hr ?? null,
    hrv_sdnn_ms: overrides.hrv_sdnn_ms ?? null,
    respiratory_rate: null,
    sleep_start: null,
    sleep_end: null,
    sleep_duration_min: overrides.sleep_duration_min ?? null,
    sleep_stages: overrides.sleep_stages ?? null,
    vo2max: null,
    steps: null,
    active_energy_kcal: null,
    wrist_temp_deviation_c: null,
    weight_kg: overrides.weight_kg ?? null,
    state_of_mind: null
  }
}

describe('fmtNum / fmtDelta (recoveryUtils copies)', () => {
  it('fmtNum returns the em-dash for null', () => {
    expect(fmtNum(null)).toBe(EM_DASH)
  })

  it('fmtDelta signs a positive value', () => {
    expect(fmtDelta(4.2)).toBe('+4.2')
  })
})

describe('fmtHoursMinutes', () => {
  it('formats minutes over an hour as "Hh Mm"', () => {
    expect(fmtHoursMinutes(451)).toBe('7h 31m')
  })

  it('formats sub-hour minutes as "Mm"', () => {
    expect(fmtHoursMinutes(42)).toBe('42m')
  })

  it('rounds fractional minutes', () => {
    expect(fmtHoursMinutes(59.6)).toBe('1h 0m')
  })

  it('returns the em-dash for null/undefined/NaN', () => {
    expect(fmtHoursMinutes(null)).toBe(EM_DASH)
    expect(fmtHoursMinutes(undefined)).toBe(EM_DASH)
    expect(fmtHoursMinutes(NaN)).toBe(EM_DASH)
  })
})

describe('fmtHoursAsHm', () => {
  it('formats decimal hours as h:mm', () => {
    expect(fmtHoursAsHm(1.4)).toBe('1:24')
  })

  it('pads single-digit minutes', () => {
    expect(fmtHoursAsHm(2.0167)).toBe('2:01')
  })

  it('returns the em-dash for null/undefined/NaN', () => {
    expect(fmtHoursAsHm(null)).toBe(EM_DASH)
    expect(fmtHoursAsHm(undefined)).toBe(EM_DASH)
    expect(fmtHoursAsHm(NaN)).toBe(EM_DASH)
  })
})

describe('fmtLocalDate', () => {
  it('formats a YYYY-MM-DD string as "Ddd, Mon D", UTC-anchored', () => {
    expect(fmtLocalDate('2026-07-08', 'Europe/Berlin')).toBe('Wed, Jul 8')
  })

  it('ignores the timezone argument (UTC-anchored by design)', () => {
    expect(fmtLocalDate('2026-07-08', 'America/Los_Angeles')).toBe('Wed, Jul 8')
  })
})

describe('daysAgo', () => {
  it('returns 0 for today', () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(daysAgo(today)).toBe(0)
  })

  it('returns a positive count for a past date', () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
    expect(daysAgo(past)).toBe(5)
  })
})

describe('sortByDate', () => {
  it('sorts ascending by date without mutating the input', () => {
    const rows = [makeMetric({ date: '2026-01-03' }), makeMetric({ date: '2026-01-01' })]
    const sorted = sortByDate(rows)
    expect(sorted.map((r) => r.date)).toEqual(['2026-01-01', '2026-01-03'])
    expect(rows.map((r) => r.date)).toEqual(['2026-01-03', '2026-01-01'])
  })
})

describe('sliceLastNDays', () => {
  it('keeps only rows within the last N days up to today', () => {
    const today = new Date()
    const iso = (daysBack: number): string =>
      new Date(today.getTime() - daysBack * 86_400_000).toISOString().slice(0, 10)
    const rows = [makeMetric({ date: iso(10) }), makeMetric({ date: iso(2) }), makeMetric({ date: iso(0) })]
    const sliced = sliceLastNDays(rows, 5)
    expect(sliced.map((r) => r.date)).toEqual([iso(2), iso(0)])
  })
})

describe('readStageHours', () => {
  it('reads a numeric field from the stages blob', () => {
    expect(readStageHours({ deep: 1.5 }, 'deep')) .toBe(1.5)
  })

  it('coerces a numeric string', () => {
    expect(readStageHours({ deep: '1.5' }, 'deep')).toBe(1.5)
  })

  it('returns null when the key is absent', () => {
    expect(readStageHours({ deep: 1.5 }, 'rem')).toBeNull()
  })

  it('returns null when stages is null', () => {
    expect(readStageHours(null, 'deep')).toBeNull()
  })

  it('returns null for a non-numeric value', () => {
    expect(readStageHours({ deep: 'garbage' }, 'deep')).toBeNull()
  })
})

describe('mean', () => {
  it('averages non-null numbers', () => {
    expect(mean([1, 2, 3])).toBe(2)
  })

  it('ignores null and undefined entries', () => {
    expect(mean([1, null, 3, undefined])).toBe(2)
  })

  it('returns null when all values are null', () => {
    expect(mean([null, null])).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(mean([])).toBeNull()
  })
})

describe('median', () => {
  it('returns the middle value for an odd-length list', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values for an even-length list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('ignores null/undefined entries', () => {
    expect(median([null, 1, 2, 3, undefined])).toBe(2)
  })

  it('returns null for an empty list', () => {
    expect(median([])).toBeNull()
  })
})

describe('rollingAverage', () => {
  it('computes a trailing window average that grows until the window is full', () => {
    const rows = [
      makeMetric({ date: '2026-01-01', resting_hr: 60 }),
      makeMetric({ date: '2026-01-02', resting_hr: 62 }),
      makeMetric({ date: '2026-01-03', resting_hr: 64 })
    ]
    const result = rollingAverage(rows, 'resting_hr', 2)
    expect(result.get('2026-01-01')).toBe(60) // window of 1 (no prior day)
    expect(result.get('2026-01-02')).toBe(61) // avg(60,62)
    expect(result.get('2026-01-03')).toBe(63) // avg(62,64)
  })

  it('skips dates where the trailing window has no non-null values', () => {
    const rows = [
      makeMetric({ date: '2026-01-01', resting_hr: null }),
      makeMetric({ date: '2026-01-02', resting_hr: 60 })
    ]
    const result = rollingAverage(rows, 'resting_hr', 7)
    expect(result.has('2026-01-01')).toBe(false)
    expect(result.get('2026-01-02')).toBe(60)
  })

  it('returns an empty map for an empty input', () => {
    expect(rollingAverage([], 'resting_hr').size).toBe(0)
  })
})

describe('weeklyMedianByDate', () => {
  it('stamps the same weekly median across every date in that ISO week', () => {
    const rows = [
      makeMetric({ date: '2026-01-05', hrv_sdnn_ms: 40 }), // Mon
      makeMetric({ date: '2026-01-06', hrv_sdnn_ms: 50 }), // Tue
      makeMetric({ date: '2026-01-07', hrv_sdnn_ms: 60 }) // Wed
    ]
    const result = weeklyMedianByDate(rows, 'hrv_sdnn_ms')
    expect(result.get('2026-01-05')).toBe(50)
    expect(result.get('2026-01-06')).toBe(50)
    expect(result.get('2026-01-07')).toBe(50)
  })

  it('computes separate medians for separate ISO weeks', () => {
    const rows = [
      makeMetric({ date: '2026-01-05', hrv_sdnn_ms: 40 }), // week 2026-W02
      makeMetric({ date: '2026-01-12', hrv_sdnn_ms: 80 }) // week 2026-W03
    ]
    const result = weeklyMedianByDate(rows, 'hrv_sdnn_ms')
    expect(result.get('2026-01-05')).toBe(40)
    expect(result.get('2026-01-12')).toBe(80)
  })

  it('omits dates from weeks where every value is null', () => {
    const rows = [makeMetric({ date: '2026-01-05', hrv_sdnn_ms: null })]
    const result = weeklyMedianByDate(rows, 'hrv_sdnn_ms')
    expect(result.has('2026-01-05')).toBe(false)
  })
})
