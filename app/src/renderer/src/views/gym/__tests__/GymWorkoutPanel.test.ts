import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Exercise, GymSession } from '@shared/types'
import { ExerciseDisclosure, GymWorkoutPanel } from '../GymWorkoutPanel'

const source = readFileSync(new URL('../GymWorkoutPanel.tsx', import.meta.url), 'utf8')

describe('GymWorkoutPanel read view', () => {
  it('keeps repeated body-part runs and disclosure ids distinct in logged order', () => {
    expect(source).toContain('exerciseGroups.map((group, groupIndex) =>')
    expect(source).toContain('`${groupIndex}-${group.bodyPart}-${block.exerciseId}-${blockIndex}`')
  })

  it('exposes distinct hierarchy hooks for the workout header, exercises, and notes', () => {
    const exercise: Exercise = {
      id: 'incline-bench',
      name: 'Incline Bench Press',
      aliases: [],
      body_part: 'chest',
      primary_muscles: ['upper chest'],
      secondary_muscles: ['triceps'],
      equipment: 'barbell',
      mechanics: 'compound',
      movement_pattern: 'push',
      source: 'catalog',
      created_at: null
    }
    const session: GymSession = {
      id: 'session-1',
      workout_id: null,
      template_id: null,
      template_ids: [],
      performed_at: '2026-07-12T12:00:00Z',
      title: 'Upper B',
      notes: 'Controlled tempo throughout.',
      source: 'mock',
      body_parts: null,
      sets: [1, 2, 3].map((id) => ({
        id,
        session_id: 'session-1',
        exercise_id: exercise.id,
        exercise_name: exercise.name,
        position: id - 1,
        reps: 8,
        duration_s: null,
        weight_kg: 60,
        rpe: id === 2 ? 8.5 : null,
        is_warmup: false,
        is_eccentric: false,
        is_unilateral: false,
        note: id === 2 ? 'Last rep slowed.' : null
      })),
      created_at: null,
      updated_at: null
    }

    const markup = renderToStaticMarkup(
      createElement(GymWorkoutPanel, {
        item: {
          key: session.id,
          workout: null,
          session,
          dateIso: session.performed_at,
          logged: true
        },
        templates: [],
        recoveryTemplates: [],
        sessions: [session],
        exercisesById: new Map([[exercise.id, exercise]]),
        templateNameById: new Map(),
        timezone: 'Europe/Berlin',
        onClose: () => undefined
      })
    )

    expect(markup).toContain('gym-log-view-eyebrow')
    expect(markup).toContain('gym-log-edit-button')
    expect(markup).toContain('gym-log-view-section-label')
    expect(markup).toContain('gym-log-notes-label')

    const expandedMarkup = renderToStaticMarkup(
      createElement(ExerciseDisclosure, {
        block: {
          exerciseId: exercise.id,
          exerciseName: exercise.name,
          sets: session.sets
        },
        blockKey: 'incline-bench',
        muscleGroup: 'chest',
        expanded: true,
        onToggle: () => undefined
      })
    )
    expect(expandedMarkup).toContain('RPE')
    expect(expandedMarkup).toContain('8.5')
    expect(expandedMarkup).toContain('Last rep slowed.')
  })
})
