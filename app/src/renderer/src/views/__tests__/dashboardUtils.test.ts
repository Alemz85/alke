import { describe, expect, it } from 'vitest'
import type { DailyMetric, UserConfig, Workout } from '@shared/types'
import {
  computeActiveEnergySummary,
  computeBodyWeightSummary,
  countSessionsForGoal,
  EM_DASH,
  fmtDelta,
  fmtDistance,
  fmtDuration,
  fmtNum,
  humanizeDaysSince,
  humanizeWorkoutType,
  isoWeekWindowFor,
  parseWeeklyMinSessions
} from '../dashboardUtils'

function makeWorkout(overrides: Partial<Workout> & { type: string }): Workout {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    external_id: null,
    type: overrides.type,
    start_at: overrides.start_at ?? '2026-01-15T09:00:00Z',
    end_at: null,
    duration_s: null,
    distance_m: null,
    energy_kcal: null,
    avg_hr: null,
    max_hr: null,
    source: null,
    computed: null
  }
}

/** A daily_metrics row with only the fields these tests read; rest defaulted null. */
function makeMetric(date: string, weight_kg: number | null): DailyMetric {
  return {
    date,
    resting_hr: null,
    hrv_sdnn_ms: null,
    respiratory_rate: null,
    sleep_duration_min: null,
    sleep_start: null,
    sleep_end: null,
    sleep_stages: null,
    steps: null,
    vo2max: null,
    wrist_temp_deviation_c: null,
    weight_kg
  } as unknown as DailyMetric
}

describe('countSessionsForGoal', () => {
  it('counts workouts matching the goal key via workoutMatchesGoal', () => {
    const workouts = [
      makeWorkout({ type: 'pool_swim' }),
      makeWorkout({ type: 'open_water_swim' }),
      makeWorkout({ type: 'outdoor_run' })
    ]
    expect(countSessionsForGoal(workouts, 'swim')).toBe(2)
  })

  it('returns 0 when nothing matches', () => {
    const workouts = [makeWorkout({ type: 'outdoor_run' })]
    expect(countSessionsForGoal(workouts, 'swim')).toBe(0)
  })

  it('returns 0 for an empty workout list', () => {
    expect(countSessionsForGoal([], 'swim')).toBe(0)
  })
})

describe('parseWeeklyMinSessions', () => {
  it('parses a well-formed numeric record', () => {
    const config = { weekly_min_sessions: { swim: 1, lift: 4 } } as unknown as UserConfig
    expect(parseWeeklyMinSessions(config)).toEqual({ swim: 1, lift: 4 })
  })

  it('coerces numeric strings to numbers', () => {
    const config = { weekly_min_sessions: { swim: '2' } } as unknown as UserConfig
    expect(parseWeeklyMinSessions(config)).toEqual({ swim: 2 })
  })

  it('drops keys whose value cannot be coerced to a number', () => {
    const config = { weekly_min_sessions: { swim: 'garbage', lift: 3 } } as unknown as UserConfig
    expect(parseWeeklyMinSessions(config)).toEqual({ lift: 3 })
  })

  it('returns an empty object when weekly_min_sessions is null', () => {
    const config = { weekly_min_sessions: null } as unknown as UserConfig
    expect(parseWeeklyMinSessions(config)).toEqual({})
  })

  it('returns an empty object when weekly_min_sessions is not an object', () => {
    const config = { weekly_min_sessions: 'not-an-object' } as unknown as UserConfig
    expect(parseWeeklyMinSessions(config)).toEqual({})
  })

  it('returns an empty object when config itself is undefined', () => {
    expect(parseWeeklyMinSessions(undefined)).toEqual({})
  })
})

