import { describe, expect, it } from 'vitest'
import type { GymSession } from '@shared/types'
import {
  isQueuedWriteReceipt,
  patchById,
  removeById,
  replaceById,
  sessionFallsWithinQuery
} from '../optimisticEntities'

describe('optimistic entity helpers', () => {
  const rows = [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }]

  it('recognizes only valid queue receipts', () => {
    expect(isQueuedWriteReceipt({ queued: true, operationId: 'op' })).toBe(true)
    expect(isQueuedWriteReceipt({ queued: false, operationId: 'op' })).toBe(false)
    expect(isQueuedWriteReceipt(null)).toBe(false)
  })

  it('patches, removes and replaces records without mutating the input', () => {
    expect(patchById(rows, 'a', { status: 'completed' })[0].status).toBe('completed')
    expect(removeById(rows, 'a')).toEqual([{ id: 'b', status: 'active' }])
    expect(replaceById(rows, 'a', { id: 'server', status: 'saved' })).toEqual([
      { id: 'server', status: 'saved' },
      { id: 'b', status: 'active' }
    ])
    expect(rows[0].status).toBe('active')
  })

  it('matches gym sessions only to cached ranges containing their instant', () => {
    const session = { performed_at: '2026-07-13T12:00:00.000Z' } as GymSession
    expect(sessionFallsWithinQuery(
      ['health', 'gym', 'sessions', '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z'],
      session
    )).toBe(true)
    expect(sessionFallsWithinQuery(
      ['health', 'gym', 'sessions', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z'],
      session
    )).toBe(false)
  })
})
