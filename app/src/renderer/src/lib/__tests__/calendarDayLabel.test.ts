import { describe, expect, it } from 'vitest'
import type { Workout } from '@shared/types'
import type { DayBucket } from '../../hooks/sessionsCompute'
import { calendarDayLabel, formatWorkoutDuration, workoutDisplayName } from '../calendarDayLabel'

function workout(type: string, durationS: number): Workout {
  return {
    id: `${type}-${durationS}`,
    external_id: null,
    type,
    start_at: '2026-07-11T08:00:00Z',
    end_at: null,
    duration_s: durationS,
    distance_m: null,
    energy_kcal: null,
    avg_hr: null,
    max_hr: null,
    source: null,
    raw: null,
    computed: null
  } as unknown as Workout
}

function bucket(...workouts: Workout[]): DayBucket {
  return {
    dateKey: '2026-07-11',
    workouts,
    totalDurationS: workouts.reduce((s, w) => s + (w.duration_s ?? 0), 0),
    modalities: [...new Set(workouts.map((w) => w.type?.toLowerCase() ?? 'other'))]
  }
}

describe('workoutDisplayName', () => {
  it('collapses every strength/core variant to "Gym"', () => {
    expect(workoutDisplayName('functional_strength_training')).toBe('Gym')
    expect(workoutDisplayName('traditional_strength_training')).toBe('Gym')
    expect(workoutDisplayName('core_training')).toBe('Gym')
  })

  it('reuses the cardio modality labels', () => {
    expect(workoutDisplayName('pool_swim')).toBe('Swim')
    expect(workoutDisplayName('indoor_cycling')).toBe('Cycling')
    expect(workoutDisplayName('rowing')).toBe('Rowing')
    expect(workoutDisplayName('indoor_walk')).toBe('Walking')
  })

  it('names run/yoga and title-cases an unknown type', () => {
    expect(workoutDisplayName('indoor_run')).toBe('Run')
    expect(workoutDisplayName('yoga')).toBe('Yoga')
    expect(workoutDisplayName('high_intensity_interval_training')).toBe(
      'High Intensity Interval Training'
    )
    expect(workoutDisplayName(null)).toBe('Workout')
  })
})

describe('formatWorkoutDuration', () => {
  it('shows whole minutes under an hour', () => {
    expect(formatWorkoutDuration(44 * 60)).toBe('44m')
    expect(formatWorkoutDuration(0)).toBe('0m')
    expect(formatWorkoutDuration(90)).toBe('2m') // rounds to nearest minute
  })

  it('shows hours + minutes over an hour, "Nh" exactly on the hour', () => {
    expect(formatWorkoutDuration(105 * 60)).toBe('1h 45m')
    expect(formatWorkoutDuration(60 * 60)).toBe('1h')
    expect(formatWorkoutDuration(125 * 60)).toBe('2h 5m')
  })
})

describe('calendarDayLabel', () => {
  it('splits a single-workout day into name + duration (for the two-line cell)', () => {
    expect(calendarDayLabel(bucket(workout('pool_swim', 44 * 60)))).toEqual({
      name: 'Swim',
      duration: '44m'
    })
    expect(calendarDayLabel(bucket(workout('functional_strength_training', 63 * 60)))).toEqual({
      name: 'Gym',
      duration: '1h 3m'
    })
  })

  it('names a multi-workout day after the LONGEST activity, with the day total', () => {
    // Swim 30m + Cycling 60m (both cardio, no gym) → longest is Cycling, total 1h 30m.
    expect(
      calendarDayLabel(bucket(workout('pool_swim', 30 * 60), workout('indoor_cycling', 60 * 60)))
    ).toEqual({ name: 'Cycling', duration: '1h 30m' })
  })

  it('returns null for an empty or absent day', () => {
    expect(calendarDayLabel(undefined)).toBeNull()
    expect(calendarDayLabel(null)).toBeNull()
    expect(calendarDayLabel(bucket())).toBeNull()
  })

  it('labels a mixed gym + cardio day "Gym + Cardio" with the day total, regardless of which is longer', () => {
    // Swim 30m + Gym 60m -> mixed, even though gym is longer.
    expect(
      calendarDayLabel(
        bucket(workout('pool_swim', 30 * 60), workout('traditional_strength_training', 60 * 60))
      )
    ).toEqual({ name: 'Gym + Cardio', duration: '1h 30m' })
    // Gym 20m + Swim 50m -> mixed, even though cardio is longer.
    expect(
      calendarDayLabel(
        bucket(workout('core_training', 20 * 60), workout('pool_swim', 50 * 60))
      )
    ).toEqual({ name: 'Gym + Cardio', duration: '1h 10m' })
  })

  it('does not label "Gym + Cardio" for gym-only or cardio-only days', () => {
    expect(calendarDayLabel(bucket(workout('traditional_strength_training', 40 * 60)))).toEqual({
      name: 'Gym',
      duration: '40m'
    })
    expect(
      calendarDayLabel(bucket(workout('pool_swim', 20 * 60), workout('indoor_cycling', 20 * 60)))
    ).not.toEqual(expect.objectContaining({ name: 'Gym + Cardio' }))
  })

  it('does not label "Gym + Cardio" when the second activity is "other" (neither gym nor cardio)', () => {
    expect(
      calendarDayLabel(
        bucket(workout('traditional_strength_training', 40 * 60), workout('other', 10 * 60))
      )
    ).not.toEqual(expect.objectContaining({ name: 'Gym + Cardio' }))
  })
})
