import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

  it('classifies via a numeric HTTP status before falling back to message text', () => {
    const error = Object.assign(new Error('Internal Server Error'), { status: 500 })
    expect(isTransientWriteError(error)).toBe(true)
  })

  it('classifies via an errno-style code on the error itself', () => {
    const error = Object.assign(new Error('request failed'), { code: 'ECONNRESET' })
    expect(isTransientWriteError(error)).toBe(true)
  })

  it('classifies via an errno-style code nested under .cause (undici fetch shape)', () => {
    const error = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' }
    })
    expect(isTransientWriteError(error)).toBe(true)
  })

  it('does not misclassify a non-transient numeric status', () => {
    const error = Object.assign(new Error('Not Found'), { status: 404 })
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

  it('reports the MOST RECENT failure, not the first item created', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    // Transient (TypeError 'fetch failed') so each item stays 'pending' and
    // carries its failure forward rather than flipping to 'failed'.
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async (item) => {
      throw new TypeError(`fetch failed: boom from ${item.id}`)
    })
    // op-1 was created first but will fail LAST in wall-clock time if we
    // trigger its failure in a later flush than op-2's.
    await queue.enqueue(operation('op-1'))
    await queue.flush()
    expect(queue.status().lastError).toContain('boom from op-1')

    await queue.enqueue({ ...operation('op-2'), createdAt: '2026-07-13T12:01:00.000Z' })
    // op-1 is still within its backoff window, so this flush only attempts op-2.
    await queue.flush()
    expect(queue.status().lastError).toContain('boom from op-2')
  })

  it('stringifies a non-Error thrown value into lastError', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { reason: 'network down', code: 'ECONNRESET' }
    })
    await queue.enqueue(operation('op-1'))
    await queue.flush()

    const lastError = queue.status().lastError
    expect(lastError).not.toBeNull()
    expect(lastError).toContain('network down')
    expect(lastError).toContain('ECONNRESET')
  })

  it('skips a backed-off item without attempting it again on the next flush tick', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    let attempts = 0
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async () => {
      attempts += 1
      throw new TypeError('fetch failed')
    })
    await queue.enqueue(operation('op-1'))

    await queue.flush()
    expect(attempts).toBe(1)

    // Immediately flushing again (simulating the next 30s tick) must NOT
    // re-attempt op-1 — it's within backoff (base 30s after 1 attempt).
    await queue.flush()
    expect(attempts).toBe(1)
    expect(queue.items()[0]).toMatchObject({ attempts: 1, state: 'pending' })
  })

  it("doesn't let a backed-off head block a DIFFERENT item behind it", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    const seen: string[] = []
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async (item) => {
      if (item.id === 'op-1') throw new TypeError('fetch failed')
      seen.push(item.id)
    })
    await queue.enqueue(operation('op-1'))
    await queue.flush() // op-1 fails once and enters backoff

    await queue.enqueue({ ...operation('op-2'), createdAt: '2026-07-13T12:01:00.000Z' })
    await queue.flush() // op-1 is skipped (backed off); op-2 is attempted

    expect(seen).toEqual(['op-2'])
    expect(queue.items().map((i) => i.id)).toEqual(['op-1'])
  })

  it('bypasses backoff on an explicit retryFailed() call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    let attempts = 0
    const queue = new OfflineWriteQueue(join(directory, 'queue.json'), async () => {
      attempts += 1
      if (attempts === 1) throw new Error('permanent failure')
    })
    await queue.enqueue(operation('op-1'))
    await queue.flush()
    expect(queue.items()[0].state).toBe('failed')

    await queue.retryFailed()
    expect(attempts).toBe(2)
    expect(queue.status()).toMatchObject({ pending: 0, failed: 0 })
  })

  it('quarantines a corrupt queue file instead of silently starting empty', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-queue-'))
    const file = join(directory, 'queue.json')
    writeFileSync(file, '{ not valid json')

    const queue = new OfflineWriteQueue(file, async () => undefined)

    expect(queue.status()).toMatchObject({ pending: 0, failed: 0 })
    expect(queue.status().lastError).toMatch(/corrupt/i)

    // The quarantine rename is fire-and-forget from the constructor; enqueue()
    // awaits persist(), which internally awaits that same rename first — so
    // awaiting an enqueue is a reliable way to know the rename has settled.
    await queue.enqueue(operation('op-1'))

    expect(existsSync(file)).toBe(true) // recreated by persist() after quarantine
    const quarantined = readdirSync(directory).filter((name) => name.startsWith('queue.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
  })
})
