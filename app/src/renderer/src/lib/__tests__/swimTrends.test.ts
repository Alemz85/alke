import { describe, expect, it } from 'vitest'
import { fastest100, fastest25, monthlyAvgPace } from '../swimTrends'
import type { SwimSet } from '@shared/types'

function set(overrides: Partial<SwimSet> = {}): SwimSet {
  return {
    workout_id: 'w1',
    set_index: 0,
    start_offset_s: 0,
    duration_s: 60,
    distance_m: 100,
    strokes: 40,
    rest_after_s: null,
    ...overrides
  }
}

describe('monthlyAvgPace', () => {
  it('is set-weighted (total time / total distance) per month', () => {
    const byWorkout = new Map<string, SwimSet[]>([
      [
        'w1',
        [
          set({ workout_id: 'w1', duration_s: 90, distance_m: 100 }),
          set({ workout_id: 'w1', duration_s: 90, distance_m: 100 })
        ]
      ]
    ])
    const rows = monthlyAvgPace(byWorkout, () => '2026-06')
    expect(rows).toEqual([{ month: '2026-06', paceSecPer100m: 90 }])
  })

  it('produces one row per month with set data, sorted chronologically', () => {
    const byWorkout = new Map<string, SwimSet[]>([
      ['w-jul', [set({ workout_id: 'w-jul', duration_s: 100, distance_m: 100 })]],
      ['w-jun', [set({ workout_id: 'w-jun', duration_s: 80, distance_m: 100 })]]
    ])
    const monthOf = (id: string): string | null => (id === 'w-jul' ? '2026-07' : '2026-06')
    const rows = monthlyAvgPace(byWorkout, monthOf)
    expect(rows.map((r) => r.month)).toEqual(['2026-06', '2026-07'])
  })

  it('aggregates multiple workouts within the same month', () => {
    const byWorkout = new Map<string, SwimSet[]>([
      ['w1', [set({ workout_id: 'w1', duration_s: 60, distance_m: 100 })]],
      ['w2', [set({ workout_id: 'w2', duration_s: 120, distance_m: 100 })]]
    ])
    const rows = monthlyAvgPace(byWorkout, () => '2026-06')
    expect(rows).toEqual([{ month: '2026-06', paceSecPer100m: 90 }])
  })

  it('skips workouts that cannot be dated', () => {
    const byWorkout = new Map<string, SwimSet[]>([
      ['w1', [set({ workout_id: 'w1', duration_s: 60, distance_m: 100 })]]
    ])
    const rows = monthlyAvgPace(byWorkout, () => null)
    expect(rows).toEqual([])
  })

  it('skips months with zero total distance', () => {
    const byWorkout = new Map<string, SwimSet[]>([
      ['w1', [set({ workout_id: 'w1', duration_s: 60, distance_m: 0 })]]
    ])
    const rows = monthlyAvgPace(byWorkout, () => '2026-06')
    expect(rows).toEqual([])
  })

  it('returns empty for an empty map', () => {
    expect(monthlyAvgPace(new Map(), () => '2026-06')).toEqual([])
  })
})

describe('fastest25', () => {
  it('scales a longer set down to a 25m-equivalent time', () => {
    const sets = [set({ workout_id: 'w1', duration_s: 200, distance_m: 100 })]
    // 200s / 100m * 25m = 50s
    expect(fastest25(sets)).toEqual({ seconds: 50, workoutId: 'w1' })
  })

  it('picks the minimum scaled time across sets', () => {
    const sets = [
      set({ workout_id: 'w1', duration_s: 200, distance_m: 100 }), // 50s/25m
      set({ workout_id: 'w2', duration_s: 30, distance_m: 25 }) // 30s/25m — faster
    ]
    expect(fastest25(sets)).toEqual({ seconds: 30, workoutId: 'w2' })
  })

  it('ignores sets shorter than 25m', () => {
    const sets = [set({ workout_id: 'w1', duration_s: 10, distance_m: 12.5 })]
    expect(fastest25(sets)).toBeNull()
  })

  it('returns null for no sets', () => {
    expect(fastest25([])).toBeNull()
  })

  it('includes an exact 25m set', () => {
    const sets = [set({ workout_id: 'w1', duration_s: 31.2, distance_m: 25 })]
    expect(fastest25(sets)).toEqual({ seconds: 31.2, workoutId: 'w1' })
  })
})

describe('fastest100', () => {
  it('excludes an 80m set', () => {
    const sets = [set({ workout_id: 'w1', duration_s: 60, distance_m: 80 })]
    expect(fastest100(sets)).toBeNull()
  })

  it('picks a 100m set as the winner among mixed distances', () => {
    const sets = [
      set({ workout_id: 'w1', duration_s: 60, distance_m: 80 }),
      set({ workout_id: 'w2', duration_s: 95, distance_m: 100 })
    ]
    expect(fastest100(sets)).toEqual({ paceSecPer100m: 95, workoutId: 'w2' })
  })

  it('tolerates a 95m set (5m smearing tolerance)', () => {
    const sets = [set({ workout_id: 'w1', duration_s: 95, distance_m: 95 })]
    const result = fastest100(sets)
    expect(result).not.toBeNull()
    expect(result!.workoutId).toBe('w1')
    expect(result!.paceSecPer100m).toBeCloseTo((100 * 95) / 95, 5)
  })

  it('returns null for an empty set list', () => {
    expect(fastest100([])).toBeNull()
  })

  it('picks the minimum pace across multiple qualifying sets', () => {
    const sets = [
      set({ workout_id: 'w1', duration_s: 100, distance_m: 100 }),
      set({ workout_id: 'w2', duration_s: 190, distance_m: 200 })
    ]
    // w1: 100s/100m, w2: 95s/100m — w2 is faster
    expect(fastest100(sets)).toEqual({ paceSecPer100m: 95, workoutId: 'w2' })
  })
})
