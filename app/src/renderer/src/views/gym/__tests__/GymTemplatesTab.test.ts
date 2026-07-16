import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
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
