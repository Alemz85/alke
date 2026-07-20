import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import type {
  ChatAttachment,
  ChatMode,
  ChatRuntimeEnvelope,
  ChatRuntimePhase,
  ChatRuntimeSnapshot,
  ChatStreamEvent,
  ChatWorkLogEntry
} from '@shared/types'

export const MAX_CHAT_RUNTIME_BYTES = 2 * 1024 * 1024
export const MAX_CHAT_RUNTIME_PARTIAL_BYTES = 1024 * 1024
export const MAX_CHAT_WORK_ENTRIES = 200
export const MAX_CHAT_WORK_DETAIL_BYTES = 2 * 1024

const MAX_CHAT_WORK_LOG_BYTES = 256 * 1024
const MAX_CHAT_RUNTIME_MESSAGE_BYTES = 256 * 1024
const MAX_CHAT_RUNTIME_ERROR_BYTES = 16 * 1024
const MAX_CHAT_WORK_LABEL_BYTES = 512
const PERSIST_THROTTLE_MS = 200

const PHASES = new Set<ChatRuntimePhase>([
  'starting',
  'running',
  'stopping',
  'completed',
  'failed',
  'interrupted'
])
const MODES = new Set<ChatMode>(['analysis', 'injuries', 'goals'])

export interface BeginChatRuntimeInput {
  sessionId: string
  message: string
  mode: ChatMode
  attachments: ChatAttachment[]
}

interface RuntimeDependencies {
  now?: () => Date
  id?: () => string
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) return value
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeAttachment(value: unknown): ChatAttachment | null {
  if (!isRecord(value)) return null
  if (
    typeof value.path !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isFinite(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    return null
  }
  return {
    path: truncateUtf8(value.path, 16 * 1024),
    name: truncateUtf8(value.name, 2 * 1024),
    sizeBytes: value.sizeBytes
  }
}

function sanitizeWorkEntry(value: unknown): ChatWorkLogEntry | null {
  if (!isRecord(value)) return null
  if (
    typeof value.sequence !== 'number' ||
    !Number.isInteger(value.sequence) ||
    typeof value.at !== 'string' ||
    (value.kind !== 'status' && value.kind !== 'tool') ||
    typeof value.label !== 'string' ||
    typeof value.detail !== 'string'
  ) {
    return null
  }
  return {
    sequence: value.sequence,
    at: value.at,
    kind: value.kind,
    label: truncateUtf8(value.label, MAX_CHAT_WORK_LABEL_BYTES),
    detail: truncateUtf8(value.detail, MAX_CHAT_WORK_DETAIL_BYTES)
  }
}

function boundWorkLog(entries: ChatWorkLogEntry[]): ChatWorkLogEntry[] {
  const bounded = entries.slice(-MAX_CHAT_WORK_ENTRIES)
  while (bounded.length > 0 && Buffer.byteLength(JSON.stringify(bounded)) > MAX_CHAT_WORK_LOG_BYTES) {
    bounded.shift()
  }
  return bounded
}

function validateSnapshot(value: unknown): ChatRuntimeSnapshot | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (
    typeof value.generationId !== 'string' ||
    !value.generationId ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    typeof value.originalMessage !== 'string' ||
    !MODES.has(value.mode as ChatMode) ||
    typeof value.startedAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !PHASES.has(value.phase as ChatRuntimePhase) ||
    typeof value.assistantText !== 'string' ||
    (value.error !== null && typeof value.error !== 'string') ||
    typeof value.resumeAvailable !== 'boolean' ||
    typeof value.lastSequence !== 'number' ||
    !Number.isInteger(value.lastSequence) ||
    value.lastSequence < 0 ||
    !Array.isArray(value.attachments) ||
    !Array.isArray(value.workLog)
  ) {
    return null
  }

  const attachments = value.attachments.map(sanitizeAttachment)
  const workLog = value.workLog.map(sanitizeWorkEntry)
  if (attachments.some((entry) => entry === null) || workLog.some((entry) => entry === null)) {
    return null
  }

  return {
    version: 1,
    generationId: value.generationId,
    sessionId: value.sessionId,
    originalMessage: truncateUtf8(value.originalMessage, MAX_CHAT_RUNTIME_MESSAGE_BYTES),
    mode: value.mode as ChatMode,
    attachments: attachments as ChatAttachment[],
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    phase: value.phase as ChatRuntimePhase,
    assistantText: truncateUtf8(value.assistantText, MAX_CHAT_RUNTIME_PARTIAL_BYTES),
    workLog: boundWorkLog(workLog as ChatWorkLogEntry[]),
    error:
      typeof value.error === 'string'
        ? truncateUtf8(value.error, MAX_CHAT_RUNTIME_ERROR_BYTES)
        : null,
    resumeAvailable: value.resumeAvailable,
    lastSequence: value.lastSequence
  }
}

export class ChatRuntimeStore {
  private current: ChatRuntimeSnapshot | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => Date
  private readonly id: () => string

  constructor(
    public readonly filePath: string,
    dependencies: RuntimeDependencies = {}
  ) {
    this.now = dependencies.now ?? (() => new Date())
    this.id = dependencies.id ?? randomUUID
  }

