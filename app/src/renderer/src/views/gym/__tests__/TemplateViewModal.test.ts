import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GymTemplate } from '@shared/types'
import { TemplateViewModal } from '../TemplateViewModal'

describe('TemplateViewModal', () => {
  it('keeps exercise-specific instructions visible below the exercise name', () => {
    const template: GymTemplate = {
      id: 'template-a',
      name: 'Full Body A',
      notes: 'Use controlled working sets.',
      archived: false,
      default_rest_s: null,
      family_id: 'template-a-family',
      version: 1,
      is_current: true,
      runs: [],
      created_at: '2026-07-13T00:00:00Z',
      updated_at: null,
      items: [{
        id: 'item-a',
        template_id: 'template-a',
        exercise_id: 'exercise-a',
        exercise_name: 'Goblet Squat',
        position: 0,
        target_sets: 3,
        target_reps: 10,
        target_weight_kg: null,
        rest_after_s: null,
        note: 'Use an 8–12 rep range and leave 2 reps in reserve.'
      }]
    }

    const queryClient = new QueryClient()
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TemplateViewModal, {
          template,
          usageCount: 0,
          onEdit: () => undefined,
          onClose: () => undefined
        })
      )
    )

    expect(markup).toContain('Goblet Squat')
    expect(markup).toContain('Use an 8–12 rep range and leave 2 reps in reserve.')
  })

  it('shows an estimated duration chip after the rest chip', () => {
    const template: GymTemplate = {
      id: 'template-b',
      name: 'Full Body B',
      notes: null,
      archived: false,
      default_rest_s: 60,
      family_id: 'template-b-family',
      version: 1,
      is_current: true,
      runs: [],
      created_at: '2026-07-13T00:00:00Z',
      updated_at: null,
      items: [{
        id: 'item-b',
        template_id: 'template-b',
        exercise_id: 'exercise-b',
        exercise_name: 'Bench Press',
        position: 0,
        target_sets: 3,
        target_reps: 10,
        target_weight_kg: null,
        rest_after_s: null,
        note: null
      }]
    }

    const queryClient = new QueryClient()
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TemplateViewModal, {
          template,
          usageCount: 0,
          onEdit: () => undefined,
          onClose: () => undefined
        })
      )
    )

    // 3 sets × (10 × 3s + 60s rest) + 60s setup = 330s -> ~6 min
    const restIndex = markup.indexOf('Rest 1:00')
    const durationIndex = markup.indexOf('~6 min')
    expect(restIndex).toBeGreaterThan(-1)
    expect(durationIndex).toBeGreaterThan(restIndex)
  })

  it('places Mark complete as a real button next to Edit, not a quiet-action link', () => {
    const template: GymTemplate = {
      id: 'template-c',
      name: 'Active Template',
      notes: null,
      archived: false,
      default_rest_s: null,
      family_id: 'template-c-family',
      version: 1,
      is_current: true,
      runs: [{ id: 'run-1', template_id: 'template-c', started_at: '2026-07-01', ended_at: null, source: 'user' }],
      created_at: '2026-07-01T00:00:00Z',
      updated_at: null,
      items: []
    }

    const queryClient = new QueryClient()
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TemplateViewModal, {
          template,
          usageCount: 0,
          onEdit: () => undefined,
          onClose: () => undefined
        })
      )
    )

    const headActionsMatch = markup.match(/<div class="gym-tv-head-actions">([\s\S]*?)<\/div>\s*<\/div>/)
    expect(headActionsMatch).not.toBeNull()
    const headActions = headActionsMatch![1]
    expect(headActions).toContain('Mark complete')
    expect(headActions).toContain('gym-btn')
    expect(headActions).not.toContain('gym-quiet-action')
    expect(markup).not.toContain('gym-tv-lifecycle"')
  })

  it('places Delete in a footer zone, away from Edit/lifecycle in the head', () => {
    const template: GymTemplate = {
      id: 'template-d',
      name: 'Deletable Template',
      notes: null,
      archived: false,
      default_rest_s: null,
      family_id: 'template-d-family',
      version: 1,
      is_current: true,
      runs: [],
      created_at: '2026-07-13T00:00:00Z',
      updated_at: null,
      items: []
    }

    const queryClient = new QueryClient()
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TemplateViewModal, {
          template,
          usageCount: 0,
          onEdit: () => undefined,
          onClose: () => undefined
        })
      )
    )

    // Delete lives in its own hairline-separated footer, not in the head
    // actions row next to Edit/Mark complete/Start.
    const footerMatch = markup.match(/<div class="gym-tv-footer">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/)
    expect(footerMatch).not.toBeNull()
    const footer = footerMatch![1]
    expect(footer).toContain('Delete template')
    expect(footer).toContain('gym-btn--danger')

    const headActionsMatch = markup.match(/<div class="gym-tv-head-actions">([\s\S]*?)<\/div>\s*<\/div>/)
    expect(headActionsMatch).not.toBeNull()
    expect(headActionsMatch![1]).not.toContain('Delete')
  })
})
