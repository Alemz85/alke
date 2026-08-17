import { describe, expect, it } from 'vitest'
import {
  METRIC_DAYS_DEFAULT,
  METRIC_DAYS_MAX,
  METRIC_DAYS_MIN,
  parseChatBlock
} from '../chatBlockParse'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

describe('parseChatBlock — happy paths', () => {
  it('parses a minimal alke:workout block', () => {
    const result = parseChatBlock('alke:workout', JSON.stringify({ workout_id: UUID_A }), false)
    expect(result).toEqual({
      status: 'ok',
      block: { kind: 'workout', payload: { workout_id: UUID_A, label: undefined } }
    })
  })

  it('parses an alke:workout block with a label', () => {
    const result = parseChatBlock(
      'alke:workout',
      JSON.stringify({ workout_id: UUID_A, label: 'Tuesday long run' }),
      false
    )
    expect(result).toEqual({
      status: 'ok',
      block: { kind: 'workout', payload: { workout_id: UUID_A, label: 'Tuesday long run' } }
    })
  })

  it('parses an alke:metric block, defaulting days when absent', () => {
    const result = parseChatBlock('alke:metric', JSON.stringify({ metric: 'resting_hr' }), false)
    expect(result).toEqual({
      status: 'ok',
      block: { kind: 'metric', payload: { metric: 'resting_hr', days: METRIC_DAYS_DEFAULT, label: undefined } }
    })
  })

  it('parses an alke:template "apply" block with reps and secs exercises', () => {
    const body = {
      id: 'push-day',
      action: 'apply',
      document: {
        templates: [
          {
            name: 'Push Day',
            notes: 'Controlled tempo.',
            default_rest_s: 90,
            exercises: [
              { exercise: 'Bench Press', sets: 4, reps: 8, kg: 60 },
              { exercise: 'Plank', sets: 3, secs: 45 }
            ]
          }
        ]
      }
    }
    const result = parseChatBlock('alke:template', JSON.stringify(body), false)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok' || result.block.kind !== 'template') throw new Error('expected template block')
    expect(result.block.payload.id).toBe('push-day')
    expect(result.block.payload.action).toBe('apply')
    expect(result.block.payload.document.templates[0].exercises).toHaveLength(2)
    expect(result.block.payload.document.templates[0].exercises[0].reps).toBe(8)
    expect(result.block.payload.document.templates[0].exercises[1].secs).toBe(45)
  })

  it('tolerates extra/unknown keys on exercises (catalog attrs, "create" flags)', () => {
    const body = {
      id: 'push-day',
      action: 'apply',
      document: {
        templates: [
          {
            name: 'Push Day',
            exercises: [
              { exercise: 'Bench Press', sets: 4, reps: 8, create: true, body_part: 'chest' }
            ]
          }
        ]
      }
    }
    const result = parseChatBlock('alke:template', JSON.stringify(body), false)
    expect(result.status).toBe('ok')
  })

  it('parses an alke:template "create-version" block with a base_template_id', () => {
    const body = {
      id: 'push-day-v2',
      action: 'create-version',
      base_template_id: UUID_A,
      document: {
        templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench Press', sets: 4, reps: 8 }] }]
      }
    }
    const result = parseChatBlock('alke:template', JSON.stringify(body), false)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok' || result.block.kind !== 'template') throw new Error('expected template block')
    expect(result.block.payload.base_template_id).toBe(UUID_A)
  })

  it('parses an alke:recovery-plan block', () => {
    const body = {
      id: 'rehab-taper',
      injury_id: UUID_B,
      document: {
        approach: 'Progressive loading with a hard ceiling on downhill volume.',
        items: [
          { name: 'Single-leg squat', kind: 'exercise', weekly_target: 3, green_min: 3, yellow_min: 2, target_sets: 3, target_reps: 12 },
          { name: 'Downhill running', kind: 'constraint', note: 'Avoid until week 6.' }
        ]
      }
    }
    const result = parseChatBlock('alke:recovery-plan', JSON.stringify(body), false)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok' || result.block.kind !== 'recovery-plan') throw new Error('expected recovery-plan block')
    expect(result.block.payload.injury_id).toBe(UUID_B)
    expect(result.block.payload.document.items).toHaveLength(2)
  })

  it('tolerates extra keys on recovery-plan items', () => {
    const body = {
      id: 'rehab-taper',
      injury_id: UUID_B,
      document: {
        approach: 'Progressive loading.',
        items: [{ name: 'Single-leg squat', kind: 'exercise', weekly_target: 3, some_future_field: 'x' }]
      }
    }
    const result = parseChatBlock('alke:recovery-plan', JSON.stringify(body), false)
    expect(result.status).toBe('ok')
  })
})

