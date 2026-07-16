import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// ChatView.tsx re-exports through '../components' (a barrel including
// RecentSessionsCard → RouteMap → leaflet, which touches `window` at import
// time), so it can't be imported live under this suite's `node` test
// environment. Every other ChatView-adjacent regression guard in this repo
// (e.g. injuryCardActions.test.ts) uses the same source-text-contract
// approach for exactly this reason — assert against the file's text instead
// of executing it.
const source = readFileSync(new URL('../ChatView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../ChatView.css', import.meta.url), 'utf8')

describe('isComposingNewChat (mode picker visibility gate)', () => {
  // Extract and evaluate the function body in isolation so the gating LOGIC
  // itself is exercised (not just grepped for), without pulling in the rest
  // of the module graph.
  const fnMatch = source.match(
    /export function isComposingNewChat\(([\s\S]*?)\): boolean \{([\s\S]*?)\n\}/
  )
  if (!fnMatch) throw new Error('isComposingNewChat not found in ChatView.tsx')
  const [, rawParams, body] = fnMatch
  // Strip the TS type annotations (`new Function` only parses plain JS) —
  // splits on top-level commas then drops everything from the first `:` on,
  // which is safe here since neither parameter's annotation itself contains
  // a comma or colon that would confuse this (string | null, unknown[]).
  const params = rawParams
    .split(',')
    .map((p) => p.split(':')[0].trim())
    .join(', ')
  // eslint-disable-next-line no-new-func
  const isComposingNewChat = new Function(`return function(${params}) {${body}}`)() as (
    activeId: string | null,
    messages: unknown[]
  ) => boolean

  it('is true with no active session and no messages (brand-new compose)', () => {
    expect(isComposingNewChat(null, [])).toBe(true)
  })

  it('is false once a session id is assigned, even with no messages yet', () => {
    // Guards the brief window between the optimistic user-message append and
    // the chatSend response landing — activeId flips to the new id first in
    // that response, so this alone must already hide the picker.
    expect(isComposingNewChat('session-1', [])).toBe(false)
  })

  it('is false once any message exists, even without an active session id', () => {
    expect(isComposingNewChat(null, [{ role: 'user', content: 'hi', ts: 'now' }])).toBe(false)
  })

  it('is false for a resumed session with history', () => {
    expect(
      isComposingNewChat('session-1', [
        { role: 'user', content: 'hi', ts: 'now' },
        { role: 'assistant', content: 'follow-up', ts: 'now' }
      ])
    ).toBe(false)
  })
})

describe('mode picker wiring (source contract)', () => {
  it('renders the picker gated on isComposingNewChat, inside the composer', () => {
    const composerMatch = source.match(/<div className="chat-composer">([\s\S]*?)<div className="chat-input-well">/)
    expect(composerMatch).not.toBeNull()
    const composerHead = composerMatch?.[1] ?? ''
    expect(composerHead).toContain('isComposingNewChat(activeId, messages)')
    expect(composerHead).toContain('chat-mode-picker')
  })

  it('builds the picker options from the shared CHAT_MODES contract, not a hand-rolled list', () => {
    expect(source).toContain('CHAT_MODES.map((option)')
  })

  it('defaults to analysis mode', () => {
    expect(source).toMatch(/DEFAULT_CHAT_MODE:\s*ChatMode\s*=\s*'analysis'/)
    expect(source).toContain("useState<ChatMode>(DEFAULT_CHAT_MODE)")
  })

  it('resets mode to the default when starting a new analysis or opening a session', () => {
    const newAnalysisMatch = source.match(/function newAnalysis\(\): void \{([\s\S]*?)\n  \}/)
    expect(newAnalysisMatch).not.toBeNull()
    expect(newAnalysisMatch?.[1] ?? '').toContain('setMode(DEFAULT_CHAT_MODE)')

    const openSessionMatch = source.match(/async function openSession\(id: string\): Promise<void> \{([\s\S]*?)\n  \}/)
    expect(openSessionMatch).not.toBeNull()
    expect(openSessionMatch?.[1] ?? '').toContain('setMode(DEFAULT_CHAT_MODE)')
  })

  it('forwards mode as the trailing chatSend argument', () => {
    // The 3rd argument (attachment paths) is itself a call with its own
    // comma-free arrow function, so match the whole balanced call rather than
    // splitting on top-level commas.
    const sendCallMatch = source.match(
      /window\.api\.chatSend\(\s*activeId,\s*message,\s*attachments\.map\(\(\{ path \}\) => path\),\s*mode\s*\)/
    )
    expect(sendCallMatch).not.toBeNull()
  })

  it('never persists mode to the DB — mode is local component state, not part of a session mutation payload', () => {
    expect(source).not.toMatch(/chatRename\([^)]*mode/)
    expect(source).not.toMatch(/messages,\s*mode/)
  })
})

describe('mode picker styling (CSS contract)', () => {
  it('reads as a compact chip/tablist row, matching the ChipFilter idiom', () => {
    expect(css).toMatch(/\.chat-mode-picker\s*\{[^}]*display:\s*flex/s)
    expect(css).toMatch(/\.chat-mode-chip\s*\{[^}]*border-radius:\s*var\(--radius-full\)/s)
    expect(css).toMatch(/\.chat-mode-chip--active[^{]*\{[^}]*background:\s*var\(--color-text\)/s)
  })
})
