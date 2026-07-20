import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../ChatView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../ChatView.css', import.meta.url), 'utf8')
const historySource = readFileSync(new URL('../chat/ChatHistory.tsx', import.meta.url), 'utf8')
const workLogSource = readFileSync(new URL('../chat/ChatWorkLog.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../chat/ChatComposer.tsx', import.meta.url), 'utf8')
const overlaySource = readFileSync(new URL('../chat/useOverlayPanel.ts', import.meta.url), 'utf8')

describe('long-form Chat workspace', () => {
  it('uses a compact session header and document column without TabHeader', () => {
    expect(source).not.toContain('<TabHeader')
    expect(source).toContain('chat-session-header')
    expect(source).toContain('chat-document')
    expect(source).toContain('chat-document-column')
    expect(source).toContain('<ChatHistory')
    expect(source).toContain('<ChatWorkLog')
    expect(source).toContain('<ChatComposer')
  })

  it('consumes the persistent provider instead of subscribing locally', () => {
    expect(source).toContain('useChatRuntime()')
    expect(source).not.toContain('window.api.onChatStream')
    expect(source).not.toContain("useState('')")
  })

  it('keeps assistant output document-like and user turns compact', () => {
    expect(source).toContain('chat-assistant-document')
    expect(source).toContain('chat-user-bubble')
    expect(source).toContain('runtime.assistantText')
    expect(source).toContain('Continue')
    expect(source).toContain('Retry')
  })

  it('uses focused components for history, work log, and composition', () => {
    expect(historySource).toContain('aria-label="Conversation history"')
    expect(historySource).toContain('New analysis')
    expect(historySource).toContain('Working')
    expect(workLogSource).toContain('aria-label="Work log"')
    expect(workLogSource).toContain('<details')
    expect(composerSource).toContain('CHAT_MODES.map')
    expect(composerSource).toContain('Ask about your training')
  })

  it('labels composition and traps keyboard focus in responsive drawers', () => {
    expect(composerSource).toContain('aria-label="Message Alke"')
    expect(composerSource).toContain('autoComplete="off"')
    expect(historySource).toContain('aria-modal=')
    expect(workLogSource).toContain('aria-modal=')
    expect(overlaySource).toContain("event.key === 'Escape'")
    expect(overlaySource).toContain("event.key !== 'Tab'")
    expect(overlaySource).toContain('document.activeElement')
  })
})

describe('responsive and token-only Chat styling', () => {
  it('centers a 760px reading column and uses structural rails', () => {
    expect(css).toMatch(/\.chat-document-column\s*\{[^}]*max-width:\s*760px/s)
    expect(css).toMatch(/\.chat-history\s*\{[^}]*width:\s*208px/s)
    expect(css).toMatch(/\.chat-worklog\s*\{[^}]*width:\s*248px/s)
  })

  it('turns history and work log into drawers before they squeeze the prose', () => {
    expect(css).toMatch(/@media \(max-width:\s*1180px\)[\s\S]*\.chat-history/s)
    expect(css).toMatch(/@media \(max-width:\s*920px\)[\s\S]*\.chat-worklog/s)
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.chat-document/s)
  })

  it('uses no shadows, gradients, glows, or new accent chrome', () => {
    expect(css).not.toMatch(/linear-gradient|radial-gradient|box-shadow|filter:\s*drop-shadow/)
    expect(css).not.toMatch(/var\(--color-(aerobic|load|recovery|sessions)\)/)
  })

  it('covers keyboard focus and reduced motion', () => {
    expect(css).toContain(':focus-visible')
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/)
  })
})
