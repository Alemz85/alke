import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Goal } from '@shared/types'
import { GoalStrip } from '../GoalStrip'

const styles = readFileSync(new URL('../GoalStrip.css', import.meta.url), 'utf8')

function makeGoal(overrides: Partial<Goal> & { id: string }): Goal {
  return {
    id: overrides.id,
    title: overrides.title ?? 'Untitled goal',
    description: null,
    status: overrides.status ?? 'active',
    started_at: overrides.started_at ?? '2026-01-01T00:00:00Z',
    status_changed_at: null,
    duration_days: overrides.duration_days ?? null,
    created_by: 'user',
    metric_name: overrides.metric_name ?? null,
    metric_description: null,
    metric_sql: overrides.metric_sql ?? null,
    metric_direction: overrides.metric_direction ?? null,
    metric_unit: overrides.metric_unit ?? null,
    metric_baseline: overrides.metric_baseline ?? null,
    metric_target: overrides.metric_target ?? null,
    created_at: null,
    updated_at: null
  }
}

/** Renders GoalStrip with goals/progress pre-seeded into the cache (via
 *  setQueryData) so no queryFn ever runs — window.api isn't defined under
 *  the node test environment, matching this repo's other useQuery component
 *  tests (e.g. TemplateViewModal.test.ts), which never trigger a live fetch
 *  during a static render. */
function renderStrip(goals: Goal[], progressByGoalId: Record<string, { date: string; value: number }[]> = {}): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['goals'], goals)
  for (const [goalId, points] of Object.entries(progressByGoalId)) {
    queryClient.setQueryData(['goal-progress', goalId], points)
  }
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(GoalStrip, { onOpenProfile: () => undefined })
    )
  )
}

describe('GoalStrip', () => {
  it('renders nothing when there are no active goals', () => {
    const markup = renderStrip([
      makeGoal({ id: 'g1', status: 'completed' }),
      makeGoal({ id: 'g2', status: 'abandoned' }),
      makeGoal({ id: 'g3', status: 'on_hold' })
    ])
    expect(markup).toBe('')
  })

  it('renders nothing with an empty goal list', () => {
    expect(renderStrip([])).toBe('')
  })

  it('shows a placeholder for an active goal with no metric yet', () => {
    const markup = renderStrip([makeGoal({ id: 'g1', title: 'Sub-20 5k', status: 'active', metric_sql: null })])
    expect(markup).toContain('Sub-20 5k')
    expect(markup).toContain('metric building')
  })

  it('shows current value, target, and delta for a goal with a built metric', () => {
    const goal = makeGoal({
      id: 'g1',
      title: 'Improve VO2max',
      status: 'active',
      metric_name: 'Cardiorespiratory fitness (28-day rolling)',
      metric_sql: 'select 1',
      metric_direction: 'up',
      metric_unit: 'ml/kg/min',
      metric_baseline: 40,
      metric_target: 50
    })
    const markup = renderStrip([goal], {
      g1: [
        { date: '2026-06-01', value: 40 },
        { date: '2026-07-01', value: 44 }
      ]
    })
    expect(markup).toContain('Improve VO2max')
    expect(markup).not.toContain('Cardiorespiratory fitness')
    expect(markup).toContain('44')
    expect(markup).toContain('goal-strip-metric-unit')
    expect(markup).toContain('50')
    expect(markup).toContain('Target 50')
    expect(markup).not.toContain('Target 50 ml/kg/min')
    expect(markup).toContain('+4 vs start')
    expect(markup).toContain('goal-strip-progress-value')
    expect(markup).toContain('40%')
    expect(markup).toContain('role="progressbar"')
    expect(markup).toContain('aria-valuenow="40"')
  })

  it('excludes non-active goals from the grid entirely', () => {
    const markup = renderStrip([
      makeGoal({ id: 'g1', title: 'Active goal', status: 'active' }),
      makeGoal({ id: 'g2', title: 'Completed goal', status: 'completed' }),
      makeGoal({ id: 'g3', title: 'On hold goal', status: 'on_hold' }),
      makeGoal({ id: 'g4', title: 'Abandoned goal', status: 'abandoned' })
    ])
    expect(markup).toContain('Active goal')
    expect(markup).not.toContain('Completed goal')
    expect(markup).not.toContain('On hold goal')
    expect(markup).not.toContain('Abandoned goal')
  })

  it('uses compact four-up metric cards at desktop widths', () => {
    const gridRule = styles.match(/\.goal-strip-grid\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    const cardRule = styles.match(/\.goal-strip-card\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    const metricRowRule = styles.match(/\.goal-strip-metric-row\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    const regressingRule = styles.match(/\.goal-strip-delta--regressing\s*\{([\s\S]*?)\}/)?.[1] ?? ''

    expect(gridRule).toContain('repeat(4, minmax(0, 1fr))')
    expect(gridRule).toContain('gap: var(--space-md)')
    expect(cardRule).toContain('background: var(--color-surface-elevated)')
    expect(cardRule).toContain('border-radius: var(--radius-lg)')
    expect(cardRule).toContain('min-height: 152px')
    expect(metricRowRule).toContain('min-width: 0')
    expect(metricRowRule).toContain('width: 100%')
    expect(regressingRule).toContain('var(--color-text-tertiary)')
    expect(regressingRule).not.toContain('flag')
  })
})
