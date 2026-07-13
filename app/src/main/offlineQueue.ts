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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Only failures that can plausibly succeed unchanged are safe to queue. */
export function isTransientWriteError(error: unknown): boolean {
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

/**
 * Small durable FIFO owned by Electron's main process. The queue file is
 * replaced atomically so a crash cannot leave half-written JSON behind.
 */
export class OfflineWriteQueue {
  private queue: QueuedWriteOperation[] = []
  private flushPromise: Promise<void> | null = null

  constructor(
    private readonly filePath: string,
    private readonly execute: ExecuteWrite,
    private readonly onStatus?: StatusListener
  ) {
    this.load()
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedQueue
      if (parsed.version === 1 && Array.isArray(parsed.items)) this.queue = parsed.items
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.error('[offline-queue] could not load queue:', errorMessage(error))
    }
    this.emit()
  }

  private async persist(): Promise<void> {
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
    const lastError = this.queue.find((item) => item.lastError)?.lastError ?? null
    return { pending, failed, syncing: this.flushPromise !== null, lastError }
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
    await this.persist()
    this.emit()
  }

  async recordTransientFailure(operationId: string, error: unknown): Promise<void> {
    const operation = this.queue.find((item) => item.id === operationId)
    if (!operation) return
    operation.attempts += 1
    operation.lastError = errorMessage(error)
    operation.state = 'pending'
    await this.persist()
    this.emit()
  }

  async retryFailed(): Promise<void> {
    for (const item of this.queue) {
      if (item.state === 'failed') item.state = 'pending'
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
      try {
        await this.execute(item)
        this.queue = this.queue.filter((candidate) => candidate.id !== item.id)
        await this.persist()
        this.emit()
      } catch (error) {
        item.attempts += 1
        item.lastError = errorMessage(error)
        if (isTransientWriteError(error)) {
          await this.persist()
          this.emit()
          break
        }
        item.state = 'failed'
        await this.persist()
        this.emit()
      }
    }
  }
}
