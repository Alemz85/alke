import { describe, expect, it } from 'vitest'
import type { Exercise, GymSession, GymSet, GymTemplate } from '@shared/types'
import {
  buildQuickSetRows,
  blocksToNewSets,
  exerciseUsage,
  formatExerciseSetSummary,
  formatRest,
  formatSetLine,
  groupExerciseBlocksByBodyPart,
  groupSetsIntoBlocks,
  isStrengthWorkout,
  lastPerformance,
  muscleSetVolume,
  prefillFromTemplate,
  prefillFromTemplates,
  sessionBodyParts,
  sessionVolumeKg,
  summarizeSession,
  uniformPrefillDose
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
    ...partial,
    is_eccentric: partial.is_eccentric ?? false
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
    body_parts: null,
    sets: [],
    created_at: null,
    updated_at: null,
    ...partial,
    template_ids: partial.template_ids ?? []
  }
}

function exercise(partial: Partial<Exercise> & { id: string }): Exercise {
  return {
    name: partial.id,
    aliases: [],
    body_part: null,
    primary_muscles: [],
    secondary_muscles: [],
    equipment: null,
    mechanics: null,
    movement_pattern: null,
    source: 'catalog',
    created_at: null,
    ...partial
  }
}

function template(partial: Partial<GymTemplate> = {}): GymTemplate {
  return {
    id: 'tmpl-1',
    name: 'Legs',
    notes: null,
    archived: false,
    default_rest_s: null,
    family_id: 'tmpl-1-family',
    version: 1,
    is_current: true,
    runs: [],
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

describe('formatExerciseSetSummary', () => {
  it('formats uniform working sets as count by reps', () => {
    expect(
      formatExerciseSetSummary([
        set({ exercise_id: 'bench', position: 0, reps: 8 }),
        set({ exercise_id: 'bench', position: 1, reps: 8 }),
        set({ exercise_id: 'bench', position: 2, reps: 8 })
      ])
    ).toBe('3 × 8')
  })

  it('shows the rep sequence for mixed working sets', () => {
    expect(
      formatExerciseSetSummary([
        set({ exercise_id: 'bench', position: 0, reps: 8 }),
        set({ exercise_id: 'bench', position: 1, reps: 8 }),
        set({ exercise_id: 'bench', position: 2, reps: 6 })
      ])
    ).toBe('3 sets · 8 / 8 / 6')
  })

  it('excludes warm-ups from the compact summary', () => {
    expect(
      formatExerciseSetSummary([
        set({ exercise_id: 'bench', position: 0, reps: 12, is_warmup: true }),
        set({ exercise_id: 'bench', position: 1, reps: 8 }),
        set({ exercise_id: 'bench', position: 2, reps: 8 })
      ])
    ).toBe('2 × 8')
  })
})

describe('groupExerciseBlocksByBodyPart', () => {
  it('keeps exact logged exercise order while grouping only contiguous body-part runs', () => {
    const blocks = groupSetsIntoBlocks([
      set({ exercise_id: 'curl', position: 0, reps: 10 }),
      set({ exercise_id: 'bench', position: 1, reps: 8 }),
      set({ exercise_id: 'row', position: 2, reps: 8 }),
      set({ exercise_id: 'triceps', position: 3, reps: 12 })
    ])
    const exercises = new Map([
      ['curl', exercise({ id: 'curl', body_part: 'arms' })],
      ['bench', exercise({ id: 'bench', body_part: 'chest' })],
      ['row', exercise({ id: 'row', body_part: 'back' })],
      ['triceps', exercise({ id: 'triceps', body_part: 'arms' })]
    ])

    const groups = groupExerciseBlocksByBodyPart(blocks, exercises)

    expect(groups.map((group) => group.bodyPart)).toEqual(['arms', 'chest', 'back', 'arms'])
    expect(groups.flatMap((group) => group.blocks.map((block) => block.exerciseId))).toEqual([
      'curl',
      'bench',
      'row',
      'triceps'
    ])
  })

  it('keeps adjacent exercises from one body part under one heading', () => {
    const blocks = groupSetsIntoBlocks([
      set({ exercise_id: 'curl', position: 0 }),
      set({ exercise_id: 'triceps', position: 1 }),
      set({ exercise_id: 'bench', position: 2 })
    ])
    const exercises = new Map([
      ['curl', exercise({ id: 'curl', body_part: 'arms' })],
      ['triceps', exercise({ id: 'triceps', body_part: 'arms' })],
      ['bench', exercise({ id: 'bench', body_part: 'chest' })]
    ])

    expect(groupExerciseBlocksByBodyPart(blocks, exercises)).toMatchObject([
      { bodyPart: 'arms', blocks: [{ exerciseId: 'curl' }, { exerciseId: 'triceps' }] },
      { bodyPart: 'chest', blocks: [{ exerciseId: 'bench' }] }
    ])
  })

  it('puts exercises without body-part metadata in Other', () => {
    const blocks = groupSetsIntoBlocks([set({ exercise_id: 'custom', position: 0, reps: 10 })])
    expect(groupExerciseBlocksByBodyPart(blocks, new Map())).toEqual([
      { bodyPart: 'other', blocks }
    ])
  })
})

describe('buildQuickSetRows', () => {
  it('creates the requested working sets and reps', () => {
    expect(buildQuickSetRows('bench', 'Bench Press', 3, 8)).toEqual([
      { exerciseId: 'bench', exerciseName: 'Bench Press', reps: 8, weightKg: null, isWarmup: false },
      { exerciseId: 'bench', exerciseName: 'Bench Press', reps: 8, weightKg: null, isWarmup: false },
      { exerciseId: 'bench', exerciseName: 'Bench Press', reps: 8, weightKg: null, isWarmup: false }
    ])
  })

  it('rejects non-positive or fractional counts', () => {
    expect(buildQuickSetRows('bench', 'Bench Press', 0, 8)).toBeNull()
    expect(buildQuickSetRows('bench', 'Bench Press', 3.5, 8)).toBeNull()
    expect(buildQuickSetRows('bench', 'Bench Press', 3, -1)).toBeNull()
  })
})

describe('blocksToNewSets', () => {
  it('preserves optional effort and note context for every set', () => {
    const rows = [{
      exerciseId: 'bench',
      exerciseName: 'Bench Press',
      reps: 8,
      weightKg: 60,
      rpe: 8.5,
      note: 'Paused on the chest.',
      isWarmup: false
    }]

    expect(blocksToNewSets([{ exerciseId: 'bench', sets: rows }])).toEqual([{
      exercise_id: 'bench',
      reps: 8,
      weight_kg: 60,
      rpe: 8.5,
      note: 'Paused on the chest.',
      is_warmup: false
    }])
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

  it('body-parts-only log beats the template fallback', () => {
    const s = session({ sets: [], template_id: 'tmpl-1', body_parts: ['core', 'legs'] })
    expect(summarizeSession(s, 'Legs')).toBe('Body parts — Legs · Core')
  })

  it('sets beat a stale body-parts declaration', () => {
    const sets = [set({ exercise_id: 'squat', position: 0, reps: 8, weight_kg: 60 })]
    const s = session({ sets, body_parts: ['chest'] })
    expect(summarizeSession(s, null)).toBe('1 exercise · 1 set · 480 kg')
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
          note: null,
          rest_after_s: null
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
          note: null,
          rest_after_s: null
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
          note: null,
          rest_after_s: null
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
          note: null,
          rest_after_s: null
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

describe('uniformPrefillDose', () => {
  it('restores a template prescription into the quick Sets and Reps controls', () => {
    expect(uniformPrefillDose([
      { exerciseId: 'calf', exerciseName: 'Calf raises', reps: 15, weightKg: null, isWarmup: false },
      { exerciseId: 'calf', exerciseName: 'Calf raises', reps: 15, weightKg: null, isWarmup: false },
      { exerciseId: 'calf', exerciseName: 'Calf raises', reps: 15, weightKg: null, isWarmup: false }
    ])).toEqual({ sets: '3', reps: '15' })
  })

  it('does not claim one prescription for mixed or blank reps', () => {
    expect(uniformPrefillDose([
      { exerciseId: 'x', exerciseName: 'X', reps: 8, weightKg: null, isWarmup: false },
      { exerciseId: 'x', exerciseName: 'X', reps: 10, weightKg: null, isWarmup: false }
    ])).toEqual({ sets: '', reps: '' })
  })
})

describe('prefillFromTemplates', () => {
  it('keeps each selected template together in the order it was added', () => {
    const legs = template({
      id: 'legs',
      items: [
        {
          id: 'legs-squat',
          template_id: 'legs',
          exercise_id: 'squat',
          exercise_name: 'Squat',
          position: 0,
          target_sets: 2,
          target_reps: 8,
          target_weight_kg: 60,
          note: null,
          rest_after_s: null
        }
      ]
    })
    const core = template({
      id: 'core',
      items: [
        {
          id: 'core-plank',
          template_id: 'core',
          exercise_id: 'plank',
          exercise_name: 'Plank',
          position: 0,
          target_sets: 1,
          target_reps: 45,
          target_weight_kg: null,
          note: null,
          rest_after_s: null
        }
      ]
    })

    expect(prefillFromTemplates([legs, core]).map((row) => row.exerciseId)).toEqual([
      'squat',
      'squat',
      'plank'
    ])
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

// ── sessionBodyParts ───────────────────────────────────────────────────────────

describe('sessionBodyParts', () => {
  const catalog = new Map([
    ['squat', exercise({ id: 'squat', body_part: 'legs' })],
    ['bench', exercise({ id: 'bench', body_part: 'chest' })],
    ['custom', exercise({ id: 'custom', body_part: null })]
  ])

  it('derives from set exercises in GYM_BODY_PARTS order, deduped', () => {
    const sets = [
      set({ exercise_id: 'squat', position: 0 }),
      set({ exercise_id: 'bench', position: 1 }),
      set({ exercise_id: 'squat', position: 2 })
    ]
    expect(sessionBodyParts(session({ sets }), catalog)).toEqual(['chest', 'legs'])
  })

  it('ignores customs without a body part and unknown exercise ids', () => {
    const sets = [
      set({ exercise_id: 'custom', position: 0 }),
      set({ exercise_id: 'not-in-catalog', position: 1 })
    ]
    expect(sessionBodyParts(session({ sets }), catalog)).toEqual([])
  })

  it('falls back to the declared list when there are no sets', () => {
    const s = session({ body_parts: ['core', 'legs'] })
    expect(sessionBodyParts(s, catalog)).toEqual(['legs', 'core'])
  })

  it('sets override the declared list', () => {
    const sets = [set({ exercise_id: 'squat', position: 0 })]
    const s = session({ sets, body_parts: ['chest'] })
    expect(sessionBodyParts(s, catalog)).toEqual(['legs'])
  })
})

// ── lastPerformance / formatSetLine ───────────────────────────────────────────

describe('lastPerformance', () => {
  const older = session({
    id: 'old',
    performed_at: '2026-07-01T10:00:00.000Z',
    sets: [set({ exercise_id: 'squat', position: 0, reps: 8, weight_kg: 70 })]
  })
  const newer = session({
    id: 'new',
    performed_at: '2026-07-08T10:00:00.000Z',
    sets: [
      set({ exercise_id: 'squat', position: 1, reps: 8, weight_kg: 80 }),
      set({ exercise_id: 'squat', position: 0, reps: 10, weight_kg: 40, is_warmup: true })
    ]
  })

  it('returns working sets from the most recent session containing the exercise', () => {
    const last = lastPerformance('squat', [older, newer], null)
    expect(last?.performedAt).toBe('2026-07-08T10:00:00.000Z')
    expect(last?.sets.map((s) => s.weight_kg)).toEqual([80])
  })

  it('skips the session being edited', () => {
    const last = lastPerformance('squat', [older, newer], 'new')
    expect(last?.performedAt).toBe('2026-07-01T10:00:00.000Z')
  })

  it('skips warmup-only sessions and returns null when never logged', () => {
    const warmupOnly = session({
      id: 'w',
      sets: [set({ exercise_id: 'bench', position: 0, reps: 10, weight_kg: 20, is_warmup: true })]
    })
    expect(lastPerformance('bench', [warmupOnly], null)).toBeNull()
    expect(lastPerformance('nope', [older, newer], null)).toBeNull()
  })
})

describe('formatSetLine', () => {
  it('renders reps×kg per set, bodyweight when weight is null', () => {
    const sets = [
      set({ exercise_id: 'squat', position: 0, reps: 8, weight_kg: 77.5 }),
      set({ exercise_id: 'squat', position: 1, reps: 10, weight_kg: null })
    ]
    expect(formatSetLine(sets)).toBe('8×77.5 · 10×bw')
  })
})

// ── exerciseUsage ──────────────────────────────────────────────────────────────

describe('exerciseUsage', () => {
  it('counts sessions per exercise (not sets) and keeps the newest date', () => {
    const a = session({
      id: 'a',
      performed_at: '2026-07-01T10:00:00.000Z',
      sets: [
        set({ exercise_id: 'squat', position: 0 }),
        set({ exercise_id: 'squat', position: 1 })
      ]
    })
    const b = session({
      id: 'b',
      performed_at: '2026-07-08T10:00:00.000Z',
      sets: [set({ exercise_id: 'squat', position: 0 })]
    })
    const usage = exerciseUsage([b, a])
    expect(usage.get('squat')).toEqual({ count: 2, lastIso: '2026-07-08T10:00:00.000Z' })
  })

  it('is empty for set-less sessions', () => {
    expect(exerciseUsage([session({ body_parts: ['legs'] })]).size).toBe(0)
  })
})

// ── muscleSetVolume ────────────────────────────────────────────────────────────

describe('muscleSetVolume', () => {
  const catalog = new Map([
    [
      'bench',
      exercise({
        id: 'bench',
        primary_muscles: ['chest'],
        secondary_muscles: ['triceps', 'front delts']
      })
    ],
    ['curl', exercise({ id: 'curl', primary_muscles: ['biceps'], secondary_muscles: ['forearms'] })],
    ['mystery', exercise({ id: 'mystery' })] // custom without muscle metadata
  ])

  it('credits primaries 1.0 and secondaries 0.5 per working set', () => {
    const s = session({
      sets: [
        set({ exercise_id: 'bench', position: 0, reps: 8 }),
        set({ exercise_id: 'bench', position: 1, reps: 8 })
      ]
    })
    expect(muscleSetVolume([s], catalog)).toEqual([
      { muscle: 'chest', sets: 2 },
      { muscle: 'front delts', sets: 1 },
      { muscle: 'triceps', sets: 1 }
    ])
  })

  it('excludes warmups and unknown/metadata-less exercises', () => {
    const s = session({
      sets: [
        set({ exercise_id: 'bench', position: 0, is_warmup: true }),
        set({ exercise_id: 'mystery', position: 1, reps: 10 }),
        set({ exercise_id: 'not-in-catalog', position: 2, reps: 10 }),
        set({ exercise_id: 'curl', position: 3, reps: 10 })
      ]
    })
    expect(muscleSetVolume([s], catalog)).toEqual([
      { muscle: 'biceps', sets: 1 },
      { muscle: 'forearms', sets: 0.5 }
    ])
  })

  it('sorts by volume desc then name, aggregating across sessions', () => {
    const a = session({ id: 'a', sets: [set({ exercise_id: 'curl', position: 0 })] })
    const b = session({ id: 'b', sets: [set({ exercise_id: 'curl', position: 0 })] })
    const rows = muscleSetVolume([a, b], catalog)
    expect(rows[0]).toEqual({ muscle: 'biceps', sets: 2 })
    expect(rows[1]).toEqual({ muscle: 'forearms', sets: 1 })
  })

  it('returns empty for no sessions', () => {
    expect(muscleSetVolume([], catalog)).toEqual([])
  })
})

// ── formatRest ───────────────────────────────────────────────────────────────

describe('formatRest', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatRest(45)).toBe('45s')
    expect(formatRest(0)).toBe('0s')
    expect(formatRest(59)).toBe('59s')
  })

  it('formats minute-and-above durations as m:ss', () => {
    expect(formatRest(60)).toBe('1:00')
    expect(formatRest(90)).toBe('1:30')
    expect(formatRest(125)).toBe('2:05')
  })
})
