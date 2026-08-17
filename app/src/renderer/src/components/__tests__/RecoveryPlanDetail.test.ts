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
    phases: null,
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

  it('renders a pending gated step with its condition and live clock', () => {
    const gated: RecoveryPlanItem = {
      ...item('gated', 'Wall sit', 1),
      weekly_target: 7,
      phases: [
        {
          gate: { kind: 'pain_clear', max_pain: 1, clear_days: 14, condition: 'confirmed under normal daily load' },
          applied_on: null,
          weekly_target: 3,
          green_min: 2,
          yellow_min: 1
        }
      ]
    }
    const markup = renderToStaticMarkup(
      createElement(RecoveryPlanDetail, {
        overview: null,
        items: [gated],
        currentWeek: 2,
        planStartedAt: '2026-07-01',
        todayYMD: '2026-07-12',
        entries: [
          {
            id: 1,
            injury_id: 'injury',
            entry_date: '2026-07-10',
            entry_end_date: null,
            date_precision: 'day',
            noted_at: null,
            source: 'user',
            note: '',
            pain_level: 4,
            context: null,
            workout_id: null
          }
        ]
      })
    )

    // The pending step-down never renders as a week — it is a condition.
    expect(markup).toContain('gate')
    expect(markup).toContain('≤1/10 × 14 d')
    expect(markup).toContain('clean 2/14 d')
    // The in-force dose is still the acute-phase 7×.
    expect(markup).toContain('7× / week')
    expect(markup).toContain('3× / week')
  })

  it('renders an applied gated step as the week it started, with a review flag on a later flare', () => {
    const applied: RecoveryPlanItem = {
      ...item('applied', 'Heel walks', 1),
      weekly_target: 4,
      phases: [
        {
          gate: { kind: 'pain_clear', max_pain: 1, clear_days: 14 },
          applied_on: '2026-07-12',
          weekly_target: 3,
          green_min: 2,
          yellow_min: 1
        }
      ]
    }
    const markup = renderToStaticMarkup(
      createElement(RecoveryPlanDetail, {
        overview: null,
        items: [applied],
        currentWeek: 7,
        planStartedAt: '2026-05-31',
        todayYMD: '2026-07-16',
        entries: [
          {
            id: 2,
            injury_id: 'injury',
            entry_date: '2026-07-15',
            entry_end_date: null,
            date_precision: 'day',
            noted_at: null,
            source: 'user',
            note: '',
            pain_level: 3,
            context: null,
            workout_id: null
          }
        ]
      })
    )

    // Applied 2026-07-12 with plan start 2026-05-31 = week 7 — a dated step now.
    expect(markup).toContain('W7')
    expect(markup).toContain('flare 07-15 — review')
  })
})
