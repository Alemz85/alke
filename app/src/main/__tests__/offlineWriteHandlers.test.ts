import { describe, expect, it, vi } from 'vitest'
import { executeOfflineWrite, type OfflineWriteDatabase } from '../offlineWriteHandlers'
import type { QueuedWriteOperation } from '../offlineQueue'

function operation(type: string, args: unknown[]): QueuedWriteOperation {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    type,
    args,
    createdAt: '2026-07-13T12:00:00.000Z',
    attempts: 0,
    state: 'pending',
    lastError: null
  }
}

function database(): OfflineWriteDatabase {
  return {
    addInjuryLog: vi.fn(async () => ({})),
    deleteInjuryLog: vi.fn(async () => undefined),
    updateInjuryStatus: vi.fn(async () => ({})),
    deleteInjury: vi.fn(async () => undefined),
    updateInjuryPlanStart: vi.fn(async () => ({})),
    updateInjuryStartedAt: vi.fn(async () => ({})),
    setPlanItemCheck: vi.fn(async () => undefined),
    addGymTemplate: vi.fn(async () => ({})),
    updateGymTemplate: vi.fn(async () => ({})),
    deleteGymTemplate: vi.fn(async () => undefined),
    createGymTemplateVersion: vi.fn(async () => ({})),
    startGymTemplateRun: vi.fn(async () => ({})),
    completeGymTemplateRun: vi.fn(async () => ({})),
    addGymSession: vi.fn(async () => ({})),
    updateGymSession: vi.fn(async () => ({})),
    deleteGymSession: vi.fn(async () => undefined),
    addProtein: vi.fn(async () => ({})),
    setProtein: vi.fn(async () => ({}))
  }
}

describe('executeOfflineWrite', () => {
  it('passes the stable operation id into retry-sensitive creates', async () => {
    const db = database()
    const note = { injury_id: 'injury', note: 'Fine' }
    const template = { name: 'A', notes: null, items: [] }
    const session = { sets: [] }

    await executeOfflineWrite(db, operation('addInjuryLog', [note]))
    await executeOfflineWrite(db, operation('addGymTemplate', [template]))
    await executeOfflineWrite(db, operation('createGymTemplateVersion', ['base', template]))
    await executeOfflineWrite(db, operation('addGymSession', [session]))
    await executeOfflineWrite(db, operation('addProtein', ['2026-07-13', 40]))

    expect(db.addInjuryLog).toHaveBeenCalledWith(note, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(db.addGymTemplate).toHaveBeenCalledWith(template, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(db.createGymTemplateVersion).toHaveBeenCalledWith(
      'base',
      template,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    expect(db.addGymSession).toHaveBeenCalledWith(session, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(db.addProtein).toHaveBeenCalledWith('2026-07-13', 40, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  it('replays ordered state changes using their original arguments', async () => {
    const db = database()
    await executeOfflineWrite(db, operation('setPlanItemCheck', ['item', '2026-07-13', false]))
    await executeOfflineWrite(db, operation('updateGymTemplate', ['template', { name: 'B' }]))
    await executeOfflineWrite(db, operation('deleteGymSession', ['session']))
    await executeOfflineWrite(db, operation('deleteInjuryLog', [42]))
    await executeOfflineWrite(db, operation('deleteInjury', ['injury']))
    await executeOfflineWrite(db, operation('updateInjuryStatus', ['injury', 'resolved']))
    await executeOfflineWrite(db, operation('deleteGymTemplate', ['template']))
    await executeOfflineWrite(db, operation('updateInjuryStartedAt', ['injury', '2026-07-01']))
    await executeOfflineWrite(db, operation('startGymTemplateRun', ['template']))
    await executeOfflineWrite(db, operation('completeGymTemplateRun', ['template']))

    expect(db.setPlanItemCheck).toHaveBeenCalledWith('item', '2026-07-13', false)
    expect(db.updateGymTemplate).toHaveBeenCalledWith('template', { name: 'B' })
    expect(db.deleteGymSession).toHaveBeenCalledWith('session')
    expect(db.deleteInjuryLog).toHaveBeenCalledWith(42)
    expect(db.deleteInjury).toHaveBeenCalledWith('injury')
    expect(db.updateInjuryStatus).toHaveBeenCalledWith('injury', 'resolved')
    expect(db.deleteGymTemplate).toHaveBeenCalledWith('template')
    expect(db.updateInjuryStartedAt).toHaveBeenCalledWith('injury', '2026-07-01')
    expect(db.startGymTemplateRun).toHaveBeenCalledWith('template')
    expect(db.completeGymTemplateRun).toHaveBeenCalledWith('template')
  })

  it('rejects unknown persisted operation types', async () => {
    await expect(executeOfflineWrite(database(), operation('unknown', []))).rejects.toThrow(
      'unsupported offline write type'
    )
  })
})
