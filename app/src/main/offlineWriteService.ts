import { randomUUID } from 'node:crypto'
import {
  OfflineWriteQueue,
  isTransientWriteError,
  type OfflineQueueStatus,
  type QueuedWriteOperation
} from './offlineQueue'

export interface QueuedWriteReceipt {
  queued: true
  operationId: string
}

export type OfflineWriteExecutor = (operation: QueuedWriteOperation) => Promise<unknown>

/** Coordinates first-attempt writes with the durable replay queue. */
export class OfflineWriteService {
  private readonly queue: OfflineWriteQueue
  private sequence: Promise<void> = Promise.resolve()

  constructor(
    filePath: string,
    private readonly execute: OfflineWriteExecutor,
    onStatus?: (status: OfflineQueueStatus) => void,
    private readonly idFactory: () => string = randomUUID
  ) {
    this.queue = new OfflineWriteQueue(
      filePath,
      async (operation) => { await this.execute(operation) },
      onStatus
    )
  }

  status(): OfflineQueueStatus {
    return this.queue.status()
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(task, task)
    this.sequence = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async run<T>(type: string, args: unknown[]): Promise<T | QueuedWriteReceipt> {
    const operation: QueuedWriteOperation = {
      id: this.idFactory(),
      type,
      args,
      createdAt: new Date().toISOString(),
      attempts: 0,
      state: 'pending',
      lastError: null
    }
    return this.serialize(async () => {
      // Persist first: if the app exits after Postgres commits but before the
      // response arrives, the same stable mutation id is replayed on restart.
      await this.queue.enqueue(operation, false)
      try {
        const result = (await this.execute(operation)) as T
        await this.queue.remove(operation.id)
        return result
      } catch (error) {
        if (!isTransientWriteError(error)) {
          await this.queue.remove(operation.id)
          throw error
        }
        await this.queue.recordTransientFailure(operation.id, error)
        return { queued: true, operationId: operation.id }
      }
    })
  }

  flush(): Promise<void> {
    return this.serialize(() => this.queue.flush())
  }

  retryFailed(): Promise<void> {
    return this.serialize(() => this.queue.retryFailed())
  }
}