  restore(): ChatRuntimeSnapshot | null {
    if (!existsSync(this.filePath)) return null

    try {
      const contents = readFileSync(this.filePath)
      if (contents.byteLength > MAX_CHAT_RUNTIME_BYTES) return null
      const snapshot = validateSnapshot(JSON.parse(contents.toString('utf8')))
      if (!snapshot) return null
      this.current = snapshot

      if (['starting', 'running', 'stopping'].includes(snapshot.phase)) {
        this.transition('interrupted', {
          kind: 'status',
          label: 'Interrupted',
          detail: 'Alke closed before the response completed.'
        })
      }
      return this.snapshot()
    } catch {
      this.current = null
      return null
    }
  }

  snapshot(): ChatRuntimeSnapshot | null {
    return this.current ? structuredClone(this.current) : null
  }

  begin(input: BeginChatRuntimeInput): ChatRuntimeEnvelope {
    if (this.current && ['starting', 'running', 'stopping'].includes(this.current.phase)) {
      throw new Error('A chat response is already running.')
    }

    const at = this.now().toISOString()
    this.current = {
      version: 1,
      generationId: this.id(),
      sessionId: input.sessionId,
      originalMessage: truncateUtf8(input.message, MAX_CHAT_RUNTIME_MESSAGE_BYTES),
      mode: input.mode,
      attachments: structuredClone(input.attachments),
      startedAt: at,
      updatedAt: at,
      phase: 'starting',
      assistantText: '',
      workLog: [],
      error: null,
      resumeAvailable: false,
      lastSequence: 0
    }
    const envelope = this.emit({ kind: 'status', label: 'Starting' })
    this.flush()
    return envelope
  }

  markRunning(): ChatRuntimeEnvelope {
    return this.transition('running', { kind: 'status', label: 'Working' })
  }

  setResumeAvailable(available: boolean): void {
    const current = this.requireCurrent()
    current.resumeAvailable = available
    current.updatedAt = this.now().toISOString()
    this.flush()
  }

  appendText(text: string): ChatRuntimeEnvelope {
    const current = this.requireCurrent()
    if (current.phase === 'starting') current.phase = 'running'
    current.assistantText = truncateUtf8(
      current.assistantText + text,
      MAX_CHAT_RUNTIME_PARTIAL_BYTES
    )
    const envelope = this.emit({ kind: 'text', text })
    this.scheduleFlush()
    return envelope
  }

  appendWork(entry: Omit<ChatWorkLogEntry, 'sequence' | 'at'>): ChatRuntimeEnvelope {
    const current = this.requireCurrent()
    if (current.phase === 'starting') current.phase = 'running'
    const label = truncateUtf8(entry.label, MAX_CHAT_WORK_LABEL_BYTES)
    const detail = truncateUtf8(entry.detail, MAX_CHAT_WORK_DETAIL_BYTES)
    const sequence = current.lastSequence + 1
    current.workLog = boundWorkLog([
      ...current.workLog,
      {
        sequence,
        at: this.now().toISOString(),
        kind: entry.kind,
        label,
        detail
      }
    ])
    const envelope = this.emit({ kind: 'tool', name: label, detail })
    this.scheduleFlush()
    return envelope
  }

  markStopping(): ChatRuntimeEnvelope {
    return this.transition('stopping', { kind: 'status', label: 'Stopping' })
  }

  interrupt(message = 'Alke closed before the response completed.'): ChatRuntimeEnvelope {
    return this.transition('interrupted', {
      kind: 'status',
      label: 'Interrupted',
      detail: message
    })
  }

  complete(): ChatRuntimeEnvelope {
    return this.transition('completed', { kind: 'done' })
  }

  fail(message: string): ChatRuntimeEnvelope {
    const current = this.requireCurrent()
    current.error = truncateUtf8(message, MAX_CHAT_RUNTIME_ERROR_BYTES)
    return this.transition('failed', { kind: 'error', message: current.error })
  }

  flush(): void {
    if (!this.current) return
    this.cancelScheduledFlush()
    const serialized = JSON.stringify(this.current)
    if (Buffer.byteLength(serialized) > MAX_CHAT_RUNTIME_BYTES) {
      throw new Error('chat runtime snapshot exceeded 2 MiB')
    }

    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
  }

  dispose(interruptActive = false): void {
    if (
      interruptActive &&
      this.current &&
      ['starting', 'running', 'stopping'].includes(this.current.phase)
    ) {
      this.interrupt()
    } else {
      this.flush()
    }
    this.cancelScheduledFlush()
  }

  private transition(phase: ChatRuntimePhase, event: ChatStreamEvent): ChatRuntimeEnvelope {
    const current = this.requireCurrent()
    current.phase = phase
    const envelope = this.emit(event)
    this.flush()
    return envelope
  }

  private emit(event: ChatStreamEvent): ChatRuntimeEnvelope {
    const current = this.requireCurrent()
    current.lastSequence += 1
    current.updatedAt = this.now().toISOString()
    return {
      generationId: current.generationId,
      sessionId: current.sessionId,
      sequence: current.lastSequence,
      event
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, PERSIST_THROTTLE_MS)
    this.timer.unref?.()
  }

  private cancelScheduledFlush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private requireCurrent(): ChatRuntimeSnapshot {
    if (!this.current) throw new Error('No chat runtime is active.')
    return this.current
  }
}
