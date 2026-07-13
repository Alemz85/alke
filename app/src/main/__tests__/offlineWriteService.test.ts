import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OfflineWriteService } from '../offlineWriteService'

describe('OfflineWriteService', () => {
  it('persists an operation before its first network attempt completes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-service-'))
    const queuePath = join(directory, 'queue.json')
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const service = new OfflineWriteService(
      queuePath,
      async () => {
        markStarted?.()
        await blocked
        return { id: 'saved' }
      },
      undefined,
      () => '00000000-0000-4000-8000-000000000000'
    )

    const write = service.run('addGymTemplate', [{}])
    await started

    expect(readFileSync(queuePath, 'utf8')).toContain('00000000-0000-4000-8000-000000000000')
    release?.()
    await expect(write).resolves.toEqual({ id: 'saved' })
  })

  it('returns the live result without retaining a queue item', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-service-'))
    const service = new OfflineWriteService(
      join(directory, 'queue.json'),
      async () => ({ id: 'saved' }),
      undefined,
      () => '11111111-1111-4111-8111-111111111111'
    )

    await expect(service.run('addInjuryLog', [{ note: 'Fine' }])).resolves.toEqual({ id: 'saved' })
    expect(service.status().pending).toBe(0)
  })

  it('durably accepts a transiently failed write and returns a queued receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-service-'))
    const service = new OfflineWriteService(
      join(directory, 'queue.json'),
      async () => { throw new TypeError('fetch failed') },
      undefined,
      () => '22222222-2222-4222-8222-222222222222'
    )

    await expect(service.run('setPlanItemCheck', ['item', '2026-07-13', true])).resolves.toEqual({
      queued: true,
      operationId: '22222222-2222-4222-8222-222222222222'
    })
    expect(service.status().pending).toBe(1)
  })

  it('rejects validation and permission failures instead of queueing them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-service-'))
    const service = new OfflineWriteService(join(directory, 'queue.json'), async () => {
      throw new Error('invalid note')
    })

    await expect(service.run('addInjuryLog', [{}])).rejects.toThrow('invalid note')
    expect(service.status().pending).toBe(0)
  })

  it('replays a queued operation with the same stable operation id', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'health-write-service-'))
    const seen: string[] = []
    let online = false
    const service = new OfflineWriteService(
      join(directory, 'queue.json'),
      async (operation) => {
        seen.push(operation.id)
        if (!online) throw new TypeError('fetch failed')
        return undefined
      },
      undefined,
      () => '33333333-3333-4333-8333-333333333333'
    )
    await service.run('addGymTemplate', [{}])
    online = true

    await service.flush()

    expect(seen).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '33333333-3333-4333-8333-333333333333'
    ])
    expect(service.status().pending).toBe(0)
  })
})
