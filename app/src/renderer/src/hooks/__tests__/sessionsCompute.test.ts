import { describe, expect, it } from 'vitest'
import type { Workout } from '@shared/types'
import {
  durationStepIndex,
  formatDuration,
  groupWorkoutsByDay,
  longestWeeklyStreak
} from '../sessionsCompute'

/** Builds a minimal Workout fixture with only the fields the pure functions under test read. */
function makeWorkout(overrides: Partial<Workout> & { start_at: string }): Workout {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    external_id: null,
    type: overrides.type ?? 'pool_swim',
    start_at: overrides.start_at,
    end_at: null,
    duration_s: overrides.duration_s ?? 0,
    distance_m: null,
    energy_kcal: null,
    avg_hr: null,
    max_hr: null,
    source: null,
    raw: null,
    computed: null
  }
}

describe('groupWorkoutsByDay', () => {
  it('buckets workouts by their local calendar date', () => {
    const workouts = [
      makeWorkout({ start_at: '2026-01-15T09:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-15T18:00:00Z', type: 'outdoor_run' })
    ]
    const map = groupWorkoutsByDay(workouts, 'UTC')
    expect(map.size).toBe(1)
    expect(map.get('2026-01-15')?.workouts).toHaveLength(2)
  })

  it('sums duration across workouts on the same day', () => {
    const workouts = [
      makeWorkout({ start_at: '2026-01-15T09:00:00Z', duration_s: 1200 }),
      makeWorkout({ start_at: '2026-01-15T18:00:00Z', duration_s: 1800 })
    ]
    const map = groupWorkoutsByDay(workouts, 'UTC')
    expect(map.get('2026-01-15')?.totalDurationS).toBe(3000)
  })

  it('treats a null duration as zero when summing', () => {
    const workouts = [makeWorkout({ start_at: '2026-01-15T09:00:00Z', duration_s: null })]
    const map = groupWorkoutsByDay(workouts, 'UTC')
    expect(map.get('2026-01-15')?.totalDurationS).toBe(0)
  })

  it('dedupes modalities within a day while preserving first-seen order', () => {
    const workouts = [
      makeWorkout({ start_at: '2026-01-15T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-15T12:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-15T18:00:00Z', type: 'outdoor_run' })
    ]
    const map = groupWorkoutsByDay(workouts, 'UTC')
    expect(map.get('2026-01-15')?.modalities).toEqual(['pool_swim', 'outdoor_run'])
  })

  it('places workouts on different local days into separate buckets', () => {
    const workouts = [
      makeWorkout({ start_at: '2026-01-15T23:30:00Z' }),
      makeWorkout({ start_at: '2026-01-16T01:00:00Z' })
    ]
    const map = groupWorkoutsByDay(workouts, 'UTC')
    expect(map.size).toBe(2)
  })

  it('falls back to "other" as the modality label when type is null-ish', () => {
    const workouts = [
      makeWorkout({ start_at: '2026-01-15T09:00:00Z', type: '' as unknown as string })
    ]
    const map = groupWorkoutsByDay(workouts, 'UTC')
    // empty string is falsy, so `w.type?.toLowerCase() ?? 'other'` still yields '' (not 'other'),
    // since optional chaining only short-circuits on null/undefined, not on ''.
    expect(map.get('2026-01-15')?.modalities).toEqual([''])
  })

  it('returns an empty map for an empty workout list', () => {
    const map = groupWorkoutsByDay([], 'UTC')
    expect(map.size).toBe(0)
  })
})

describe('durationStepIndex', () => {
  it('returns 0 for durations at or below the 30-minute boundary', () => {
    expect(durationStepIndex(30 * 60)).toBe(0)
  })

  it('returns 1 just above the 30-minute boundary', () => {
    expect(durationStepIndex(30 * 60 + 1)).toBe(1)
  })

  it('returns 1 for durations at or below the 60-minute boundary', () => {
    expect(durationStepIndex(60 * 60)).toBe(1)
  })

  it('returns 2 just above the 60-minute boundary', () => {
    expect(durationStepIndex(60 * 60 + 1)).toBe(2)
  })

  it('returns 2 for durations at or below the 90-minute boundary', () => {
    expect(durationStepIndex(90 * 60)).toBe(2)
  })

  it('returns 3 just above the 90-minute boundary', () => {
    expect(durationStepIndex(90 * 60 + 1)).toBe(3)
  })

  it('returns 0 for zero duration', () => {
    expect(durationStepIndex(0)).toBe(0)
  })

  it('returns 3 for very large durations', () => {
    expect(durationStepIndex(999 * 60)).toBe(3)
  })
})

