import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CHAT_RUNTIME_BYTES,
  MAX_CHAT_RUNTIME_PARTIAL_BYTES,
  MAX_CHAT_WORK_DETAIL_BYTES,
  MAX_CHAT_WORK_ENTRIES,
  ChatRuntimeStore
} from '../chatRuntime'

function makeStore(filePath?: string): ChatRuntimeStore {
  const directory = mkdtempSync(join(tmpdir(), 'alke-chat-runtime-'))
  let nextId = 0
  let tick = 0
  return new ChatRuntimeStore(filePath ?? join(directory, 'runtime.json'), {
    id: () => `generation-${++nextId}`,
    now: () => new Date(Date.UTC(2026, 6, 20, 12, 0, tick++))
  })
}

function begin(store: ChatRuntimeStore): void {
  store.begin({
    sessionId: 'session-1',
    message: 'Analyze my last two weeks',
    mode: 'analysis',
    attachments: []
  })
}

describe('ChatRuntimeStore', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('sequences text and work events into one running snapshot', () => {
    const store = makeStore()
    const started = store.begin({
      sessionId: 'session-1',
      message: 'Analyze',
      mode: 'analysis',
      attachments: []
    })
    const text = store.appendText('Answer')
    const tool = store.appendWork({
      kind: 'tool',
      label: 'Read recovery plan',
      detail: 'python3 db.py recovery'
    })

    expect([started.sequence, text.sequence, tool.sequence]).toEqual([1, 2, 3])
    expect(store.snapshot()).toMatchObject({
      phase: 'running',
      assistantText: 'Answer',
      lastSequence: 3,
      workLog: [
        expect.objectContaining({
          sequence: 3,
          kind: 'tool',
          label: 'Read recovery plan'
        })
      ]
    })
  })

  it('bounds work details, entry count, partial text, and the serialized file', () => {
    const store = makeStore()
    begin(store)

    for (let index = 0; index < MAX_CHAT_WORK_ENTRIES + 40; index += 1) {
      store.appendWork({
        kind: 'tool',
        label: `Tool ${index}`,
        detail: index === MAX_CHAT_WORK_ENTRIES + 39 ? 'x'.repeat(MAX_CHAT_WORK_DETAIL_BYTES * 2) : 'x'
      })
    }
    store.appendText('y'.repeat(MAX_CHAT_RUNTIME_PARTIAL_BYTES + 100))
    store.flush()

    const snapshot = store.snapshot()
    expect(snapshot?.workLog).toHaveLength(MAX_CHAT_WORK_ENTRIES)
    expect(Buffer.byteLength(snapshot?.workLog.at(-1)?.detail ?? '')).toBeLessThanOrEqual(
      MAX_CHAT_WORK_DETAIL_BYTES
    )
    expect(Buffer.byteLength(snapshot?.assistantText ?? '')).toBeLessThanOrEqual(
      MAX_CHAT_RUNTIME_PARTIAL_BYTES
    )
    expect(Buffer.byteLength(readFileSync(store.filePath))).toBeLessThanOrEqual(
      MAX_CHAT_RUNTIME_BYTES
    )
  })

  it('writes atomically and restores an in-flight run as interrupted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alke-chat-restore-'))
    const filePath = join(directory, 'runtime.json')
    const first = makeStore(filePath)
    begin(first)
    first.appendText('Partial answer')
    first.setResumeAvailable(true)
    first.flush()

    expect(() => readFileSync(`${filePath}.tmp`)).toThrow()

    const restored = makeStore(filePath)
    expect(restored.restore()).toMatchObject({
      phase: 'interrupted',
      assistantText: 'Partial answer',
      resumeAvailable: true
    })
  })

  it('leaves completed runs completed after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alke-chat-complete-'))
    const filePath = join(directory, 'runtime.json')
    const first = makeStore(filePath)
    begin(first)
    first.appendText('Final answer')
    first.complete()

    const restored = makeStore(filePath)
    expect(restored.restore()).toMatchObject({
      phase: 'completed',
      assistantText: 'Final answer'
    })
  })

  it('ignores corrupt and unknown-version snapshot files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alke-chat-corrupt-'))
    const filePath = join(directory, 'runtime.json')

    writeFileSync(filePath, '{broken')
    expect(makeStore(filePath).restore()).toBeNull()

    writeFileSync(filePath, JSON.stringify({ version: 99 }))
    expect(makeStore(filePath).restore()).toBeNull()
  })

  it('throttles text persistence but flushes lifecycle transitions immediately', () => {
    vi.useFakeTimers()
    const store = makeStore()
    begin(store)
    store.appendText('One')
    store.appendText(' two')

    expect(() => readFileSync(store.filePath)).not.toThrow()
    expect(JSON.parse(readFileSync(store.filePath, 'utf8')).assistantText).toBe('')

    vi.advanceTimersByTime(250)
    expect(JSON.parse(readFileSync(store.filePath, 'utf8')).assistantText).toBe('One two')

    store.fail('Claude stopped unexpectedly')
    expect(JSON.parse(readFileSync(store.filePath, 'utf8'))).toMatchObject({
      phase: 'failed',
      error: 'Claude stopped unexpectedly'
    })
  })
})
