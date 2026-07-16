import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GymTemplate } from '@shared/types'
import { GymTemplatesTab } from '../GymTemplatesTab'
import type { RecoveryLogTemplate } from '../../../lib/recoveryLogTemplates'

describe('GymTemplatesTab recovery previews', () => {
  it('ends the compact recovery card after its overview', () => {
    const recoveryTemplate: RecoveryLogTemplate = {
      id: 'recovery:hamstring',
      injuryId: 'hamstring',
      planStartedAt: '2026-07-01',
      name: 'Hamstring strain recovery',
      summary: 'Rebuild hamstring tolerance progressively with mobility and walking first.',
      rows: [{
        exerciseId: 'heel-walks',
        exerciseName: 'Heel walks',
        reps: 12,
        weightKg: null,
        isWarmup: false
      }],
      exerciseItems: [],
      guidance: [],
      unlinkedExerciseCount: 0
    }
    const queryClient = new QueryClient()
    const tab = createElement(GymTemplatesTab, {
      templates: [],
      recoveryTemplates: [recoveryTemplate],
      usageById: new Map(),
      onView: () => undefined,
      onNew: () => undefined,
      onUseRecovery: () => undefined
    })
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, tab)
    )

    expect(markup).toContain('Rebuild hamstring tolerance progressively')
    expect(markup).not.toContain('>Overview<')
    expect(markup).not.toContain('Use in log')
    expect(markup).not.toContain('ready')
  })

  it('uses the available card body for a longer overview', () => {
    const recoveryTemplate: RecoveryLogTemplate = {
      id: 'recovery:hamstring',
      injuryId: 'hamstring',
      planStartedAt: '2026-07-01',
      name: 'Hamstring strain recovery',
      summary:
        'Rebuild hamstring tolerance progressively with mobility and walking first, then strengthen the posterior chain through controlled loading before returning to running.',
      rows: [],
      exerciseItems: [],
      guidance: [],
      unlinkedExerciseCount: 0
    }
    const queryClient = new QueryClient()
    const tab = createElement(GymTemplatesTab, {
      templates: [],
      recoveryTemplates: [recoveryTemplate],
      usageById: new Map(),
      onView: () => undefined,
      onNew: () => undefined,
      onUseRecovery: () => undefined
    })
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, tab)
    )

    expect(markup).toContain('controlled loading')
  })

  it('omits a card for an injury whose recovery plan was never started', () => {
    // Mirrors an injury just logged in the Injuries tab: status isn't
    // 'resolved' yet so useRecoveryPlanBundles still yields a bundle for it,
    // but plan_started_at is null because "Set plan start" was never clicked
    // — this used to still render a card here even with no active plan.
    const recoveryTemplate: RecoveryLogTemplate = {
      id: 'recovery:elbow',
      injuryId: 'elbow',
      planStartedAt: null,
      name: 'Elbow recovery',
      summary: 'Some early notes on the elbow before a plan exists.',
      rows: [],
      exerciseItems: [],
      guidance: [],
      unlinkedExerciseCount: 0
    }
    const queryClient = new QueryClient()
    const tab = createElement(GymTemplatesTab, {
      templates: [],
      recoveryTemplates: [recoveryTemplate],
      usageById: new Map(),
      onView: () => undefined,
      onNew: () => undefined,
      onUseRecovery: () => undefined
    })
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, tab)
    )

    expect(markup).not.toContain('Elbow recovery')
    expect(markup).not.toContain('Recovery plans')
  })
})

describe('GymTemplatesTab active card — glance-only preview', () => {
  it('keeps the card glance-only: no Mark complete/Start/Resurrect or Delete, just meta/rest/lifecycle line', () => {
    const activeTemplate: GymTemplate = {
      id: 'template-active',
      name: 'Push Day',
      notes: null,
      archived: false,
      default_rest_s: 90,
      family_id: 'template-active-family',
      version: 1,
      is_current: true,
      created_at: '2026-07-01T00:00:00Z',
      updated_at: null,
      runs: [{ id: 'run-1', template_id: 'template-active', started_at: '2026-07-01', ended_at: null, source: 'user' }],
      items: [{
        id: 'item-a',
        template_id: 'template-active',
        exercise_id: 'exercise-a',
        exercise_name: 'Bench Press',
        position: 0,
        target_sets: 3,
        target_reps: 8,
        target_weight_kg: null,
        rest_after_s: null,
        note: null
      }]
    }

    const queryClient = new QueryClient()
    const tab = createElement(GymTemplatesTab, {
      templates: [activeTemplate],
      recoveryTemplates: [],
      usageById: new Map([['template-active', 4]]),
      onView: () => undefined,
      onNew: () => undefined,
      onUseRecovery: () => undefined
    })
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, tab)
    )

    // Glance-only info stays: usage meta, rest chip, lifecycle status line.
    expect(markup).toContain('Done 4')
    expect(markup).toContain('Active since')

    // The lifecycle button (Mark complete/Start/Resurrect) and Delete are
    // gone from the preview card — both actions now live in the view modal.
    expect(markup).not.toContain('Mark complete')
    expect(markup).not.toContain('Resurrect')
    expect(markup).not.toContain('gym-tpl-card-lifecycle-btn')
    expect(markup).not.toContain('>Delete<')
    expect(markup).not.toContain('gym-tpl-card-actions')
  })

  it('keeps a non-started template glance-only too (no Start button)', () => {
    const freshTemplate: GymTemplate = {
      id: 'template-fresh',
      name: 'Leg Day',
      notes: null,
      archived: false,
      default_rest_s: null,
      family_id: 'template-fresh-family',
      version: 1,
      is_current: true,
      created_at: '2026-07-01T00:00:00Z',
      updated_at: null,
      runs: [],
      items: []
    }

    const queryClient = new QueryClient()
    const tab = createElement(GymTemplatesTab, {
      templates: [freshTemplate],
      recoveryTemplates: [],
      usageById: new Map(),
      onView: () => undefined,
      onNew: () => undefined,
      onUseRecovery: () => undefined
    })
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, tab)
    )

    expect(markup).toContain('Done 0')
    expect(markup).not.toContain('>Start<')
    expect(markup).not.toContain('>Delete<')
  })
})
