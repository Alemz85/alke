// Render smoke tests for the rich-block components, following the house
// pattern established by views/gym/__tests__/TemplateViewModal.test.ts:
// renderToStaticMarkup + a bare QueryClientProvider, no jsdom. That works
// here because TanStack Query only fires a queryFn from a mount-time effect,
// which react-dom/server never runs — so any component that reaches for
// window.api only inside a useQuery/useMutation stays safely in its initial
// "loading"/idle state during SSR, with no window.api mock required. That
// constrains what these tests can assert (queries never resolve), so they
// cover: the ChatBlockRenderer dispatch/fallback paths, and every branch of
// the shared proposal Confirm/Discard/decision UI (which needs no fetched
// data at all).
import { createElement, type ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TemplateBlockPayload } from '../chatBlockParse'
import type { ChatBlockMessageContext } from '../chatBlockContext'
import { ChatBlockRenderer } from '../ChatBlockRenderer'
import { TemplateProposalBlock } from '../TemplateProposalBlock'
import { WorkoutBlock } from '../WorkoutBlock'
import { MetricBlock } from '../MetricBlock'
import { resolveMetricDef } from '../metricRegistry'

function renderWithClient(element: ReactElement): string {
  const queryClient = new QueryClient()
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, element)
  )
}

const FALLBACK = createElement('pre', null, createElement('code', null, 'raw fence text'))

describe('ChatBlockRenderer — dispatch and fallback', () => {
  it('renders the fallback verbatim for a non-alke code language', () => {
    const markup = renderWithClient(
      createElement(ChatBlockRenderer, {
        language: 'typescript',
        body: 'const x = 1',
        streaming: false,
        fallback: FALLBACK,
        nav: {}
      })
    )
    expect(markup).toContain('raw fence text')
    expect(markup).toContain('<pre>')
  })

  it('renders the fallback for invalid JSON in a final (non-streaming) message', () => {
    const markup = renderWithClient(
      createElement(ChatBlockRenderer, {
        language: 'alke:workout',
        body: '{ not json',
        streaming: false,
        fallback: FALLBACK,
        nav: {}
      })
    )
    expect(markup).toContain('raw fence text')
  })

  it('renders a "Preparing…" skeleton while streaming with unparseable JSON', () => {
    const markup = renderWithClient(
      createElement(ChatBlockRenderer, {
        language: 'alke:metric',
        body: '{ "metric": "rest',
        streaming: true,
        fallback: FALLBACK,
        nav: {}
      })
    )
    expect(markup).not.toContain('raw fence text')
    expect(markup).toContain('Preparing…')
  })

  it('falls back for an unrecognized metric name (registry miss)', () => {
    expect(resolveMetricDef('made_up_metric')).toBeNull()
    const markup = renderWithClient(
      createElement(ChatBlockRenderer, {
        language: 'alke:metric',
        body: JSON.stringify({ metric: 'made_up_metric' }),
        streaming: false,
        fallback: FALLBACK,
        nav: {}
      })
    )
    expect(markup).toContain('raw fence text')
  })

  it('renders a loading skeleton for a valid alke:workout block (query never resolves under SSR)', () => {
    const markup = renderWithClient(
      createElement(ChatBlockRenderer, {
        language: 'alke:workout',
        body: JSON.stringify({ workout_id: '11111111-1111-4111-8111-111111111111' }),
        streaming: false,
        fallback: FALLBACK,
        nav: {}
      })
    )
    expect(markup).toContain('Loading workout')
  })
})

describe('WorkoutBlock — loading state', () => {
  it('shows a status-role skeleton while the workout detail query is in flight', () => {
    const markup = renderWithClient(
      createElement(WorkoutBlock, {
        payload: { workout_id: '11111111-1111-4111-8111-111111111111' },
        nav: {}
      })
    )
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Loading workout')
  })
})

describe('MetricBlock — loading state', () => {
  it('shows a labeled skeleton naming the metric while daily metrics load', () => {
    const def = resolveMetricDef('resting_hr')
    if (!def) throw new Error('expected resting_hr in the registry')
    const markup = renderWithClient(
      createElement(MetricBlock, { payload: { metric: 'resting_hr', days: 56 }, def })
    )
    expect(markup).toContain('Loading Resting HR')
  })
})

