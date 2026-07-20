import { describe, expect, it } from 'vitest'
import type { ChatRuntimeEnvelope, ChatRuntimeSnapshot } from '@shared/types'
import {
  NEW_CHAT_KEY,
  chatUiReducer,
  initialChatUiState,
  parseChatUiSnapshot,
  serializeChatUiState
} from '../chatUiState'

function runtimeSnapshot(patch: Partial<ChatRuntimeSnapshot> = {}): ChatRuntimeSnapshot {
  return {
    version: 1,
    generationId: 'generation-1',
    sessionId: 'session-1',
    originalMessage: 'Analyze',
    mode: 'analysis',
    attachments: [],
    startedAt: '2026-07-20T12:00:00.000Z',
    updatedAt: '2026-07-20T12:00:00.000Z',
    phase: 'running',
    assistantText: 'A',
    workLog: [],
    error: null,
    resumeAvailable: true,
    lastSequence: 4,
    ...patch
  }
}

function envelope(sequence: number, text: string): ChatRuntimeEnvelope {
  return {
    generationId: 'generation-1',
    sessionId: 'session-1',
    sequence,
    event: { kind: 'text', text }
  }
}

describe('chatUiReducer', () => {
  it('keeps independent drafts, modes, and attachments per composition', () => {
    let state = initialChatUiState()
    state = chatUiReducer(state, {
      type: 'set-draft',
      key: NEW_CHAT_KEY,
      text: 'new draft'
    })
    state = chatUiReducer(state, { type: 'select', sessionId: 'session-1' })
    state = chatUiReducer(state, {
      type: 'set-draft',
      key: 'session-1',
      text: 'follow up'
    })
    state = chatUiReducer(state, {
      type: 'set-mode',
      key: 'session-1',
      mode: 'injuries'
    })
    state = chatUiReducer(state, {
      type: 'set-attachments',
      key: 'session-1',
      attachments: [{ path: '/tmp/report.pdf', name: 'report.pdf', sizeBytes: 20 }]
    })

    expect(state.drafts).toEqual({ [NEW_CHAT_KEY]: 'new draft', 'session-1': 'follow up' })
    expect(state.modes['session-1']).toBe('injuries')
    expect(state.attachments['session-1']?.[0]?.name).toBe('report.pdf')
  })

  it('promotes the new composition to its accepted session without losing other drafts', () => {
    let state = initialChatUiState()
    state = chatUiReducer(state, { type: 'set-draft', key: NEW_CHAT_KEY, text: 'Analyze' })
    state = chatUiReducer(state, { type: 'set-mode', key: NEW_CHAT_KEY, mode: 'goals' })
    state = chatUiReducer(state, {
      type: 'promote-composition',
      fromKey: NEW_CHAT_KEY,
      sessionId: 'session-2'
    })

    expect(state.selectedSessionId).toBe('session-2')
    expect(state.drafts[NEW_CHAT_KEY]).toBe('')
    expect(state.modes['session-2']).toBe('goals')
  })

  it('reconciles newer runtime events and ignores duplicate sequences', () => {
    let state = chatUiReducer(initialChatUiState(), {
      type: 'hydrate-runtime',
      runtime: runtimeSnapshot()
    })
    state = chatUiReducer(state, { type: 'runtime-event', envelope: envelope(5, 'B') })
    state = chatUiReducer(state, { type: 'runtime-event', envelope: envelope(5, 'B') })

    expect(state.runtime?.assistantText).toBe('AB')
    expect(state.runtime?.lastSequence).toBe(5)
  })

  it('applies terminal and work-log events to the owning generation', () => {
    let state = chatUiReducer(initialChatUiState(), {
      type: 'hydrate-runtime',
      runtime: runtimeSnapshot()
    })
    state = chatUiReducer(state, {
      type: 'runtime-event',
      envelope: {
        generationId: 'generation-1',
        sessionId: 'session-1',
        sequence: 5,
        event: { kind: 'tool', name: 'Read recovery plan', detail: 'db.py' }
      }
    })
    state = chatUiReducer(state, {
      type: 'runtime-event',
      envelope: {
        generationId: 'generation-1',
        sessionId: 'session-1',
        sequence: 6,
        event: { kind: 'done' }
      }
    })

    expect(state.runtime).toMatchObject({
      phase: 'completed',
      lastSequence: 6,
      workLog: [expect.objectContaining({ label: 'Read recovery plan', sequence: 5 })]
    })
  })
})

describe('chat UI persistence', () => {
  it('falls back safely for corrupt, unknown-version, and malformed data', () => {
    expect(parseChatUiSnapshot('{bad')).toEqual(initialChatUiState())
    expect(parseChatUiSnapshot(JSON.stringify({ version: 99 }))).toEqual(initialChatUiState())
    expect(parseChatUiSnapshot(JSON.stringify({ version: 1, drafts: { bad: 42 } }))).toEqual(
      initialChatUiState()
    )
  })

  it('round-trips composition state without duplicating the main-owned runtime', () => {
    const state = {
      ...initialChatUiState(),
      selectedSessionId: 'session-1',
      drafts: { 'session-1': 'Follow up' },
      modes: { 'session-1': 'analysis' as const },
      historyOpen: true,
      workLogOpen: true,
      runtime: runtimeSnapshot()
    }

    const serialized = serializeChatUiState(state)
    expect(serialized).not.toContain('assistantText')
    expect(parseChatUiSnapshot(serialized)).toMatchObject({
      selectedSessionId: 'session-1',
      drafts: { 'session-1': 'Follow up' },
      runtime: null,
      historyOpen: true,
      workLogOpen: true
    })
  })
})
