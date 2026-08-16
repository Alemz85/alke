import { describe, expect, it, vi } from 'vitest'
import type { ComputedDaily, DailyMetric } from '@shared/types'
import {
  buildLoadChartData,
  bucketAggregate,
  buildWeightSeries,
  chartAxis,
  clockGoalMinutesOnSleepAxis,
  clockMinutesOnSleepAxis,
  computeTrainingLoadSummary,
  daysAgo,
  EM_DASH,
  fmtBucketLabel,
  fmtClockTime,
  fmtSleepAxisTime,
  fmtDelta,
  fmtHoursAsHm,
  fmtHoursMinutes,
  fmtLocalDate,
  fmtNum,
  granularityForDays,
  mean,
  median,
  readStageHours,
  rollingAverage,
  sliceLastNDays,
  sortByDate,
  weeklyMedianByDate
} from '../recoveryUtils'

describe('sleep chart helpers', () => {
  it('keeps bedtime values continuous across midnight', () => {
    expect(clockMinutesOnSleepAxis('2026-01-05T22:30:00Z', 'UTC')).toBe(1350)
    expect(clockMinutesOnSleepAxis('2026-01-06T00:30:00Z', 'UTC')).toBe(1470)
    expect(fmtSleepAxisTime(1470)).toBe('00:30')
  })

  it('places a midnight bedtime goal at 24:00 on the overnight axis', () => {
    expect(clockGoalMinutesOnSleepAxis(0)).toBe(1440)
    expect(clockGoalMinutesOnSleepAxis(23 * 60 + 45)).toBe(1425)
    expect(clockGoalMinutesOnSleepAxis(30)).toBe(1470)
  })

  it('uses D3 nice domains and restrained tick counts', () => {
    const axis = chartAxis([6.4, 7.1, 8.2], { padding: 0.35, tickCount: 4 })
    expect(axis.domain[0]).toBeLessThanOrEqual(6.05)
    expect(axis.domain[1]).toBeGreaterThanOrEqual(8.55)
    expect(axis.ticks.length).toBeGreaterThanOrEqual(3)
    expect(axis.ticks.length).toBeLessThanOrEqual(6)
  })
})

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
    body_fat_pct: overrides.body_fat_pct ?? null,
    vo2max: null,
    steps: null,
    active_energy_kcal: null,
    wrist_temp_deviation_c: null,
    weight_kg: overrides.weight_kg ?? null,
    walking_running_distance_m: null,
    flights_climbed: null,
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
    expect(fmtLocalDate('2026-07-08', 'Europe/Paris')).toBe('Wed, Jul 8')
  })

  it('ignores the timezone argument (UTC-anchored by design)', () => {
    expect(fmtLocalDate('2026-07-08', 'America/Los_Angeles')).toBe('Wed, Jul 8')
  })
})

