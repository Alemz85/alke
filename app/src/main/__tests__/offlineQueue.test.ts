import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  OfflineWriteQueue,
  isTransientWriteError,
  type QueuedWriteOperation
} from '../offlineQueue'

function operation(id: string): QueuedWriteOperation {
  return {
    id,
    type: 'setPlanItemCheck',
    args: ['item-1', '2026-07-13', true],
    createdAt: '2026-07-13T12:00:00.000Z',
    attempts: 0,
    state: 'pending',
    lastError: null
  }
}

describe('isTransientWriteError', () => {
  it.each([
    new TypeError('fetch failed'),
    new Error('connect ETIMEDOUT'),
    new Error('request failed with status 503'),
    new Error('rate limit 429')
  ])('queues transport and transient-service failures', (error) => {
    expect(isTransientWriteError(error)).toBe(true)
  })

  it.each([
    new Error('invalid note'),
    new Error('duplicate key violates unique constraint'),
    new Error('permission denied')
  ])('does not hide permanent write failures', (error) => {
    expect(isTransientWriteError(error)).toBe(false)
  })
})

describe('OfflineWriteQueue', () => {
  it('persists an accepted operation and loads it after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    const file = join(directory, 'queue.json')
    const first = new OfflineWriteQueue(file, async () => undefined)

    await first.enqueue(operation('op-1'))

    const second = new OfflineWriteQueue(file, async () => undefined)
    expect(second.status()).toMatchObject({ pending: 1, failed: 0, syncing: false })
    expect(JSON.parse(readFileSync(file, 'utf8')).items[0].id).toBe('op-1')
  })

  it('replays pending writes in creation order and removes successful entries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    const seen: string[] = []
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async (item) => {
      seen.push(item.id)
    })
    await queue.enqueue(operation('op-1'))
    await queue.enqueue({ ...operation('op-2'), createdAt: '2026-07-13T12:01:00.000Z' })

    await queue.flush()

    expect(seen).toEqual(['op-1', 'op-2'])
    expect(queue.status()).toMatchObject({ pending: 0, failed: 0 })
  })

  it('stops on a transient replay failure and keeps the remaining order', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async () => {
      throw new TypeError('fetch failed')
    })
    await queue.enqueue(operation('op-1'))
    await queue.enqueue(operation('op-2'))

    await queue.flush()

    expect(queue.items().map((item) => item.id)).toEqual(['op-1', 'op-2'])
    expect(queue.items()[0]).toMatchObject({ state: 'pending', attempts: 1 })
    expect(queue.status().lastError).toContain('fetch failed')
  })

  it('retains a permanent replay failure for attention but continues later writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    const seen: string[] = []
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async (item) => {
      seen.push(item.id)
      if (item.id === 'op-1') throw new Error('constraint violation')
    })
    await queue.enqueue(operation('op-1'))
    await queue.enqueue(operation('op-2'))

    await queue.flush()

    expect(seen).toEqual(['op-1', 'op-2'])
    expect(queue.items()).toHaveLength(1)
    expect(queue.items()[0]).toMatchObject({ id: 'op-1', state: 'failed', attempts: 1 })
    expect(queue.status()).toMatchObject({ pending: 0, failed: 1 })
  })

  it('coalesces concurrent flush calls into one replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    let executions = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async () => {
      executions += 1
      await gate
    })
    await queue.enqueue(operation('op-1'))

    const first = queue.flush()
    const second = queue.flush()
    release()
    await Promise.all([first, second])

    expect(executions).toBe(1)
  })
})
