import { describe, expect, it } from 'vitest'
import type { Exercise, Injury, RecoveryPlanItem } from '@shared/types'
import { buildRecoveryLogTemplate, recoveryOverviewPreview } from '../recoveryLogTemplates'

const injury: Injury = {
  id: 'injury-1',
  name: 'Left calf',
  body_area: 'calf',
  status: 'recovering',
  severity: 'mild',
  started_at: '2026-06-01',
  plan_started_at: '2026-06-08',
  resolved_at: null,
  summary: null,
  recovery_plan: 'Build calf capacity gradually.',
  created_at: null,
  updated_at: null
}

function item(partial: Partial<RecoveryPlanItem> & Pick<RecoveryPlanItem, 'id' | 'name' | 'kind'>): RecoveryPlanItem {
  return {
    injury_id: injury.id,
    weekly_target: null,
    green_min: null,
    yellow_min: null,
    phases: null,
    start_week: 1,
    target_sets: null,
    target_reps: null,
    steps: null,
    note: null,
    active: true,
    exercise_id: null,
    created_at: null,
    updated_at: null,
    ...partial
  }
}

const calfRaise: Exercise = {
  id: 'exercise-1',
  name: 'Standing Calf Raise',
  aliases: [],
  body_part: 'legs',
  primary_muscles: ['calves'],
  secondary_muscles: [],
  equipment: 'machine',
  mechanics: 'isolation',
  movement_pattern: null,
  source: 'catalog',
  created_at: null
}

describe('buildRecoveryLogTemplate', () => {
  it('turns linked active rehab exercises into blank logging rows without inventing a dose', () => {
    const template = buildRecoveryLogTemplate(
      injury,
      [
        item({
          id: 'linked',
          name: 'Calf raises',
          kind: 'exercise',
          weekly_target: 3,
          exercise_id: calfRaise.id,
          note: 'Controlled tempo'
        }),
        item({ id: 'unlinked', name: 'Balance drill', kind: 'exercise' }),
        item({ id: 'constraint', name: 'No sprinting', kind: 'constraint' }),
        item({ id: 'inactive', name: 'Old drill', kind: 'exercise', active: false })
      ],
      new Map([[calfRaise.id, calfRaise]])
    )

    expect(template.id).toBe('recovery:injury-1')
    expect(template.planStartedAt).toBe('2026-06-08')
    expect(template.name).toBe('Left calf recovery')
    expect(template.rows).toEqual([
      {
        exerciseId: calfRaise.id,
        exerciseName: calfRaise.name,
        reps: null,
        weightKg: null,
        isWarmup: false
      }
    ])
    expect(template.exerciseItems).toHaveLength(2)
    expect(template.guidance.map((entry) => entry.name)).toEqual(['No sprinting'])
    expect(template.unlinkedExerciseCount).toBe(1)
  })

  it('expands an AI-authored prescription into ready-to-log set rows', () => {
    const template = buildRecoveryLogTemplate(
      injury,
      [item({
        id: 'prescribed',
        name: 'Calf raises',
        kind: 'exercise',
        exercise_id: calfRaise.id,
        target_sets: 3,
        target_reps: 15
      })],
      new Map([[calfRaise.id, calfRaise]])
    )

    expect(template.rows).toHaveLength(3)
    expect(template.rows.every((row) => row.reps === 15)).toBe(true)
  })

  // agent_log #26: with no duration column on recovery_plan_items, a timed hold
  // stores its real dose in `steps` and parks a placeholder 1 in target_reps.
  // Prefilling from the column turned a 45-second wall sit into a 1-rep set.
  it('prefills a timed hold from its step, not the placeholder rep count', () => {
    const template = buildRecoveryLogTemplate(
      injury,
      [item({
        id: 'hold',
        name: 'Wall sit',
        kind: 'exercise',
        exercise_id: calfRaise.id,
        target_sets: 3,
        target_reps: 1,
        steps: [{
          name: 'Wall sit hold',
          sets: 3,
          reps: null,
          duration_seconds: 45,
          distance_m: null,
          per_side: false,
          note: null
        }]
      })],
      new Map([[calfRaise.id, calfRaise]])
    )

    expect(template.rows).toHaveLength(3)
    expect(template.rows.every((row) => row.durationS === 45 && row.reps === null)).toBe(true)
  })

  it('leaves a multi-movement routine blank rather than collapsing it to one dose', () => {
    const template = buildRecoveryLogTemplate(
      injury,
      [item({
        id: 'routine',
        name: 'Mobility routine',
        kind: 'exercise',
        exercise_id: calfRaise.id,
        target_sets: 2,
        target_reps: 1,
        steps: [
          { name: 'Calf stretch', sets: 2, reps: null, duration_seconds: 30, distance_m: null, per_side: true, note: null },
          { name: 'Ankle circles', sets: null, reps: 10, duration_seconds: null, distance_m: null, per_side: true, note: null }
        ]
      })],
      new Map([[calfRaise.id, calfRaise]])
    )

    expect(template.rows).toHaveLength(2)
    expect(template.rows.every((row) => row.reps === null && row.durationS == null)).toBe(true)
  })

  // A distance step has no measure a set row can carry, so the row stays blank
  // instead of inheriting target_reps=1 and asserting a one-rep heel walk.
  it('leaves a distance-only step blank rather than reading the placeholder', () => {
    const template = buildRecoveryLogTemplate(
      injury,
      [item({
        id: 'distance',
        name: 'Heel walks',
        kind: 'exercise',
        exercise_id: calfRaise.id,
        target_sets: 2,
        target_reps: 1,
        steps: [{
          name: 'Heel walks',
          sets: 2,
          reps: null,
          duration_seconds: null,
          distance_m: 20,
          per_side: null,
          note: null
        }]
      })],
      new Map([[calfRaise.id, calfRaise]])
    )

    expect(template.rows).toHaveLength(2)
    expect(template.rows.every((row) => row.reps === null && row.durationS == null)).toBe(true)
  })
})

describe('recoveryOverviewPreview', () => {
  it('returns only a bounded overview excerpt with an explicit ellipsis', () => {
    const text = 'Rebuild tissue tolerance progressively with mobility and easy walking first, then strengthening and loading once symptoms remain settled.'
    const preview = recoveryOverviewPreview(text, 72)
    expect(preview).toBe('Rebuild tissue tolerance progressively with mobility and easy walking…')
    expect(preview.length).toBeLessThanOrEqual(72)
  })

  it('leaves a short overview untouched and normalizes whitespace', () => {
    expect(recoveryOverviewPreview('  Short\n overview.  ', 72)).toBe('Short overview.')
  })
})