describe('parseChatBlock — unknown language passthrough', () => {
  it('returns not-a-block for a plain code fence language', () => {
    expect(parseChatBlock('typescript', 'const x = 1', false)).toEqual({ status: 'not-a-block' })
  })

  it('returns not-a-block for an empty info string', () => {
    expect(parseChatBlock('', '{}', false)).toEqual({ status: 'not-a-block' })
  })

  it('returns not-a-block for a near-miss language (not an exact match)', () => {
    expect(parseChatBlock('alke:workouts', JSON.stringify({ workout_id: UUID_A }), false)).toEqual({
      status: 'not-a-block'
    })
  })
})

describe('parseChatBlock — invalid JSON', () => {
  it('marks unparseable JSON as invalid when not streaming', () => {
    expect(parseChatBlock('alke:workout', '{ not json', false)).toEqual({ status: 'invalid' })
  })

  it('marks unparseable JSON as pending when streaming', () => {
    expect(parseChatBlock('alke:workout', '{ "workout_id": "11', true)).toEqual({ status: 'pending' })
  })
})

describe('parseChatBlock — streaming-vs-final fallback signal', () => {
  it('a schema violation is pending while streaming, invalid once final', () => {
    const badBody = JSON.stringify({ workout_id: 'not-a-uuid' })
    expect(parseChatBlock('alke:workout', badBody, true)).toEqual({ status: 'pending' })
    expect(parseChatBlock('alke:workout', badBody, false)).toEqual({ status: 'invalid' })
  })

  it('a truncated-but-syntactically-valid partial object is pending while streaming', () => {
    // The model has only emitted the opening key so far — valid JSON, wrong shape.
    const partial = JSON.stringify({})
    expect(parseChatBlock('alke:metric', partial, true)).toEqual({ status: 'pending' })
    expect(parseChatBlock('alke:metric', partial, false)).toEqual({ status: 'invalid' })
  })
})

describe('parseChatBlock — uuid rejection', () => {
  it('rejects a non-uuid workout_id', () => {
    expect(parseChatBlock('alke:workout', JSON.stringify({ workout_id: 'abc123' }), false)).toEqual({
      status: 'invalid'
    })
  })

  it('rejects a missing base_template_id for create-version', () => {
    const body = {
      id: 'push-day-v2',
      action: 'create-version',
      document: { templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }] }] }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects a non-uuid injury_id on a recovery-plan block', () => {
    const body = {
      id: 'rehab-taper',
      injury_id: 'not-a-uuid',
      document: { approach: 'x', items: [{ name: 'Rest', kind: 'habit' }] }
    }
    expect(parseChatBlock('alke:recovery-plan', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })
})

describe('parseChatBlock — metric days clamping', () => {
  it('clamps days below the minimum up to METRIC_DAYS_MIN', () => {
    const result = parseChatBlock('alke:metric', JSON.stringify({ metric: 'steps', days: 3 }), false)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok' || result.block.kind !== 'metric') throw new Error('expected metric block')
    expect(result.block.payload.days).toBe(METRIC_DAYS_MIN)
  })

  it('clamps days above the maximum down to METRIC_DAYS_MAX', () => {
    const result = parseChatBlock('alke:metric', JSON.stringify({ metric: 'steps', days: 10000 }), false)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok' || result.block.kind !== 'metric') throw new Error('expected metric block')
    expect(result.block.payload.days).toBe(METRIC_DAYS_MAX)
  })

  it('rejects a non-integer days value outright rather than clamping it', () => {
    const result = parseChatBlock('alke:metric', JSON.stringify({ metric: 'steps', days: 30.5 }), false)
    expect(result).toEqual({ status: 'invalid' })
  })
})

