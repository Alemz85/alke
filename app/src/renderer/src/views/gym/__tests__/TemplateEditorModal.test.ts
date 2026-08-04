import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Exercise, GymTemplate, GymTemplateItem } from '@shared/types'
import {
  itemsFromTemplate,
  moveTemplateItem,
  moveTemplateItemTo,
  type ItemRow
} from '../TemplateEditorModal'

function makeExercise(overrides: Partial<Exercise> = {}): Exercise {
  return {
    id: 'exercise-1',
    name: 'Barbell Squat',
    aliases: [],
    body_part: 'legs',
    primary_muscles: [],
    secondary_muscles: [],
    equipment: null,
    mechanics: null,
    movement_pattern: null,
    source: 'catalog',
    created_at: null,
    ...overrides
  }
}

function makeTemplateItem(overrides: Partial<GymTemplateItem> = {}): GymTemplateItem {
  return {
    id: 'item-1',
    template_id: 'template-1',
    exercise_id: 'exercise-1',
    exercise_name: 'Barbell Squat',
    position: 0,
    target_sets: 3,
    target_reps: 8,
    target_weight_kg: null,
    rest_after_s: null,
    note: null,
    ...overrides
  }
}

function makeTemplate(items: GymTemplateItem[]): GymTemplate {
  return {
    id: 'template-1',
    name: 'Legs Day',
    notes: null,
    archived: false,
    default_rest_s: null,
    family_id: 'family-1',
    version: 1,
    is_current: true,
    items,
    runs: [],
    created_at: null,
    updated_at: null
  }
}

describe('itemsFromTemplate', () => {
  it('autoselects the body part from the catalog by exercise_id, e.g. an AI-generated template', () => {
    // An AI-generated template references a catalog exercise_id directly
    // (never touches ExercisePicker), so bodyPartFilter must resolve from the
    // catalog lookup, not from a picker-only interaction.
    const template = makeTemplate([makeTemplateItem({ exercise_id: 'exercise-1' })])
    const exercisesById = new Map([['exercise-1', makeExercise({ id: 'exercise-1', body_part: 'legs' })]])

    const rows = itemsFromTemplate(template, exercisesById)

    expect(rows).toHaveLength(1)
    expect(rows[0].bodyPartFilter).toBe('legs')
  })

  it('leaves the filter at "Any" (null) when the catalog exercise has no body part', () => {
    const template = makeTemplate([makeTemplateItem({ exercise_id: 'exercise-2' })])
    const exercisesById = new Map([['exercise-2', makeExercise({ id: 'exercise-2', body_part: null })]])

    const rows = itemsFromTemplate(template, exercisesById)

    expect(rows[0].bodyPartFilter).toBeNull()
  })

  it('leaves the filter at "Any" (null) when the catalog has not loaded yet', () => {
    const template = makeTemplate([makeTemplateItem({ exercise_id: 'exercise-1' })])

    const rows = itemsFromTemplate(template, new Map())

    expect(rows[0].bodyPartFilter).toBeNull()
  })

  it('resolves each item independently by its own exercise_id', () => {
    const template = makeTemplate([
      makeTemplateItem({ id: 'item-1', exercise_id: 'exercise-1', position: 0 }),
      makeTemplateItem({ id: 'item-2', exercise_id: 'exercise-2', exercise_name: 'Bench Press', position: 1 })
    ])
    const exercisesById = new Map([
      ['exercise-1', makeExercise({ id: 'exercise-1', body_part: 'legs' })],
      ['exercise-2', makeExercise({ id: 'exercise-2', name: 'Bench Press', body_part: 'chest' })]
    ])

    const rows = itemsFromTemplate(template, exercisesById)

    expect(rows[0].bodyPartFilter).toBe('legs')
    expect(rows[1].bodyPartFilter).toBe('chest')
  })
})

// ── item reordering inside the editor ──────────────────────────────────────
// Order is the array order: the main process stamps `position` from the index
// (db.ts insertTemplateItems), so these two pure moves ARE the persisted order.