describe('isoWeekWindowFor', () => {
  // Explicit YMD inputs throughout — no `new Date()`/machine-local getters,
  // so these assert the same thing regardless of the machine's timezone.
  it('rolls a Wednesday back to the preceding Monday', () => {
    const wed = { year: 2026, month: 1, day: 14 } // Wed 14 Jan 2026
    const window = isoWeekWindowFor(wed)
    expect(window.startKey).toBe('2026-01-12') // Monday
    expect(window.startIso).toBe('2026-01-12T00:00:00.000Z')
  })

  it('treats Sunday as the end of the ISO week, rolling back 6 days to Monday', () => {
    const sun = { year: 2026, month: 1, day: 18 } // Sun 18 Jan 2026
    const window = isoWeekWindowFor(sun)
    expect(window.startKey).toBe('2026-01-12') // Monday of the same week
  })

  it('endKey is exactly 7 days after startKey', () => {
    const anyDay = { year: 2026, month: 1, day: 14 }
    const window = isoWeekWindowFor(anyDay)
    expect(window.startKey).toBe('2026-01-12')
    expect(window.endKey).toBe('2026-01-19')
    expect(Date.parse(window.endIso) - Date.parse(window.startIso)).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('handles a month/year boundary (window spans Dec into Jan)', () => {
    const thu = { year: 2026, month: 1, day: 1 } // Thu 1 Jan 2026 — week starts Mon 29 Dec 2025
    const window = isoWeekWindowFor(thu)
    expect(window.startKey).toBe('2025-12-29')
    expect(window.endKey).toBe('2026-01-05')
  })

  it('converts Berlin week boundaries from local midnight to the correct UTC instant', () => {
    const winter = isoWeekWindowFor({ year: 2026, month: 1, day: 14 }, 'Europe/Berlin')
    expect(winter.startIso).toBe('2026-01-11T23:00:00.000Z')
    expect(winter.endIso).toBe('2026-01-18T23:00:00.000Z')

    const summer = isoWeekWindowFor({ year: 2026, month: 7, day: 15 }, 'Europe/Berlin')
    expect(summer.startIso).toBe('2026-07-12T22:00:00.000Z')
    expect(summer.endIso).toBe('2026-07-19T22:00:00.000Z')
  })

  it('lets the UTC span change across daylight-saving transitions', () => {
    const springForward = isoWeekWindowFor(
      { year: 2026, month: 3, day: 25 },
      'Europe/Berlin'
    )
    expect(springForward.startIso).toBe('2026-03-22T23:00:00.000Z')
    expect(springForward.endIso).toBe('2026-03-29T22:00:00.000Z')
    expect(Date.parse(springForward.endIso) - Date.parse(springForward.startIso)).toBe(
      167 * 60 * 60 * 1000
    )
  })
})

describe('fmtNum', () => {
  it('formats a number with the default 1 decimal place', () => {
    expect(fmtNum(3.14159)).toBe('3.1')
  })

  it('respects a custom decimals argument', () => {
    expect(fmtNum(3.14159, 3)).toBe('3.142')
  })

  it('returns the em-dash for null', () => {
    expect(fmtNum(null)).toBe(EM_DASH)
  })

  it('returns the em-dash for undefined', () => {
    expect(fmtNum(undefined)).toBe(EM_DASH)
  })

  it('returns the em-dash for NaN', () => {
    expect(fmtNum(NaN)).toBe(EM_DASH)
  })
})

describe('fmtDelta', () => {
  it('prefixes a positive value with +', () => {
    expect(fmtDelta(2.3)).toBe('+2.3')
  })

  it('does not prefix a negative value (toFixed already carries the minus sign)', () => {
    expect(fmtDelta(-1.1)).toBe('-1.1')
  })

  it('prefixes an exact zero with ±', () => {
    expect(fmtDelta(0)).toBe('±0.0')
  })

  it('returns the em-dash for null/undefined/NaN', () => {
    expect(fmtDelta(null)).toBe(EM_DASH)
    expect(fmtDelta(undefined)).toBe(EM_DASH)
    expect(fmtDelta(NaN)).toBe(EM_DASH)
  })
})

describe('humanizeWorkoutType', () => {
  it('title-cases and spaces an underscore-delimited type', () => {
    expect(humanizeWorkoutType('open_water_swim')).toBe('Open Water Swim')
  })

  it('handles hyphen delimiters too', () => {
    expect(humanizeWorkoutType('indoor-cycling')).toBe('Indoor Cycling')
  })

  it('handles a single-word type', () => {
    expect(humanizeWorkoutType('run')).toBe('Run')
  })
})

describe('fmtDuration', () => {
  it('formats hours and minutes', () => {
    expect(fmtDuration(3600 + 12 * 60)).toBe('1h 12m')
  })

  it('formats minutes only when under an hour', () => {
    expect(fmtDuration(42 * 60)).toBe('42m')
  })

  it('formats seconds only when under a minute', () => {
    expect(fmtDuration(38)).toBe('38s')
  })

  it('returns the em-dash for null/undefined/NaN', () => {
    expect(fmtDuration(null)).toBe(EM_DASH)
    expect(fmtDuration(undefined)).toBe(EM_DASH)
    expect(fmtDuration(NaN)).toBe(EM_DASH)
  })
})

describe('fmtDistance', () => {
  it('formats sub-kilometer distances in meters, rounded', () => {
    expect(fmtDistance(420.4)).toBe('420 m')
  })

  it('formats kilometer-plus distances in km with 2 decimals', () => {
    expect(fmtDistance(1850)).toBe('1.85 km')
  })

  it('treats exactly 1000m as kilometers', () => {
    expect(fmtDistance(1000)).toBe('1.00 km')
  })

  it('returns null (not the em-dash) for null/undefined/NaN', () => {
    expect(fmtDistance(null)).toBeNull()
    expect(fmtDistance(undefined)).toBeNull()
    expect(fmtDistance(NaN)).toBeNull()
  })
})

describe('humanizeDaysSince', () => {
  it('reads 0 as Today and 1 as Yesterday', () => {
    expect(humanizeDaysSince(0)).toBe('Today')
    expect(humanizeDaysSince(1)).toBe('Yesterday')
  })

  it('reads single-digit / <14 as "N days ago"', () => {
    expect(humanizeDaysSince(3)).toBe('3 days ago')
    expect(humanizeDaysSince(13)).toBe('13 days ago')
  })

  it('collapses two weeks or more into "N weeks ago"', () => {
    expect(humanizeDaysSince(14)).toBe('2 weeks ago')
    expect(humanizeDaysSince(30)).toBe('4 weeks ago')
  })
})

describe('computeBodyWeightSummary', () => {
  // All assertions pass an explicit user-tz "today" key — no machine-local
  // Date math — so they hold regardless of the runner's timezone.
  it('renders a quiet empty shape when there are no weigh-ins', () => {
    const summary = computeBodyWeightSummary([makeMetric('2026-06-01', null)], '2026-07-16')
    expect(summary.latestKg).toBeNull()
    expect(summary.latestDate).toBeNull()
    expect(summary.latestDateLabel).toBe(EM_DASH)
    expect(summary.daysSince).toBeNull()
    expect(summary.stalenessLabel).toBeNull()
    expect(summary.deltaLabel).toBeNull()
    expect(summary.isStale).toBe(false)
  })

  it('reports the latest reading with no delta when only one weigh-in exists', () => {
    const summary = computeBodyWeightSummary([makeMetric('2026-07-10', 74.2)], '2026-07-16')
    expect(summary.latestKg).toBe(74.2)
    expect(summary.latestDate).toBe('2026-07-10')
    expect(summary.daysSince).toBe(6)
    expect(summary.stalenessLabel).toBe('6 days ago')
    expect(summary.isStale).toBe(false) // exactly a week is not yet stale
    expect(summary.deltaKg).toBeNull()
    expect(summary.deltaLabel).toBeNull()
  })

  it('computes a signed delta vs a reading at least ~30 days older', () => {
    const summary = computeBodyWeightSummary(
      [makeMetric('2026-06-01', 75.0), makeMetric('2026-07-10', 74.2)],
      '2026-07-16'
    )
    // 74.2 - 75.0 = -0.8 kg, gap ~39d → "1 mo"
    expect(summary.deltaKg).toBeCloseTo(-0.8, 5)
    expect(summary.deltaLabel).toBe('−0.8 kg vs 1 mo ago')
  })

  it('falls back to the oldest reading when nothing is ~1 month old', () => {
    const summary = computeBodyWeightSummary(
      [makeMetric('2026-07-01', 73.0), makeMetric('2026-07-10', 74.0)],
      '2026-07-16'
    )
    // Oldest reading 9 days older → gap shows in days, gain is a "+".
    expect(summary.deltaKg).toBeCloseTo(1.0, 5)
    expect(summary.deltaLabel).toBe('+1.0 kg vs 9d ago')
  })

  it('marks a weigh-in older than a week as stale', () => {
    const summary = computeBodyWeightSummary([makeMetric('2026-06-20', 74.0)], '2026-07-16')
    expect(summary.daysSince).toBe(26)
    expect(summary.stalenessLabel).toBe('4 weeks ago')
    expect(summary.isStale).toBe(true)
  })

  it('skips null-weight rows interleaved among real weigh-ins', () => {
    const summary = computeBodyWeightSummary(
      [
        makeMetric('2026-06-01', 75.0),
        makeMetric('2026-06-15', null), // e.g. a day with RHR but no weigh-in
        makeMetric('2026-07-10', 74.2)
      ],
      '2026-07-16'
    )
    expect(summary.latestKg).toBe(74.2)
    expect(summary.deltaLabel).toBe('−0.8 kg vs 1 mo ago')
  })
})

describe('computeActiveEnergySummary', () => {
  /** A daily_metrics row carrying only active_energy_kcal. */
  function makeEnergyMetric(date: string, active_energy_kcal: number | null): DailyMetric {
    return { ...makeMetric(date, null), active_energy_kcal } as DailyMetric
  }

  it('returns the no-data shape when active energy has never synced', () => {
    const summary = computeActiveEnergySummary(
      [makeEnergyMetric('2026-07-15', null)],
      '2026-07-16'
    )
    expect(summary).toEqual({ todayKcal: null, weekAvgKcal: null, hasAnyData: false })
  })

  it("reports today's kcal and the prior-7-day average", () => {
    const summary = computeActiveEnergySummary(
      [
        makeEnergyMetric('2026-07-13', 400),
        makeEnergyMetric('2026-07-14', 500),
        makeEnergyMetric('2026-07-15', 600),
        makeEnergyMetric('2026-07-16', 120) // partial today — must NOT join the average
      ],
      '2026-07-16'
    )
    expect(summary.todayKcal).toBe(120)
    expect(summary.weekAvgKcal).toBe(500)
    expect(summary.hasAnyData).toBe(true)
  })

  it('excludes unsynced days from the average instead of counting them as zero', () => {
    // Only 2 of the prior 7 days synced — the mean divides by 2, not 7.
    const summary = computeActiveEnergySummary(
      [makeEnergyMetric('2026-07-10', 300), makeEnergyMetric('2026-07-14', 500)],
      '2026-07-16'
    )
    expect(summary.weekAvgKcal).toBe(400)
  })

  it('ignores readings older than 7 days and reports a missing today as null', () => {
    const summary = computeActiveEnergySummary(
      [
        makeEnergyMetric('2026-07-01', 900), // outside the 7-day window
        makeEnergyMetric('2026-07-15', 450)
      ],
      '2026-07-16'
    )
    expect(summary.todayKcal).toBeNull()
    expect(summary.weekAvgKcal).toBe(450)
    expect(summary.hasAnyData).toBe(true)
  })
})
