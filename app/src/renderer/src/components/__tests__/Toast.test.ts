import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Toast } from '../Toast'

describe('Toast accessibility', () => {
  it('announces rejected writes assertively', () => {
    const markup = renderToStaticMarkup(createElement(Toast, {
      message: 'Your previous version was restored.',
      tone: 'error',
      onDismiss: () => undefined,
      duration: 0
    }))
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('aria-live="assertive"')
  })

  it('keeps informational feedback polite', () => {
    const markup = renderToStaticMarkup(createElement(Toast, {
      message: 'Already up to date.',
      tone: 'info',
      onDismiss: () => undefined,
      duration: 0
    }))
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
  })
})
