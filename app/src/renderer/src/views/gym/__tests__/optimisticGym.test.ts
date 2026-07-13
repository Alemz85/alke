import { describe, expect, it } from 'vitest'
import type { Exercise, NewGymSession, NewGymTemplate } from '@shared/types'
import {
  applyOptimisticSessionPatch,
  applyOptimisticTemplatePatch,
  makeOptimisticSession,
  makeOptimisticTemplate
} from '../../../lib/optimisticGym'

const exercises: Exercise[] = [
  {
    id: 'exercise-1',
    name: 'Incline Bench Press',
    aliases: [],
    body_part: 'chest',
    primary_muscles: ['upper chest'],
    secondary_muscles: [],
    equipment: 'barbell',
    mechanics: null,
    movement_pattern: null,
    source: 'catalog',
    created_at: null
  }
]

describe('optimistic Gym records', () => {
  it('builds a render-complete temporary template', () => {
    const input: NewGymTemplate = {
      name: 'Upper A',
      notes: null,
      default_rest_s: 90,
      items: [{
        exercise_id: 'exercise-1',
        target_sets: 3,
        target_reps: 8,
        target_weight_kg: 60,
        rest_after_s: 120,
        note: null
      }]
    }
    const result = makeOptimisticTemplate(input, exercises, 'optimistic:template', '2026-07-13T12:00:00Z')

    expect(result.id).toBe('optimistic:template')
    expect(result.default_rest_s).toBe(90)
    expect(result.items[0]).toMatchObject({
      exercise_name: 'Incline Bench Press',
      target_sets: 3,
      rest_after_s: 120
    })
  })

  it('applies a template patch including replacement items', () => {
    const initial = makeOptimisticTemplate(
      { name: 'Upper', notes: null, items: [{ exercise_id: 'exercise-1', target_sets: 3, target_reps: 8, target_weight_kg: null }] },
      exercises,
      'template-1',
      '2026-07-13T12:00:00Z'
    )
    const result = applyOptimisticTemplatePatch(initial, {
      name: 'Upper revised',
      items: [{ exercise_id: 'exercise-1', target_sets: 4, target_reps: 6, target_weight_kg: 65 }]
    }, exercises)

    expect(result.name).toBe('Upper revised')
    expect(result.items[0]).toMatchObject({ target_sets: 4, target_reps: 6, target_weight_kg: 65 })
  })

  it('builds and patches a render-complete temporary session', () => {
    const input: NewGymSession = {
      performed_at: '2026-07-13T12:00:00Z',
      title: 'Upper',
      template_ids: [],
      sets: [{ exercise_id: 'exercise-1', reps: 8, weight_kg: 60, is_warmup: false }]
    }
    const initial = makeOptimisticSession(input, exercises, 'optimistic:session', input.performed_at as string)
    const result = applyOptimisticSessionPatch(initial, {
      title: 'Upper revised',
      sets: [
        { exercise_id: 'exercise-1', reps: 8, weight_kg: 62.5 },
        { exercise_id: 'exercise-1', reps: 8, weight_kg: 62.5 }
      ]
    }, exercises)

    expect(initial.sets[0].exercise_name).toBe('Incline Bench Press')
    expect(result.title).toBe('Upper revised')
    expect(result.sets).toHaveLength(2)
    expect(result.sets[1].session_id).toBe('optimistic:session')
  })
})
