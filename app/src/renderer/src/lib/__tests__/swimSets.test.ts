import { describe, expect, it } from 'vitest'
import type { SwimSet } from '@shared/types'
import {
  clusterStructure,
  paceSecPer100m,
  sessionFadePct,
  summarizeSession,
  swolf25
} from '../swimSets'

function set(partial: Partial<SwimSet> & { set_index: number }): SwimSet {
  return {
    workout_id: 'w1',
    start_offset_s: 0,
    duration_s: 67,
    distance_m: 50,
    strokes: 23,
    rest_after_s: 35,
    ...partial
  }
}

describe('paceSecPer100m', () => {
  it('derives seconds per 100m', () => {
    expect(paceSecPer100m(set({ set_index: 1, duration_s: 67, distance_m: 50 }))).toBeCloseTo(134)
  })
  it('returns null for zero distance', () => {
    expect(paceSecPer100m(set({ set_index: 1, distance_m: 0 }))).toBeNull()
  })
})

describe('swolf25', () => {
  it('normalizes time + strokes per 25m', () => {
    // (67s + 23 strokes) / (50m / 25m) = 45
    expect(swolf25(set({ set_index: 1 }))).toBeCloseTo(45)
  })
  it('returns null for zero distance', () => {
    expect(swolf25(set({ set_index: 1, distance_m: 0 }))).toBeNull()
  })
})

describe('clusterStructure', () => {
  it('describes a uniform session', () => {
    const sets = Array.from({ length: 25 }, (_, i) => set({ set_index: i + 1 }))
    expect(clusterStructure(sets)).toBe('25×50m')
  })
  it('clusters near-equal distances (rounded to 5m) and joins mixed structures', () => {
    const sets = [
      ...Array.from({ length: 8 }, (_, i) => set({ set_index: i + 1, distance_m: 99.2 })),
      ...Array.from({ length: 4 }, (_, i) => set({ set_index: i + 9, distance_m: 51.1 }))
    ]
    expect(clusterStructure(sets)).toBe('8×100m + 4×50m')
  })
  it('returns empty string for no sets', () => {
    expect(clusterStructure([])).toBe('')
  })
})

describe('sessionFadePct', () => {
  it('compares second-half mean pace to first-half', () => {
    const sets = [
      set({ set_index: 1, duration_s: 60 }), // 120 s/100m
      set({ set_index: 2, duration_s: 60 }),
      set({ set_index: 3, duration_s: 66 }), // 132 s/100m
      set({ set_index: 4, duration_s: 66 })
    ]
    expect(sessionFadePct(sets)).toBeCloseTo(10) // (132 - 120) / 120
  })
  it('returns null with fewer than 4 sets', () => {
    expect(sessionFadePct([set({ set_index: 1 }), set({ set_index: 2 })])).toBeNull()
  })
})

describe('summarizeSession', () => {
  it('aggregates a session', () => {
    const sets = [
      set({ set_index: 1, duration_s: 60, rest_after_s: 30 }),
      set({ set_index: 2, duration_s: 70, rest_after_s: 40 }),
      set({ set_index: 3, duration_s: 62, rest_after_s: 36 }),
      set({ set_index: 4, duration_s: 68, rest_after_s: null })
    ]
    const s = summarizeSession(sets)
    expect(s.nSets).toBe(4)
    expect(s.setDistanceM).toBe(200)
    // weighted: total time / total distance -> (260 / 200) * 100 = 130
    expect(s.avgPaceSecPer100m).toBeCloseTo(130)
    expect(s.medianRestS).toBe(36)
    expect(s.medianSwolf25).not.toBeNull()
  })
  it('returns null aggregates for empty input', () => {
    const s = summarizeSession([])
    expect(s.nSets).toBe(0)
    expect(s.avgPaceSecPer100m).toBeNull()
    expect(s.medianRestS).toBeNull()
  })
})
