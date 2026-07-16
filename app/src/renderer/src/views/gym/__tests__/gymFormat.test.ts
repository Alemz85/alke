import { describe, expect, it } from 'vitest'
import type { GymTemplate, GymTemplateItem } from '@shared/types'
import { estimateTemplateDurationSeconds, formatEstimatedDuration } from '../gymFormat'

function makeItem(overrides: Partial<GymTemplateItem> = {}): GymTemplateItem {
  return {
    id: 'item',
    template_id: 'template',
    exercise_id: 'exercise',
    exercise_name: 'Squat',
    position: 0,
    target_sets: 3,
    target_reps: 10,
    target_weight_kg: null,
    rest_after_s: null,
    note: null,
    ...overrides
  }
}

function makeTemplate(overrides: Partial<GymTemplate> = {}): GymTemplate {
  return {
    id: 'template',
    name: 'Template',
    notes: null,
    archived: false,
    default_rest_s: null,
    family_id: 'family',
    version: 1,
    is_current: true,
    items: [],
    runs: [],
    created_at: null,
    updated_at: null,
    ...overrides
  }
}

describe('estimateTemplateDurationSeconds', () => {
  it('sums sets × (reps × 3s + rest) plus a per-exercise setup constant', () => {
    const template = makeTemplate({
      default_rest_s: 60,
      items: [makeItem({ target_sets: 3, target_reps: 10, rest_after_s: null })]
    })
    // 3 sets × (10 reps × 3s + 60s rest) = 3 × 90 = 270, plus 60s setup = 330
    expect(estimateTemplateDurationSeconds(template)).toBe(330)
  })

  it('prefers a per-exercise rest override over the template default', () => {
    const template = makeTemplate({
      default_rest_s: 90,
      items: [makeItem({ target_sets: 2, target_reps: 8, rest_after_s: 30 })]
    })
    // 2 sets × (8 × 3 + 30) = 2 × 54 = 108, plus 60s setup = 168
    expect(estimateTemplateDurationSeconds(template)).toBe(168)
  })

  it('falls back to a conservative 1×10 when targets are unset', () => {
    const template = makeTemplate({
      default_rest_s: null,
      items: [makeItem({ target_sets: null, target_reps: null, rest_after_s: null })]
    })
    // 1 set × (10 × 3 + 0) = 30, plus 60s setup = 90
    expect(estimateTemplateDurationSeconds(template)).toBe(90)
  })

  it('sums across multiple exercises, each with its own setup constant', () => {
    const template = makeTemplate({
      default_rest_s: 60,
      items: [
        makeItem({ target_sets: 3, target_reps: 10, rest_after_s: null }),
        makeItem({ target_sets: 3, target_reps: 10, rest_after_s: null })
      ]
    })
    expect(estimateTemplateDurationSeconds(template)).toBe(330 * 2)
  })

  it('returns 0 for a template with no exercises', () => {
    expect(estimateTemplateDurationSeconds(makeTemplate({ items: [] }))).toBe(0)
  })
})

describe('formatEstimatedDuration', () => {
  it('rounds to the nearest minute and prefixes with ~', () => {
    expect(formatEstimatedDuration(330)).toBe('~6 min')
    expect(formatEstimatedDuration(2880)).toBe('~48 min')
  })

  it('floors at ~1 min for any non-zero duration under a minute', () => {
    expect(formatEstimatedDuration(20)).toBe('~1 min')
  })
})
