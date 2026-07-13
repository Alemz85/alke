import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RecoveryPlanItem } from '@shared/types'
import { RecoveryPlanDetail } from '../RecoveryPlanDetail'

function item(id: string, name: string, startWeek: number): RecoveryPlanItem {
  return {
    id,
    injury_id: 'injury',
    name,
    kind: 'exercise',
    weekly_target: 3,
    green_min: 2,
    yellow_min: 1,
    start_week: startWeek,
    target_sets: 3,
    target_reps: 12,
    steps: null,
    note: null,
    active: true,
    exercise_id: null,
    created_at: null,
    updated_at: null
  }
}

describe('RecoveryPlanDetail phases', () => {
  it('groups prescriptions by start week and labels current and future phases', () => {
    const markup = renderToStaticMarkup(
      createElement(RecoveryPlanDetail, {
        overview: 'Build tolerance in stages.',
        items: [item('week-3', 'Band dorsiflexion', 3), item('week-1', 'Daily mobility', 1)],
        currentWeek: 1
      })
    )

    expect(markup).toContain('Week 1')
    expect(markup).toContain('Current phase')
    expect(markup).toContain('Week 3')
    expect(markup).toContain('Starts later')
    expect(markup.indexOf('Daily mobility')).toBeLessThan(markup.indexOf('Band dorsiflexion'))
  })

  it('keeps the overview after the exercises', () => {
    const markup = renderToStaticMarkup(
      createElement(RecoveryPlanDetail, {
        overview: 'Build tolerance in stages.',
        items: [item('week-1', 'Daily mobility', 1)],
        currentWeek: 1
      })
    )

    expect(markup.indexOf('Daily mobility')).toBeLessThan(markup.indexOf('Build tolerance in stages.'))
  })
})
