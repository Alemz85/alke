import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CHAT_WORK_DETAIL_BYTES,
  MAX_CHAT_WORK_LOG_BYTES,
  utf8Length
} from '@shared/chatWorkLog'
import type { ChatRuntimeEnvelope, ChatRuntimeSnapshot } from '@shared/types'
import { ChatRuntimeStore } from '../chatRuntime'
import { chatUiReducer, initialChatUiState } from '../../renderer/src/chat/chatUiState'

// Main persists a snapshot; the renderer folds the same envelopes into its own
// copy and only re-reads main's on reattach. The two must land on the identical
// snapshot for every envelope stream, or a reattach silently rewrites the work
// log the user was reading. Both clocks are pinned to the same instant so the
// comparison can stay a whole-object equality.
const FROZEN_NOW = new Date('2026-07-20T12:00:00.000Z')

function makeStore(): ChatRuntimeStore {
  const directory = mkdtempSync(join(tmpdir(), 'alke-chat-parity-'))
  return new ChatRuntimeStore(join(directory, 'runtime.json'), {
    id: () => 'generation-1',
    now: () => new Date()
  })
}

/** Reattach at the begin snapshot, then fold everything main emitted after it. */
function foldLikeRenderer(
  base: ChatRuntimeSnapshot,
  envelopes: ChatRuntimeEnvelope[]
): ChatRuntimeSnapshot {
  let state = chatUiReducer(initialChatUiState(), { type: 'hydrate-runtime', runtime: base })
  for (const envelope of envelopes) {
    state = chatUiReducer(state, { type: 'runtime-event', envelope })
  }
  if (!state.runtime) throw new Error('renderer fold produced no runtime')
  return state.runtime
}

function persisted(store: ChatRuntimeStore): ChatRuntimeSnapshot {
  return JSON.parse(readFileSync(store.filePath, 'utf8')) as ChatRuntimeSnapshot
}

function describeLog(snapshot: ChatRuntimeSnapshot): string[] {
  return snapshot.workLog.map((entry) => `${entry.sequence} ${entry.kind} ${entry.label}`)
}

describe('chat runtime snapshot parity across the IPC boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('folds a completed generation into main persisted snapshot', () => {
    const store = makeStore()
    store.begin({
      sessionId: 'session-1',
      message: 'How is my training load?',
      mode: 'analysis',
      attachments: []
    })
    const base = store.snapshot()
    if (!base) throw new Error('begin produced no snapshot')

    const envelopes = [
      store.markRunning(),
      store.appendWork({ kind: 'status', label: 'Working through the request', detail: '' }),
      store.appendWork({ kind: 'tool', label: 'Read recovery plan', detail: 'python3 db.py' }),
      store.appendText('Your training load '),
      store.appendText('is fine.'),
      store.appendWork({
        kind: 'status',
        label: 'Session context was not saved',
        detail: 'network unreachable'
      }),
      store.complete()
    ]

    const folded = foldLikeRenderer(base, envelopes)
    const main = persisted(store)

    expect(describeLog(folded)).toEqual(describeLog(main))
    expect(folded).toEqual(main)
  })

  it('folds a stopped generation into main persisted snapshot', () => {
    const store = makeStore()
    store.begin({
      sessionId: 'session-1',
      message: 'How is my training load?',
      mode: 'analysis',
      attachments: []
    })
    const base = store.snapshot()
    if (!base) throw new Error('begin produced no snapshot')

    const envelopes = [
      store.markRunning(),
      store.appendText('Partial answer'),
      store.markStopping(),
      store.interrupt()
    ]

    const folded = foldLikeRenderer(base, envelopes)
    const main = persisted(store)

    expect(describeLog(folded)).toEqual(describeLog(main))
    expect(folded).toEqual(main)
  })

  it('folds a work log past the byte cap into main persisted snapshot', () => {
    const store = makeStore()
    store.begin({
      sessionId: 'session-1',
      message: 'How is my training load?',
      mode: 'analysis',
      attachments: []
    })
    const base = store.snapshot()
    if (!base) throw new Error('begin produced no snapshot')

    // Well under the 200-entry cap, well over the 256 KiB one: only the byte
    // bound can trim here, so a fold that skipped it would keep every entry.
    const entries = 150
    const envelopes = Array.from({ length: entries }, (_, index) =>
      store.appendWork({
        kind: 'tool',
        label: `Read chunk ${index}`,
        detail: 'x'.repeat(MAX_CHAT_WORK_DETAIL_BYTES)
      })
    )
    envelopes.push(store.complete())

    const folded = foldLikeRenderer(base, envelopes)
    const main = persisted(store)

    expect(main.workLog.length).toBeLessThan(entries)
    expect(utf8Length(JSON.stringify(main.workLog))).toBeLessThanOrEqual(MAX_CHAT_WORK_LOG_BYTES)
    expect(describeLog(folded)).toEqual(describeLog(main))
    expect(folded).toEqual(main)
  })

  it('folds a failed generation into main persisted snapshot', () => {
    const store = makeStore()
    store.begin({
      sessionId: 'session-1',
      message: 'How is my training load?',
      mode: 'analysis',
      attachments: []
    })
    const base = store.snapshot()
    if (!base) throw new Error('begin produced no snapshot')

    const envelopes = [store.markRunning(), store.fail('claude exited with code 1')]

    const folded = foldLikeRenderer(base, envelopes)
    const main = persisted(store)

    expect(describeLog(folded)).toEqual(describeLog(main))
    expect(folded).toEqual(main)
  })
})
