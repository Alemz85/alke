import { describe, expect, it } from 'vitest'
import type { Exercise, GymTemplate, GymTemplateItem } from '@shared/types'
import { itemsFromTemplate } from '../TemplateEditorModal'

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
