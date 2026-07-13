import type { Goal, GoalPatch, GymSession, QueuedWriteReceipt } from '@shared/types'

export type EntityWithId = { id: string }

export function isQueuedWriteReceipt(value: unknown): value is QueuedWriteReceipt {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<QueuedWriteReceipt>
  return candidate.queued === true && typeof candidate.operationId === 'string'
}

export function patchById<T extends EntityWithId>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
}

export function removeById<T extends EntityWithId>(rows: T[], id: string): T[] {
  return rows.filter((row) => row.id !== id)
}

export function replaceById<T extends EntityWithId>(rows: T[], id: string, replacement: T): T[] {
  return rows.map((row) => (row.id === id ? replacement : row))
}

export function applyGoalPatch(goals: Goal[], id: string, patch: GoalPatch): Goal[] {
  return patchById(goals, id, { ...patch, updated_at: new Date().toISOString() })
}

export function sessionFallsWithinQuery(queryKey: readonly unknown[], session: GymSession): boolean {
  if (
    queryKey[0] !== 'health' ||
    queryKey[1] !== 'gym' ||
    queryKey[2] !== 'sessions' ||
    typeof queryKey[3] !== 'string' ||
    typeof queryKey[4] !== 'string'
  ) {
    return false
  }
  return session.performed_at >= queryKey[3] && session.performed_at <= queryKey[4]
}
