import { describe, expect, it } from 'vitest'
import type { UserConfig, Workout } from '@shared/types'
import {
  countSessionsForGoal,
  EM_DASH,
  endOfIsoWeek,
  fmtDelta,
  fmtDistance,
  fmtDuration,
  fmtNum,
  humanizeWorkoutType,
  parseWeeklyMinSessions,
  startOfIsoWeek
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
    raw: null,
    computed: null
  }
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

describe('startOfIsoWeek / endOfIsoWeek', () => {
  it('rolls a Wednesday back to the preceding Monday at local midnight', () => {
    const wed = new Date(2026, 0, 14, 15, 30) // Wed 14 Jan 2026, 15:30 local
    const start = startOfIsoWeek(wed)
    expect(start.getFullYear()).toBe(2026)
    expect(start.getMonth()).toBe(0)
    expect(start.getDate()).toBe(12) // Monday
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
  })

  it('treats Sunday as the end of the ISO week, rolling back 6 days to Monday', () => {
    const sun = new Date(2026, 0, 18, 10, 0) // Sun 18 Jan 2026
    const start = startOfIsoWeek(sun)
    expect(start.getDate()).toBe(12) // Monday of the same week
  })

  it('endOfIsoWeek is exactly 7 days after startOfIsoWeek', () => {
    const anyDay = new Date(2026, 0, 14, 15, 30)
    const start = startOfIsoWeek(anyDay)
    const end = endOfIsoWeek(anyDay)
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
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
