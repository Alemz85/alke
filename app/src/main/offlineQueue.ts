import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type QueuedWriteState = 'pending' | 'failed'

export interface QueuedWriteOperation {
  id: string
  type: string
  args: unknown[]
  createdAt: string
  attempts: number
  state: QueuedWriteState
  lastError: string | null
  // ISO timestamp of the most recent execute() attempt (any outcome). Absent
  // (undefined) for operations persisted by an older queue-file version or
  // never yet attempted — treated as "no backoff owed" by nextEligibleAt.
  lastAttemptAt?: string
}

export interface OfflineQueueStatus {
  pending: number
  failed: number
  syncing: boolean
  lastError: string | null
}

interface PersistedQueue {
  version: 1
  items: QueuedWriteOperation[]
}

type ExecuteWrite = (operation: QueuedWriteOperation) => Promise<void>
type StatusListener = (status: OfflineQueueStatus) => void

/** Renders any thrown value as a readable string — Error, string, or otherwise. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Numeric HTTP status or errno-style code carried on an error or its `.cause`. */
function errorStatusCode(error: unknown): number | string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { status?: unknown; code?: unknown; cause?: unknown }
  if (typeof candidate.status === 'number') return candidate.status
  if (typeof candidate.code === 'string' || typeof candidate.code === 'number') {
    return candidate.code
  }
  if (candidate.cause !== undefined && candidate.cause !== error) {
    return errorStatusCode(candidate.cause)
  }
  return undefined
}

const TRANSIENT_ERRNO_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE'
])
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504])

/**
 * Only failures that can plausibly succeed unchanged are safe to queue.
 * Checks structured status/code fields first (reliable, locale/wording-proof);
 * falls back to message-fragment matching for errors that arrive already
 * stringified (e.g. db.ts wraps most Supabase errors as `new Error(\`fn: ${msg}\`)`,
 * which discards the original .code/.status).
 */
export function isTransientWriteError(error: unknown): boolean {
  const code = errorStatusCode(error)
  if (typeof code === 'number' && TRANSIENT_HTTP_STATUSES.has(code)) return true
  if (typeof code === 'string' && TRANSIENT_ERRNO_CODES.has(code)) return true

  const message = errorMessage(error).toLowerCase()
  return [
    'fetch failed',
    'failed to fetch',
    'network error',
    'network request failed',
    'enotfound',
    'econnrefused',
    'econnreset',
    'etimedout',
    'timeout',
    'timed out',
    'socket hang up',
    'status 429',
    'rate limit 429',
    'status 500',
    'status 502',
    'status 503',
    'status 504',
    'bad gateway',
    'service unavailable',
    'gateway timeout'
  ].some((fragment) => message.includes(fragment))
}

// Simple exponential backoff, capped at 10 minutes: 30s, 60s, 120s, ... A
// transiently-failing head of the queue is retried with growing spacing
// instead of being hammered on every 30s flush tick.
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 10 * 60 * 1000

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS)
}

/** Earliest time this item is next eligible for a replay attempt. */
function nextEligibleAt(item: QueuedWriteOperation): number {
  if (!item.lastAttemptAt || item.attempts === 0) return 0
  const last = Date.parse(item.lastAttemptAt)
  if (Number.isNaN(last)) return 0
  return last + backoffMs(item.attempts)
}

/**
 * Small durable FIFO owned by Electron's main process. The queue file is
 * replaced atomically so a crash cannot leave half-written JSON behind.
 */