function rows(...names: string[]): ItemRow[] {
  return names.map((name) => ({
    key: name,
    exerciseId: `ex-${name}`,
    exerciseName: name,
    bodyPartFilter: null,
    targetSets: '',
    targetReps: '',
    targetWeightKg: '',
    restAfterSeconds: '',
    note: ''
  }))
}

const keys = (items: ItemRow[]): string[] => items.map((it) => it.key)

describe('moveTemplateItem', () => {
  it('swaps a row with the one above it', () => {
    expect(keys(moveTemplateItem(rows('a', 'b', 'c'), 'b', 'up'))).toEqual(['b', 'a', 'c'])
  })

  it('swaps a row with the one below it', () => {
    expect(keys(moveTemplateItem(rows('a', 'b', 'c'), 'b', 'down'))).toEqual(['a', 'c', 'b'])
  })

  it('clamps at both ends, returning the same array reference (no re-render)', () => {
    const items = rows('a', 'b', 'c')
    expect(moveTemplateItem(items, 'a', 'up')).toBe(items)
    expect(moveTemplateItem(items, 'c', 'down')).toBe(items)
  })

  it('is a no-op for an unknown key', () => {
    const items = rows('a', 'b')
    expect(moveTemplateItem(items, 'zzz', 'down')).toBe(items)
  })

  it('carries the row payload, not just its key', () => {
    const moved = moveTemplateItem(rows('a', 'b'), 'b', 'up')
    expect(moved[0].exerciseName).toBe('b')
    expect(moved[0].exerciseId).toBe('ex-b')
  })
})

describe('moveTemplateItemTo (drag-and-drop landing)', () => {
  it('moves a row DOWN onto its next neighbour — the case an insert-before rule gets wrong', () => {
    // useCardOrder's moveBefore would remove 'a' then re-insert it in front of
    // 'b', i.e. no visible change. Taking the target's slot actually moves it.
    expect(keys(moveTemplateItemTo(rows('a', 'b', 'c'), 'a', 'b'))).toEqual(['b', 'a', 'c'])
  })

  it('moves a row UP onto an earlier target', () => {
    expect(keys(moveTemplateItemTo(rows('a', 'b', 'c'), 'c', 'a'))).toEqual(['c', 'a', 'b'])
  })

  it('shifts every row between source and target by one', () => {
    expect(keys(moveTemplateItemTo(rows('a', 'b', 'c', 'd'), 'a', 'd'))).toEqual(['b', 'c', 'd', 'a'])
  })

  it('dropping a row on itself, or on a missing key, is a no-op by reference', () => {
    const items = rows('a', 'b', 'c')
    expect(moveTemplateItemTo(items, 'b', 'b')).toBe(items)
    expect(moveTemplateItemTo(items, 'b', 'zzz')).toBe(items)
    expect(moveTemplateItemTo(items, 'zzz', 'b')).toBe(items)
  })
})

describe('template editor item rows are reorderable', () => {
  const source = readFileSync(new URL('../TemplateEditorModal.tsx', import.meta.url), 'utf8')

  it('renders each row with drag wiring plus an up/down keyboard fallback', () => {
    expect(source).toContain('onDragStart')
    expect(source).toContain('onDragOver')
    expect(source).toContain('onDrop')
    expect(source).toContain('aria-label="Move exercise up"')
    expect(source).toContain('aria-label="Move exercise down"')
  })

  it('disables the step buttons at the list edges', () => {
    expect(source).toContain('isFirst: index === 0')
    expect(source).toContain('isLast: index === items.length - 1')
    expect(source).toContain('disableUp={reorder.isFirst}')
    expect(source).toContain('disableDown={reorder.isLast}')
  })

  it('uses the always-visible inline handle variant, not the hover-revealed card one', () => {
    expect(source).toContain('reorder-handle--inline')
  })

  it('drives both gestures through the pure move helpers', () => {
    expect(source).toContain('moveTemplateItem(prev, key, direction)')
    expect(source).toContain('moveTemplateItemTo(prev, key, targetKey)')
  })
})
