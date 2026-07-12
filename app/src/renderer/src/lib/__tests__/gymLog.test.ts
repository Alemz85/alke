import { describe, expect, it } from 'vitest'
import type { GymSession, GymSet, GymTemplate } from '@shared/types'
import {
  groupSetsIntoBlocks,
  isStrengthWorkout,
  prefillFromTemplate,
  sessionVolumeKg,
  summarizeSession
} from '../gymLog'

let setId = 0
function set(partial: Partial<GymSet> & { exercise_id: string; position: number }): GymSet {
  setId += 1
  return {
    id: setId,
    session_id: 'sess-1',
    exercise_name: partial.exercise_id,
    reps: null,
    weight_kg: null,
    rpe: null,
    is_warmup: false,
    note: null,
    ...partial
  }
}

function session(partial: Partial<GymSession> = {}): GymSession {
  return {
    id: 'sess-1',
    workout_id: null,
    template_id: null,
    performed_at: '2026-07-10T10:00:00.000Z',
    title: null,
    notes: null,
    source: 'user',
    sets: [],
    created_at: null,
    updated_at: null,
    ...partial
  }
}

function template(partial: Partial<GymTemplate> = {}): GymTemplate {
  return {
    id: 'tmpl-1',
    name: 'Legs',
    notes: null,
    archived: false,
    items: [],
    created_at: null,
    updated_at: null,
    ...partial
  }
}

// ── groupSetsIntoBlocks ──────────────────────────────────────────────────────

describe('groupSetsIntoBlocks', () => {
  it('groups consecutive same-exercise sets into one block', () => {
    const sets = [
      set({ exercise_id: 'squat', position: 0 }),
      set({ exercise_id: 'squat', position: 1 }),
      set({ exercise_id: 'squat', position: 2 })
    ]
    const blocks = groupSetsIntoBlocks(sets)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].exerciseId).toBe('squat')
    expect(blocks[0].sets).toHaveLength(3)
  })

  it('keeps interleaved runs of the same exercise as separate blocks', () => {
    const sets = [
      set({ exercise_id: 'squat', position: 0 }),
      set({ exercise_id: 'bench', position: 1 }),
      set({ exercise_id: 'squat', position: 2 })
    ]
    const blocks = groupSetsIntoBlocks(sets)
    expect(blocks.map((b) => b.exerciseId)).toEqual(['squat', 'bench', 'squat'])
    expect(blocks[0].sets).toHaveLength(1)
    expect(blocks[2].sets).toHaveLength(1)
  })

  it('sorts by position before grouping regardless of input order', () => {
    const sets = [
      set({ exercise_id: 'bench', position: 1 }),
      set({ exercise_id: 'squat', position: 0 })
    ]
    const blocks = groupSetsIntoBlocks(sets)
    expect(blocks.map((b) => b.exerciseId)).toEqual(['squat', 'bench'])
  })

  it('returns an empty array for no sets', () => {
    expect(groupSetsIntoBlocks([])).toEqual([])
  })
})

// ── sessionVolumeKg ───────────────────────────────────────────────────────────

describe('sessionVolumeKg', () => {
  it('sums reps × weight over non-warmup sets', () => {
    const sets = [
      set({ exercise_id: 'squat', position: 0, reps: 8, weight_kg: 60 }),
      set({ exercise_id: 'squat', position: 1, reps: 8, weight_kg: 60 })
    ]
    expect(sessionVolumeKg(sets)).toBe(960)
  })

  it('excludes warmup sets', () => {
    const sets = [
      set({ exercise_id: 'squat', position: 0, reps: 10, weight_kg: 20, is_warmup: true }),
      set({ exercise_id: 'squat', position: 1, reps: 8, weight_kg: 60 })
    ]
    expect(sessionVolumeKg(sets)).toBe(480)
  })

  it('excludes sets with null reps or null weight (bodyweight)', () => {
    const sets = [
      set({ exercise_id: 'pullup', position: 0, reps: 10, weight_kg: null }),
      set({ exercise_id: 'squat', position: 1, reps: null, weight_kg: 60 }),
      set({ exercise_id: 'squat', position: 2, reps: 8, weight_kg: 60 })
    ]
    expect(sessionVolumeKg(sets)).toBe(480)
  })

  it('returns 0 for no sets', () => {
    expect(sessionVolumeKg([])).toBe(0)
  })
})

// ── summarizeSession ──────────────────────────────────────────────────────────