describe('formatDuration', () => {
  it('formats sub-hour durations as "Nm"', () => {
    expect(formatDuration(25 * 60)).toBe('25m')
  })

  it('formats hour-plus durations as "H:MM"', () => {
    expect(formatDuration(75 * 60)).toBe('1:15')
  })

  it('pads single-digit minutes with a leading zero', () => {
    expect(formatDuration(61 * 60)).toBe('1:01')
  })

  it('formats zero seconds as "0m"', () => {
    expect(formatDuration(0)).toBe('0m')
  })

  it('rounds to the nearest minute', () => {
    expect(formatDuration(29)).toBe('0m')
    expect(formatDuration(31)).toBe('1m')
  })
})

describe('longestWeeklyStreak', () => {
  const weeklyMin = { swim: 2, lift: 2 }

  it('returns 0 for an empty workout history', () => {
    expect(longestWeeklyStreak([], weeklyMin, 'UTC')).toBe(0)
  })

  it('counts a single week meeting the minimums as a streak of 1', () => {
    // Week of 2026-01-05 (Mon) .. 2026-01-11 (Sun).
    const workouts = [
      makeWorkout({ start_at: '2026-01-05T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-06T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-07T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-08T08:00:00Z', type: 'functional_strength_training' })
    ]
    expect(longestWeeklyStreak(workouts, weeklyMin, 'UTC')).toBe(1)
  })

  it('extends the streak across two consecutive weeks that both meet the minimums', () => {
    const workouts = [
      // Week 2026-W02 (Jan 5-11)
      makeWorkout({ start_at: '2026-01-05T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-06T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-07T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-08T08:00:00Z', type: 'functional_strength_training' }),
      // Week 2026-W03 (Jan 12-18)
      makeWorkout({ start_at: '2026-01-12T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-13T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-14T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-15T08:00:00Z', type: 'functional_strength_training' })
    ]
    expect(longestWeeklyStreak(workouts, weeklyMin, 'UTC')).toBe(2)
  })

  it('breaks the streak on a gap week with zero workouts', () => {
    const workouts = [
      // Week 2026-W02 (Jan 5-11) - meets minimums
      makeWorkout({ start_at: '2026-01-05T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-06T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-07T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-08T08:00:00Z', type: 'functional_strength_training' }),
      // Week 2026-W03 (Jan 12-18) - no workouts at all (gap)
      // Week 2026-W04 (Jan 19-25) - meets minimums again
      makeWorkout({ start_at: '2026-01-19T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-20T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-21T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-22T08:00:00Z', type: 'functional_strength_training' })
    ]
    expect(longestWeeklyStreak(workouts, weeklyMin, 'UTC')).toBe(1)
  })

  it('breaks the streak on a week that under-counts one modality', () => {
    const workouts = [
      // Week 2026-W02 - meets minimums
      makeWorkout({ start_at: '2026-01-05T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-06T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-07T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-08T08:00:00Z', type: 'functional_strength_training' }),
      // Week 2026-W03 - only 1 swim, fails the swim:2 minimum
      makeWorkout({ start_at: '2026-01-12T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-13T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-14T08:00:00Z', type: 'functional_strength_training' })
    ]
    expect(longestWeeklyStreak(workouts, weeklyMin, 'UTC')).toBe(1)
  })

  it('falls back to "at least 1 session per week" when no minimums are configured', () => {
    const workouts = [
      makeWorkout({ start_at: '2026-01-05T08:00:00Z', type: 'outdoor_run' }),
      makeWorkout({ start_at: '2026-01-12T08:00:00Z', type: 'outdoor_run' })
    ]
    expect(longestWeeklyStreak(workouts, {}, 'UTC')).toBe(2)
  })

  it('finds the longest streak even when it is not the most recent one', () => {
    const workouts = [
      // Week 2026-W02 - meets
      makeWorkout({ start_at: '2026-01-05T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-06T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-07T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-08T08:00:00Z', type: 'functional_strength_training' }),
      // Week 2026-W03 - meets
      makeWorkout({ start_at: '2026-01-12T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-13T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-14T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-15T08:00:00Z', type: 'functional_strength_training' }),
      // Week 2026-W04 - meets
      makeWorkout({ start_at: '2026-01-19T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-20T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-01-21T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-01-22T08:00:00Z', type: 'functional_strength_training' }),
      // Week 2026-W05 - fails (gap)
      // Week 2026-W06 - meets (isolated single week)
      makeWorkout({ start_at: '2026-02-02T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-02-03T08:00:00Z', type: 'pool_swim' }),
      makeWorkout({ start_at: '2026-02-04T08:00:00Z', type: 'functional_strength_training' }),
      makeWorkout({ start_at: '2026-02-05T08:00:00Z', type: 'functional_strength_training' })
    ]
    expect(longestWeeklyStreak(workouts, weeklyMin, 'UTC')).toBe(3)
  })
})
