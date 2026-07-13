import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OfflineQueueStatus } from '../OfflineQueueStatus'

describe('OfflineQueueStatus', () => {
  it('stays out of the toolbar when online and synchronized', () => {
    const markup = renderToStaticMarkup(createElement(OfflineQueueStatus, {
      connected: true,
      status: { pending: 0, failed: 0, syncing: false, lastError: null },
      onRetry: () => undefined
    }))
    expect(markup).toBe('')
  })

  it('shows durable pending writes without claiming they are synced', () => {
    const markup = renderToStaticMarkup(createElement(OfflineQueueStatus, {
      connected: false,
      status: { pending: 2, failed: 0, syncing: false, lastError: 'fetch failed' },
      onRetry: () => undefined
    }))
    expect(markup).toContain('2 pending')
    expect(markup).toContain('Saved locally')
    expect(markup).not.toContain('Synced')
  })

  it('surfaces replay failures as needing attention', () => {
    const markup = renderToStaticMarkup(createElement(OfflineQueueStatus, {
      connected: true,
      status: { pending: 0, failed: 1, syncing: false, lastError: 'constraint violation' },
      onRetry: () => undefined
    }))
    expect(markup).toContain('1 needs attention')
    expect(markup).toContain('Retry')
  })
})