describe('summarizeSession', () => {
  it('summarizes a full log with exercises, sets, and volume', () => {
    const sets = [
      set({ exercise_id: 'squat', position: 0, reps: 8, weight_kg: 60 }),
      set({ exercise_id: 'squat', position: 1, reps: 8, weight_kg: 60 }),
      set({ exercise_id: 'bench', position: 2, reps: 10, weight_kg: 40 })
    ]
    const s = session({ sets })
    expect(summarizeSession(s, null)).toBe('2 exercises · 3 sets · 1,360 kg')
  })

  it('excludes warmups from the set count but keeps them out of exercise count logic', () => {
    const sets = [
      set({ exercise_id: 'squat', position: 0, reps: 10, weight_kg: 20, is_warmup: true }),
      set({ exercise_id: 'squat', position: 1, reps: 8, weight_kg: 60 })
    ]
    const s = session({ sets })
    expect(summarizeSession(s, null)).toBe('1 exercise · 1 set · 480 kg')
  })

  it('omits the volume segment when volume is 0 (all bodyweight)', () => {
    const sets = [set({ exercise_id: 'pullup', position: 0, reps: 10, weight_kg: null })]
    const s = session({ sets })
    expect(summarizeSession(s, null)).toBe('1 exercise · 1 set')
  })

  it('quick log with a template name', () => {
    const s = session({ sets: [], template_id: 'tmpl-1' })
    expect(summarizeSession(s, 'Legs')).toBe('Quick log — roughly Legs')
  })

  it('quick log without a template', () => {
    const s = session({ sets: [] })
    expect(summarizeSession(s, null)).toBe('Quick log')
  })

  it('formats large volume with thousands grouping', () => {
    const sets = [set({ exercise_id: 'squat', position: 0, reps: 100, weight_kg: 100 })]
    const s = session({ sets })
    expect(summarizeSession(s, null)).toBe('1 exercise · 1 set · 10,000 kg')
  })
})

// ── prefillFromTemplate ────────────────────────────────────────────────────────

describe('prefillFromTemplate', () => {
  it('expands target_sets rows per item with targets prefilled', () => {
    const t = template({
      items: [
        {
          id: 'item-1',
          template_id: 'tmpl-1',
          exercise_id: 'squat',
          exercise_name: 'Squat',
          position: 0,
          target_sets: 3,
          target_reps: 8,
          target_weight_kg: 60,
          note: null
        }
      ]
    })
    const rows = prefillFromTemplate(t)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      exerciseId: 'squat',
      exerciseName: 'Squat',
      reps: 8,
      weightKg: 60,
      isWarmup: false
    })
  })

  it('defaults to 3 rows when target_sets is null', () => {
    const t = template({
      items: [
        {
          id: 'item-1',
          template_id: 'tmpl-1',
          exercise_id: 'bench',
          exercise_name: 'Bench press',
          position: 0,
          target_sets: null,
          target_reps: null,
          target_weight_kg: null,
          note: null
        }
      ]
    })
    const rows = prefillFromTemplate(t)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.reps === null && r.weightKg === null)).toBe(true)
  })

  it('orders rows by item position and preserves per-item grouping', () => {
    const t = template({
      items: [
        {
          id: 'item-2',
          template_id: 'tmpl-1',
          exercise_id: 'rdl',
          exercise_name: 'RDL',
          position: 1,
          target_sets: 1,
          target_reps: 12,
          target_weight_kg: 50,
          note: null
        },
        {
          id: 'item-1',
          template_id: 'tmpl-1',
          exercise_id: 'squat',
          exercise_name: 'Squat',
          position: 0,
          target_sets: 1,
          target_reps: 8,
          target_weight_kg: 60,
          note: null
        }
      ]
    })
    const rows = prefillFromTemplate(t)
    expect(rows.map((r) => r.exerciseId)).toEqual(['squat', 'rdl'])
  })

  it('returns an empty array for a template with no items', () => {
    expect(prefillFromTemplate(template({ items: [] }))).toEqual([])
  })
})

// ── isStrengthWorkout ──────────────────────────────────────────────────────────

describe('isStrengthWorkout', () => {
  it('matches strength and core types case-insensitively', () => {
    expect(isStrengthWorkout('functional_strength_training')).toBe(true)
    expect(isStrengthWorkout('Core Training')).toBe(true)
    expect(isStrengthWorkout('CORE')).toBe(true)
  })

  it('rejects non-strength types', () => {
    expect(isStrengthWorkout('running')).toBe(false)
    expect(isStrengthWorkout('pool_swim')).toBe(false)
  })

  it('handles null', () => {
    expect(isStrengthWorkout(null)).toBe(false)
  })
})