describe('TemplateProposalBlock — Confirm/Discard/decision states', () => {
  const payload: TemplateBlockPayload = {
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

  it('renders exercise rows with rep and timed doses, and the Apply-to-Gym label', () => {
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload, streaming: false })
    )
    expect(markup).toContain('Push Day')
    expect(markup).toContain('Bench Press')
    expect(markup).toContain('4×8')
    expect(markup).toContain('Plank')
    expect(markup).toContain('3×45s')
    expect(markup).toContain('60 kg')
    expect(markup).toContain('Apply to Gym')
    expect(markup).toContain('Discard')
  })

  it('labels the confirm action "Save as new version" for a create-version proposal', () => {
    const versionPayload: TemplateBlockPayload = {
      ...payload,
      action: 'create-version',
      base_template_id: '11111111-1111-4111-8111-111111111111'
    }
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload: versionPayload, streaming: false })
    )
    expect(markup).toContain('Save as new version')
  })

  it('disables Confirm/Discard with a hint when there is no persisted message context', () => {
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload, streaming: false })
    )
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('Available when the response finishes.')
  })

  it('disables Confirm/Discard while streaming even with message context present', () => {
    const messageContext: ChatBlockMessageContext = {
      sessionId: 'session-a',
      messageIndex: 0,
      generationActive: false
    }
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload, streaming: true, messageContext })
    )
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('Available when the response finishes.')
  })

  it('disables Confirm/Discard when another generation is active in this session', () => {
    const messageContext: ChatBlockMessageContext = {
      sessionId: 'session-a',
      messageIndex: 0,
      generationActive: true
    }
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload, streaming: false, messageContext })
    )
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('Available when the response finishes.')
  })

  it('enables Confirm/Discard with full, idle message context', () => {
    const messageContext: ChatBlockMessageContext = {
      sessionId: 'session-a',
      messageIndex: 0,
      generationActive: false
    }
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload, streaming: false, messageContext })
    )
    expect(markup).not.toContain('disabled=""')
    expect(markup).not.toContain('Available when the response finishes.')
  })

  it('shows a resolved "Applied · HH:MM" chip and hides the action buttons once applied', () => {
    const messageContext: ChatBlockMessageContext = {
      sessionId: 'session-a',
      messageIndex: 0,
      generationActive: false,
      blockDecisions: {
        'push-day': { status: 'applied', at: '2026-08-17T10:15:00.000Z', detail: 'Template created.' }
      }
    }
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload, streaming: false, messageContext })
    )
    expect(markup).toContain('Applied ·')
    expect(markup).toContain('Template created.')
    expect(markup).not.toContain('Apply to Gym')
    expect(markup).not.toContain('Discard')
  })

  it('shows a plain "Discarded" chip with no timestamp and no buttons', () => {
    const messageContext: ChatBlockMessageContext = {
      sessionId: 'session-a',
      messageIndex: 0,
      generationActive: false,
      blockDecisions: { 'push-day': { status: 'discarded', at: '2026-08-17T10:15:00.000Z' } }
    }
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload, streaming: false, messageContext })
    )
    expect(markup).toContain('Discarded')
    expect(markup).not.toContain('Applied')
    expect(markup).not.toContain('Apply to Gym')
  })

  it('shows a "Failed" chip with detail while still offering Confirm as Retry', () => {
    const messageContext: ChatBlockMessageContext = {
      sessionId: 'session-a',
      messageIndex: 0,
      generationActive: false,
      blockDecisions: {
        'push-day': { status: 'failed', at: '2026-08-17T10:15:00.000Z', detail: 'apply script exited 1' }
      }
    }
    const markup = renderWithClient(
      createElement(TemplateProposalBlock, { payload, streaming: false, messageContext })
    )
    expect(markup).toContain('Failed')
    expect(markup).toContain('apply script exited 1')
    expect(markup).toContain('Retry')
    expect(markup).toContain('Discard')
    expect(markup).not.toContain('disabled=""')
  })
})