describe('daysAgo', () => {
  it('returns 0 for today (UTC-anchored when no timezone is given)', () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(daysAgo(today)).toBe(0)
  })

  it('returns a positive count for a past date', () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
    expect(daysAgo(past)).toBe(5)
  })

  it('anchors "today" to the given timezone, not UTC', () => {
    // Fix a moment where UTC and America/Los_Angeles (UTC-8 in January)
    // disagree on the calendar day: 2026-01-06T04:00:00Z is still
    // 2026-01-05 20:00 in LA — "today" is the 6th in UTC but the 5th in LA.
    vi.setSystemTime(new Date('2026-01-06T04:00:00Z'))
    expect(daysAgo('2026-01-06')).toBe(0) // UTC: today IS the 6th
    expect(daysAgo('2026-01-06', 'America/Los_Angeles')).toBe(-1) // LA: the 6th is "tomorrow"
    expect(daysAgo('2026-01-05', 'America/Los_Angeles')).toBe(0) // LA: today IS the 5th
    expect(daysAgo('2026-01-01', 'America/Los_Angeles')).toBe(4) // LA: 4 days before the 5th
    vi.useRealTimers()
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
  it('keeps only rows within the last N days up to today (UTC-anchored when no timezone is given)', () => {
    const today = new Date()
    const iso = (daysBack: number): string =>
      new Date(today.getTime() - daysBack * 86_400_000).toISOString().slice(0, 10)
    const rows = [makeMetric({ date: iso(10) }), makeMetric({ date: iso(2) }), makeMetric({ date: iso(0) })]
    const sliced = sliceLastNDays(rows, 5)
    expect(sliced.map((r) => r.date)).toEqual([iso(2), iso(0)])
  })

  it('anchors the window to the given timezone, not UTC', () => {
    // Same instant/day-boundary case as the daysAgo timezone test above:
    // 2026-01-06T04:00:00Z is still 2026-01-05 in America/Los_Angeles.
    vi.setSystemTime(new Date('2026-01-06T04:00:00Z'))
    const rows = [
      makeMetric({ date: '2026-01-04' }),
      makeMetric({ date: '2026-01-05' }),
      makeMetric({ date: '2026-01-06' })
    ]
    // UTC: "today" is the 6th, so a 2-day window is [5th, 6th].
    expect(sliceLastNDays(rows, 2).map((r) => r.date)).toEqual(['2026-01-05', '2026-01-06'])
    // LA: "today" is the 5th, so a 2-day window is [4th, 5th] — the 6th (not
    // yet "today" in LA) must NOT appear.
    expect(sliceLastNDays(rows, 2, 'America/Los_Angeles').map((r) => r.date)).toEqual([
      '2026-01-04',
      '2026-01-05'
    ])
    vi.useRealTimers()
  })

  it('a N-day window spans exactly N calendar dates ending today (no off-by-one)', () => {
    vi.setSystemTime(new Date('2026-01-06T12:00:00Z'))
    const rows = [
      makeMetric({ date: '2026-01-05' }),
      makeMetric({ date: '2026-01-06' })
    ]
    expect(sliceLastNDays(rows, 1).map((r) => r.date)).toEqual(['2026-01-06'])
    vi.useRealTimers()
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

  it('windows by calendar distance, not row count, when the data has gaps', () => {
    // Old rows-based slicing would average 60 and 80 here even though they
    // are 9 calendar days apart — far outside a 7-day window.
    const rows = [
      makeMetric({ date: '2026-01-01', resting_hr: 60 }),
      makeMetric({ date: '2026-01-10', resting_hr: 80 })
    ]
    const result = rollingAverage(rows, 'resting_hr', 7)
    expect(result.get('2026-01-01')).toBe(60)
    expect(result.get('2026-01-10')).toBe(80)
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

describe('fmtClockTime', () => {
  it('formats an ISO instant as 24h clock time in the given timezone', () => {
    // 22:42 UTC on the given day → 23:42 in Berlin (UTC+1 in January).
    expect(fmtClockTime('2026-01-05T22:42:00Z', 'Europe/Paris')).toBe('23:42')
  })

  it('returns the em-dash for null / undefined / unparseable input', () => {
    expect(fmtClockTime(null, 'Europe/Paris')).toBe(EM_DASH)
    expect(fmtClockTime(undefined, 'Europe/Paris')).toBe(EM_DASH)
    expect(fmtClockTime('not-a-date', 'Europe/Paris')).toBe(EM_DASH)
  })

  it('falls back to UTC when no timezone is supplied', () => {
    expect(fmtClockTime('2026-01-05T07:05:00Z', null)).toBe('07:05')
  })
})

describe('granularityForDays', () => {
  it('picks daily for short windows, weekly at 90d, monthly beyond', () => {
    expect(granularityForDays(7)).toBe('daily')
    expect(granularityForDays(30)).toBe('daily')
    expect(granularityForDays(90)).toBe('weekly')
    expect(granularityForDays(365)).toBe('monthly')
  })
})

describe('bucketAggregate', () => {
  it('passes daily rows through unchanged, nulling absent readings', () => {
    const rows = [
      makeMetric({ date: '2026-01-05', resting_hr: 50 }),
      makeMetric({ date: '2026-01-06', resting_hr: null })
    ]
    const out = bucketAggregate(rows, 'resting_hr', 'daily')
    expect(out).toEqual([
      { date: '2026-01-05', value: 50, n: 1 },
      { date: '2026-01-06', value: null, n: 0 }
    ])
  })

  it('collapses a week into its mean (ISO-Monday anchor)', () => {
    // 2026-01-05 is a Monday; the whole week anchors to it.
    const rows = [
      makeMetric({ date: '2026-01-05', resting_hr: 50 }),
      makeMetric({ date: '2026-01-07', resting_hr: 52 }),
      makeMetric({ date: '2026-01-11', resting_hr: 54 })
    ]
    const out = bucketAggregate(rows, 'resting_hr', 'weekly', 'mean')
    expect(out).toEqual([{ date: '2026-01-05', value: 52, n: 3 }])
  })

  it('collapses months to the 1st-of-month anchor and supports median', () => {
    const rows = [
      makeMetric({ date: '2026-01-03', hrv_sdnn_ms: 40 }),
      makeMetric({ date: '2026-01-20', hrv_sdnn_ms: 60 }),
      makeMetric({ date: '2026-02-14', hrv_sdnn_ms: 80 })
    ]
    const out = bucketAggregate(rows, 'hrv_sdnn_ms', 'monthly', 'median')
    expect(out).toEqual([
      { date: '2026-01-01', value: 50, n: 2 },
      { date: '2026-02-01', value: 80, n: 1 }
    ])
  })

  it('drops empty buckets rather than plotting phantom zeros', () => {
    const rows = [
      makeMetric({ date: '2026-01-05', resting_hr: null }),
      makeMetric({ date: '2026-01-06', resting_hr: null })
    ]
    expect(bucketAggregate(rows, 'resting_hr', 'weekly')).toEqual([])
  })
})

describe('fmtBucketLabel', () => {
  it('labels days, weeks, and months distinctly', () => {
    expect(fmtBucketLabel('2026-01-05', 'daily', 'Europe/Paris')).toBe(
      fmtLocalDate('2026-01-05', 'Europe/Paris')
    )
    expect(fmtBucketLabel('2026-01-05', 'weekly', 'Europe/Paris')).toBe(
      `wk ${fmtLocalDate('2026-01-05', 'Europe/Paris')}`
    )
    expect(fmtBucketLabel('2026-01-01', 'monthly', 'Europe/Paris')).toBe('Jan 2026')
  })
})

function makeComputed(overrides: Partial<ComputedDaily> & { date: string }): ComputedDaily {
  return {
    date: overrides.date,
    trimp_total: overrides.trimp_total ?? null,
    ctl: overrides.ctl ?? null,
    atl: overrides.atl ?? null,
    tsb: overrides.tsb ?? null,
    acwr: null,
    rhr_baseline_60d: null,
    rhr_dev: null,
    hrv_baseline_60d: null,
    hrv_dev: null,
    flags: null,
    computed_at: null
  }
}

describe('computeTrainingLoadSummary', () => {
  // All assertions pass an explicit user-tz "today" key so the ISO-week window
  // is deterministic regardless of the machine's timezone. Mon 2026-07-13 is the
  // start of the ISO week containing Thu 2026-07-16.
  const TODAY = '2026-07-16'

  it('is all-null on empty input', () => {
    const s = computeTrainingLoadSummary([], TODAY)
    expect(s.latestCtl).toBeNull()
    expect(s.latestAtl).toBeNull()
    expect(s.latestTsb).toBeNull()
    expect(s.ctlDelta7d).toBeNull()
    expect(s.trimpThisWeek).toBeNull()
    expect(s.trimp4wAvg).toBeNull()
  })

  it('takes CTL/ATL/TSB from the last (newest) row', () => {
    const rows = [
      makeComputed({ date: '2026-07-14', ctl: 40, atl: 45, tsb: -5 }),
      makeComputed({ date: '2026-07-16', ctl: 42, atl: 50, tsb: -8 })
    ]
    const s = computeTrainingLoadSummary(rows, TODAY)
    expect(s.latestCtl).toBe(42)
    expect(s.latestAtl).toBe(50)
    expect(s.latestTsb).toBe(-8)
  })

  it('computes the 7-day CTL delta against the exact prior date', () => {
    const rows = [
      makeComputed({ date: '2026-07-09', ctl: 38 }),
      makeComputed({ date: '2026-07-16', ctl: 42 })
    ]
    expect(computeTrainingLoadSummary(rows, TODAY).ctlDelta7d).toBe(4)
  })

  it('sums TRIMP only over the current ISO week (Mon 07-13 .. Sun 07-19)', () => {
    const rows = [
      makeComputed({ date: '2026-07-12', trimp_total: 100 }), // prior week — excluded
      makeComputed({ date: '2026-07-13', trimp_total: 30 }),
      makeComputed({ date: '2026-07-15', trimp_total: 40 }),
      makeComputed({ date: '2026-07-20', trimp_total: 999 }) // next week — excluded
    ]
    expect(computeTrainingLoadSummary(rows, TODAY).trimpThisWeek).toBe(70)
  })

  it('returns a null weekly TRIMP when no in-week row has a TRIMP value', () => {
    const rows = [makeComputed({ date: '2026-07-14', ctl: 40 })]
    expect(computeTrainingLoadSummary(rows, TODAY).trimpThisWeek).toBeNull()
  })

  it('averages the trailing 4 weeks of TRIMP by dividing the total by 4', () => {
    // Four weeks back from Mon 07-13 is Mon 06-15; window is [06-15, 07-20).
    const rows = [
      makeComputed({ date: '2026-06-15', trimp_total: 200 }),
      makeComputed({ date: '2026-07-13', trimp_total: 200 })
    ]
    expect(computeTrainingLoadSummary(rows, TODAY).trimp4wAvg).toBe(100) // 400 / 4
  })
})

describe('buildLoadChartData', () => {
  const TODAY = '2026-07-16'

  it('keeps only rows inside the trailing window, ascending, with ctl/atl', () => {
    const rows = [
      makeComputed({ date: '2026-01-01', ctl: 10, atl: 12 }), // >90d before — dropped
      makeComputed({ date: '2026-07-01', ctl: 40, atl: 44 }),
      makeComputed({ date: '2026-07-16', ctl: 42, atl: 50 })
    ]
    const data = buildLoadChartData(rows, TODAY, 90)
    expect(data.map((d) => d.date)).toEqual(['2026-07-01', '2026-07-16'])
    expect(data[1]).toEqual({ date: '2026-07-16', ctl: 42, atl: 50 })
  })

  it('excludes rows dated after today', () => {
    const rows = [
      makeComputed({ date: '2026-07-16', ctl: 42, atl: 50 }),
      makeComputed({ date: '2026-07-20', ctl: 99, atl: 99 }) // future — dropped
    ]
    const data = buildLoadChartData(rows, TODAY, 90)
    expect(data.map((d) => d.date)).toEqual(['2026-07-16'])
  })
})

describe('buildWeightSeries (body composition)', () => {
  it('emits one point per weigh-in with a bridged trend, unchanged by body fat', () => {
    const rows = [
      makeMetric({ date: '2026-08-10', weight_kg: 70.0 }),
      makeMetric({ date: '2026-08-11', weight_kg: 70.4 })
    ]
    const series = buildWeightSeries(rows)
    expect(series.map((p) => p.date)).toEqual(['2026-08-10', '2026-08-11'])
    expect(series[0].weight).toBe(70.0)
    expect(series[1].trend).toBeCloseTo(70.2, 5) // mean of the 2 in-window readings
    expect(series[0].bodyFat).toBeNull()
    expect(series[0].bodyFatTrend).toBeNull()
  })

  it('breaks the trend across a gap longer than maxGapDays', () => {
    const rows = [
      makeMetric({ date: '2026-06-01', weight_kg: 70.0 }),
      makeMetric({ date: '2026-08-10', weight_kg: 71.0 }) // ~70d later
    ]
    const series = buildWeightSeries(rows)
    expect(series[0].trend).toBe(70.0)
    expect(series[1].trend).toBeNull() // line must not bridge the void
  })

  it('carries body fat on the same date axis so the two panels align', () => {
    const rows = [
      makeMetric({ date: '2026-08-14', weight_kg: 70.8, body_fat_pct: 22.1 }),
      makeMetric({ date: '2026-08-15', weight_kg: 70.4, body_fat_pct: 21.8 })
    ]
    const series = buildWeightSeries(rows)
    expect(series.map((p) => p.date)).toEqual(['2026-08-14', '2026-08-15'])
    expect(series[1].bodyFat).toBe(21.8)
    expect(series[1].bodyFatTrend).toBeCloseTo(21.95, 5)
    // Body fat is NOT rescaled into the weight's units -- separate panels.
    expect(series[1].weight).toBe(70.4)
  })

  it('includes a date that has body fat but no weigh-in', () => {
    const rows = [
      makeMetric({ date: '2026-08-14', weight_kg: 70.8 }),
      makeMetric({ date: '2026-08-15', body_fat_pct: 21.8 })
    ]
    const series = buildWeightSeries(rows)
    expect(series.map((p) => p.date)).toEqual(['2026-08-14', '2026-08-15'])
    expect(series[1].weight).toBeNull()
    expect(series[1].bodyFat).toBe(21.8)
  })

  it('computes each measure trend over its own readings, not the shared dates', () => {
    // Weight on both days, body fat only on the second: the body-fat trend must
    // average one reading, not treat the missing day as a gap or a zero.
    const rows = [
      makeMetric({ date: '2026-08-14', weight_kg: 71.0 }),
      makeMetric({ date: '2026-08-15', weight_kg: 70.0, body_fat_pct: 21.8 })
    ]
    const series = buildWeightSeries(rows)
    expect(series[1].trend).toBeCloseTo(70.5, 5) // both weigh-ins
    expect(series[1].bodyFatTrend).toBeCloseTo(21.8, 5) // the single reading
  })

  it('returns an empty series when nothing has been weighed', () => {
    expect(buildWeightSeries([makeMetric({ date: '2026-08-15' })])).toEqual([])
  })
})
