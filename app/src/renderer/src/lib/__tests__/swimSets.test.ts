import { describe, expect, it } from 'vitest'
import type { SwimSet, WorkoutHrSample } from '@shared/types'
import {
  bestEfforts,
  clusterStructure,
  dpsMPerCycle,
  groupByWorkout,
  normalizeHrTrack,
  paceSecPer100m,
  restRecoveryBpm,
  sessionFadePct,
  setAvgHr,
  strokeRatePerMin,
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
  it('normalizes time + both-hands strokes (2× watch-arm cycles) per 25m', () => {
    // (67s + 2×23 strokes) / (50m / 25m) = 56.5
    expect(swolf25(set({ set_index: 1 }))).toBeCloseTo(56.5)
  })
  it('returns null for zero distance', () => {
    expect(swolf25(set({ set_index: 1, distance_m: 0 }))).toBeNull()
  })
})

function hrTrace(spans: { fromS: number; toS: number; bpm: number }[]): WorkoutHrSample[] {
  const samples: WorkoutHrSample[] = []
  for (const span of spans) {
    for (let t = span.fromS; t < span.toS; t++) {
      samples.push({ workout_id: 'w1', offset_s: t, bpm: span.bpm })
    }
  }
  return samples
}

describe('setAvgHr', () => {
  it('averages bpm inside the set window only', () => {
    const samples = hrTrace([
      { fromS: 0, toS: 60, bpm: 130 }, // in set
      { fromS: 60, toS: 95, bpm: 110 } // rest — excluded
    ])
    expect(setAvgHr(set({ set_index: 1, start_offset_s: 0, duration_s: 60 }), samples)).toBe(130)
  })
  it('returns null when the trace is too sparse', () => {
    const samples = hrTrace([{ fromS: 0, toS: 3, bpm: 130 }])
    expect(setAvgHr(set({ set_index: 1, start_offset_s: 0, duration_s: 60 }), samples)).toBeNull()
  })
})

describe('restRecoveryBpm', () => {
  it('measures peak-of-set-end minus rest minimum', () => {
    const samples = hrTrace([
      { fromS: 0, toS: 60, bpm: 138 }, // set
      { fromS: 60, toS: 80, bpm: 122 }, // rest, falling
      { fromS: 80, toS: 95, bpm: 118 } // rest floor
    ])
    expect(
      restRecoveryBpm(set({ set_index: 1, start_offset_s: 0, duration_s: 60, rest_after_s: 35 }), samples)
    ).toBe(20) // 138 - 118
  })
  it('returns null for short rests', () => {
    expect(
      restRecoveryBpm(set({ set_index: 1, rest_after_s: 10 }), hrTrace([{ fromS: 0, toS: 90, bpm: 130 }]))
    ).toBeNull()
  })
  it('returns null on the last set (no rest)', () => {
    expect(
      restRecoveryBpm(set({ set_index: 1, rest_after_s: null }), hrTrace([{ fromS: 0, toS: 90, bpm: 130 }]))
    ).toBeNull()
  })
})

describe('stroke mechanics', () => {
  it('derives distance per cycle and stroke rate per set', () => {
    const s = set({ set_index: 1, distance_m: 50, strokes: 23, duration_s: 69 })
    expect(dpsMPerCycle(s)).toBeCloseTo(50 / 23)
    expect(strokeRatePerMin(s)).toBeCloseTo(20) // 23 / (69/60)
  })
  it('returns null on zero strokes / zero duration', () => {
    expect(dpsMPerCycle(set({ set_index: 1, strokes: 0 }))).toBeNull()
    expect(strokeRatePerMin(set({ set_index: 1, duration_s: 0 }))).toBeNull()
  })
  it('aggregates into the session summary from totals', () => {
    const summary = summarizeSession([
      set({ set_index: 1, distance_m: 50, strokes: 20, duration_s: 60 }),
      set({ set_index: 2, distance_m: 50, strokes: 30, duration_s: 60 })
    ])
    expect(summary.dpsMPerCycle).toBeCloseTo(2) // 100m / 50 cycles
    expect(summary.strokeRatePerMin).toBeCloseTo(25) // 50 cycles / 2 min
  })
})

describe('normalizeHrTrack', () => {
  it('maps time and bpm to the unit square over the window', () => {
    const samples = hrTrace([
      { fromS: 10, toS: 12, bpm: 100 },
      { fromS: 12, toS: 14, bpm: 140 }
    ])
    const track = normalizeHrTrack(samples, 10, 20)
    expect(track[0]).toEqual({ t: 0, v: 0 })
    expect(track[track.length - 1]).toEqual({ t: 0.3, v: 1 }) // offset 13 of [10,20], 140 of [100,140]
  })
  it('excludes samples outside the window', () => {
    const samples = hrTrace([{ fromS: 0, toS: 100, bpm: 120 }, { fromS: 100, toS: 101, bpm: 150 }])
    // window [0,50]: only the flat 120 stretch -> no bpm range -> empty
    expect(normalizeHrTrack(samples, 0, 50)).toEqual([])
  })
  it('is empty for degenerate windows or sparse traces', () => {
    expect(normalizeHrTrack([], 0, 100)).toEqual([])
    expect(normalizeHrTrack(hrTrace([{ fromS: 0, toS: 90, bpm: 130 }]), 50, 50)).toEqual([])
  })
})

describe('bestEfforts', () => {
  it('finds fastest qualifying set, best session pace, and best session SWOLF', () => {
    const byWorkout = groupByWorkout([
      // session A: one fast 50m set, slow overall
      set({ set_index: 1, workout_id: 'a', duration_s: 55, distance_m: 50 }), // 110 s/100m
      set({ set_index: 2, workout_id: 'a', duration_s: 80, distance_m: 50 }),
      // session B: steadier — best session pace
      set({ set_index: 1, workout_id: 'b', duration_s: 62, distance_m: 50 }),
      set({ set_index: 2, workout_id: 'b', duration_s: 63, distance_m: 50, strokes: 20 }),
      // a short 25m block must not win fastest set despite the burst pace
      set({ set_index: 3, workout_id: 'b', duration_s: 25, distance_m: 25 }) // 100 s/100m but <45m
    ])
    const best = bestEfforts(byWorkout)
    expect(best.fastestSet?.workoutId).toBe('a')
    expect(best.fastestSet?.paceSecPer100m).toBeCloseTo(110)
    expect(best.bestSessionPace?.workoutId).toBe('b')
    expect(best.bestSessionSwolf25).not.toBeNull()
  })
  it('is all-null on empty input', () => {
    const best = bestEfforts(new Map())
    expect(best.fastestSet).toBeNull()
    expect(best.bestSessionPace).toBeNull()
    expect(best.bestSessionSwolf25).toBeNull()
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