export class OfflineWriteQueue {
  private queue: QueuedWriteOperation[] = []
  private flushPromise: Promise<void> | null = null
  // Set when the queue file existed but failed to parse/validate on load, so
  // status() can surface it even though the in-memory queue itself is empty
  // (there are no items to carry a per-item lastError). Cleared the moment any
  // real operation produces its own lastError, so it doesn't linger forever.
  private loadError: string | null = null
  // Tracks the fire-and-forget quarantine rename from load() (if any), so
  // persist() can wait for it first — otherwise a persist() racing ahead of
  // the still-in-flight rename of the SAME path could interleave badly (e.g.
  // clobber the freshly-written queue file, or rename over it mid-write).
  private quarantinePromise: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly execute: ExecuteWrite,
    private readonly onStatus?: StatusListener
  ) {
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.error('[offline-queue] could not read queue:', errorMessage(error))
      this.emit()
      return
    }

    try {
      const parsed = JSON.parse(raw) as PersistedQueue
      if (parsed.version === 1 && Array.isArray(parsed.items)) {
        this.queue = parsed.items
      } else {
        throw new Error('unrecognized queue file shape')
      }
    } catch (error) {
      // Corrupt or unreadable queue file: preserve it under a distinct name
      // instead of silently starting empty, so the bad file survives for
      // inspection and doesn't get overwritten by the next persist(). Best
      // effort — if the rename itself fails, this is still surfaced below.
      const message = errorMessage(error)
      this.loadError = `offline queue file was corrupt and has been reset (${message})`
      console.error('[offline-queue]', this.loadError)
      const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`
      this.quarantinePromise = rename(this.filePath, quarantinePath).catch((renameError) => {
        console.error(
          '[offline-queue] could not quarantine corrupt queue file:',
          errorMessage(renameError)
        )
      })
      this.queue = []
    }
    this.emit()
  }

  private async persist(): Promise<void> {
    await this.quarantinePromise
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const document: PersistedQueue = { version: 1, items: this.queue }
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.filePath)
  }

  private emit(): void {
    this.onStatus?.(this.status())
  }

  status(): OfflineQueueStatus {
    const pending = this.queue.filter((item) => item.state === 'pending').length
    const failed = this.queue.filter((item) => item.state === 'failed').length
    const lastError = this.mostRecentError()
    return { pending, failed, syncing: this.flushPromise !== null, lastError }
  }

  /**
   * The MOST RECENT failure across the queue, ranked by lastAttemptAt — not
   * simply the first item carrying an error (queue order is creation order,
   * which is unrelated to recency of failure). Falls back to a load-time
   * corruption error when there are no per-item errors to show, so a corrupt
   * queue file is still visible even though it left no items behind.
   */
  private mostRecentError(): string | null {
    const withErrors = this.queue.filter((item) => item.lastError)
    if (withErrors.length === 0) return this.loadError
    // >= (not >): on a tied timestamp (two attempts landing in the same
    // millisecond, easily hit on a fast machine/test), prefer whichever this
    // scan reaches last — flushPending() always attempts items in the same
    // (creation) order the queue array holds them in, so a tie's later array
    // position really did fail no earlier than the tied one before it.
    const mostRecent = withErrors.reduce((latest, item) => {
      const latestAt = latest.lastAttemptAt ? Date.parse(latest.lastAttemptAt) : -Infinity
      const itemAt = item.lastAttemptAt ? Date.parse(item.lastAttemptAt) : -Infinity
      return itemAt >= latestAt ? item : latest
    })
    return mostRecent.lastError
  }

  items(): QueuedWriteOperation[] {
    return this.queue.map((item) => ({ ...item, args: [...item.args] }))
  }

  async enqueue(operation: QueuedWriteOperation, notify = true): Promise<void> {
    if (this.queue.some((item) => item.id === operation.id)) return
    this.queue.push(operation)
    this.queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    await this.persist()
    if (notify) this.emit()
  }

  async remove(operationId: string): Promise<void> {
    const next = this.queue.filter((item) => item.id !== operationId)
    if (next.length === this.queue.length) return
    this.queue = next
    // A successful removal is live evidence the queue file/DB connection is
    // healthy again — drop the stale load-time corruption banner if one's
    // still showing.
    this.loadError = null
    await this.persist()
    this.emit()
  }

  async recordTransientFailure(operationId: string, error: unknown): Promise<void> {
    const operation = this.queue.find((item) => item.id === operationId)
    if (!operation) return
    operation.attempts += 1
    operation.lastError = errorMessage(error)
    operation.lastAttemptAt = new Date().toISOString()
    operation.state = 'pending'
    await this.persist()
    this.emit()
  }

  async retryFailed(): Promise<void> {
    for (const item of this.queue) {
      if (item.state === 'failed') {
        item.state = 'pending'
        // Manual, explicit retry — bypass backoff rather than making the user
        // wait out a schedule that was computed for the unattended 30s flush.
        item.lastAttemptAt = undefined
      }
    }
    await this.persist()
    this.emit()
    await this.flush()
  }

  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise
    this.flushPromise = this.flushPending().finally(() => {
      this.flushPromise = null
      this.emit()
    })
    this.emit()
    return this.flushPromise
  }

  private async flushPending(): Promise<void> {
    for (const item of [...this.queue]) {
      if (item.state !== 'pending') continue
      // A previously-failed item that's still within its backoff window is
      // skipped (not attempted) so a persistently-down remote isn't hammered
      // every 30s flush tick — but skipping doesn't block items behind it,
      // since we never learned anything new about ordering from a skip.
      if (Date.now() < nextEligibleAt(item)) continue
      try {
        await this.execute(item)
        this.queue = this.queue.filter((candidate) => candidate.id !== item.id)
        this.loadError = null
        await this.persist()
        this.emit()
      } catch (error) {
        item.attempts += 1
        item.lastError = errorMessage(error)
        item.lastAttemptAt = new Date().toISOString()
        if (isTransientWriteError(error)) {
          await this.persist()
          this.emit()
          // A genuine (attempted, not skipped) transient failure still halts
          // the replay here to preserve strict creation-order delivery for
          // whatever follows it in the queue.
          break
        }
        item.state = 'failed'
        await this.persist()
        this.emit()
      }
    }
  }
}