describe('parseChatBlock — reps/secs xor', () => {
  it('rejects an exercise carrying both reps and secs', () => {
    const body = {
      id: 'push-day',
      action: 'apply',
      document: {
        templates: [
          { name: 'Push Day', exercises: [{ exercise: 'Plank', sets: 3, reps: 10, secs: 45 }] }
        ]
      }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('accepts an exercise with neither reps nor secs (open-ended dose)', () => {
    const body = {
      id: 'push-day',
      action: 'apply',
      document: {
        templates: [{ name: 'Push Day', exercises: [{ exercise: 'Farmer carry', sets: 3 }] }]
      }
    }
    const result = parseChatBlock('alke:template', JSON.stringify(body), false)
    expect(result.status).toBe('ok')
  })
})

describe('parseChatBlock — id charset', () => {
  it('rejects an id with uppercase letters', () => {
    const body = {
      id: 'Push-Day',
      action: 'apply',
      document: { templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }] }] }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects an id with spaces or punctuation', () => {
    const body = {
      id: 'push day!',
      action: 'apply',
      document: { templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }] }] }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects an id over 64 characters', () => {
    const body = {
      id: 'a'.repeat(65),
      action: 'apply',
      document: { templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }] }] }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('accepts a lowercase-alnum-hyphen id at the boundary length', () => {
    const body = {
      id: 'a'.repeat(64),
      action: 'apply',
      document: { templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }] }] }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false).status).toBe('ok')
  })
})

describe('parseChatBlock — create-version requires base', () => {
  it('rejects create-version with no base_template_id', () => {
    const body = {
      id: 'push-day',
      action: 'create-version',
      document: { templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }] }] }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('allows apply with no base_template_id', () => {
    const body = {
      id: 'push-day',
      action: 'apply',
      document: { templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }] }] }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false).status).toBe('ok')
  })

  it('rejects a non-uuid base_template_id even for apply', () => {
    const body = {
      id: 'push-day',
      action: 'apply',
      base_template_id: 'not-a-uuid',
      document: { templates: [{ name: 'Push Day', exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }] }] }
    }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })
})

describe('parseChatBlock — structural bounds', () => {
  it('rejects an empty templates array', () => {
    const body = { id: 'push-day', action: 'apply', document: { templates: [] } }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects more than 12 templates', () => {
    const templates = Array.from({ length: 13 }, (_, i) => ({
      name: `Day ${i}`,
      exercises: [{ exercise: 'Bench', sets: 3, reps: 8 }]
    }))
    const body = { id: 'push-day', action: 'apply', document: { templates } }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects more than 30 exercises in one template', () => {
    const exercises = Array.from({ length: 31 }, () => ({ exercise: 'Bench', sets: 3, reps: 8 }))
    const body = { id: 'push-day', action: 'apply', document: { templates: [{ name: 'Push Day', exercises }] } }
    expect(parseChatBlock('alke:template', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects more than 16 recovery-plan items', () => {
    const items = Array.from({ length: 17 }, (_, i) => ({ name: `Item ${i}`, kind: 'habit' as const }))
    const body = { id: 'rehab-taper', injury_id: UUID_B, document: { approach: 'x', items } }
    expect(parseChatBlock('alke:recovery-plan', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects an unrecognized recovery-plan item kind', () => {
    const body = {
      id: 'rehab-taper',
      injury_id: UUID_B,
      document: { approach: 'x', items: [{ name: 'Rest', kind: 'sometimes' }] }
    }
    expect(parseChatBlock('alke:recovery-plan', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects a metric name over 64 characters', () => {
    const body = { metric: 'x'.repeat(65) }
    expect(parseChatBlock('alke:metric', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })

  it('rejects a label over 120 characters on a workout block', () => {
    const body = { workout_id: UUID_A, label: 'x'.repeat(121) }
    expect(parseChatBlock('alke:workout', JSON.stringify(body), false)).toEqual({ status: 'invalid' })
  })
})
