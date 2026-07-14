import { describe, expect, it } from 'vitest'
import type { Injury, NewInjuryLog, PlanItemCheck, ProteinDay } from '@shared/types'
import {
  applyPlanCheckOptimistic,
  applyProteinOptimistic,
  makeOptimisticInjuryLog,
  patchInjuryPlanStart,
  patchInjuryStatus
} from '../offlineOptimistic'

describe('offline optimistic cache helpers', () => {
  it('adds and removes a rehab check without duplicating it', () => {
    const initial: PlanItemCheck[] = []
    const checked = applyPlanCheckOptimistic(initial, 'item-1', '2026-07-13', true)

    expect(checked).toEqual([
      expect.objectContaining({ item_id: 'item-1', done_date: '2026-07-13', source: 'user' })
    ])
    expect(applyPlanCheckOptimistic(checked, 'item-1', '2026-07-13', true)).toHaveLength(1)
    expect(applyPlanCheckOptimistic(checked, 'item-1', '2026-07-13', false)).toEqual([])
  })

  it('adds protein to an existing day and creates a missing day', () => {
    const initial: ProteinDay[] = [{ log_date: '2026-07-12', grams: 80 }]

    expect(applyProteinOptimistic(initial, '2026-07-12', 40, 'add')).toEqual([
      { log_date: '2026-07-12', grams: 120 }
    ])
    expect(applyProteinOptimistic(initial, '2026-07-13', 35, 'add')).toEqual([
      { log_date: '2026-07-12', grams: 80 },
      { log_date: '2026-07-13', grams: 35 }
    ])
  })

  it('replaces a protein total when correcting a day', () => {
    const initial: ProteinDay[] = [{ log_date: '2026-07-13', grams: 80 }]
    expect(applyProteinOptimistic(initial, '2026-07-13', 95, 'set')).toEqual([
      { log_date: '2026-07-13', grams: 95 }
    ])
  })

  it('creates a complete temporary injury note', () => {
    const input: NewInjuryLog = {
      injury_id: 'injury-1',
      note: 'Feeling fine',
      pain_level: 0,
      context: []
    }
    expect(makeOptimisticInjuryLog(input, -1, '2026-07-13', '2026-07-13T12:00:00Z')).toEqual({
      id: -1,
      injury_id: 'injury-1',
      entry_date: '2026-07-13',
      entry_end_date: null,
      date_precision: 'day',
      noted_at: '2026-07-13T12:00:00Z',
      source: 'user',
      note: 'Feeling fine',
      pain_level: 0,
      context: [],
      workout_id: null
    })
  })

  it('patches a recovery-plan start without mutating the injury list', () => {
    const injuries = [{ id: 'injury-1', plan_started_at: null }] as Injury[]
    const result = patchInjuryPlanStart(injuries, 'injury-1', '2026-07-10')
    expect(result[0].plan_started_at).toBe('2026-07-10')
    expect(injuries[0].plan_started_at).toBeNull()
  })

  it('resolves and reopens an injury with consistent timestamps', () => {
    const injuries = [{ id: 'injury-1', status: 'active', resolved_at: null }] as Injury[]
    const resolved = patchInjuryStatus(injuries, 'injury-1', 'resolved', '2026-07-13T12:00:00Z')
    expect(resolved[0]).toMatchObject({ status: 'resolved', resolved_at: '2026-07-13T12:00:00Z' })
    expect(patchInjuryStatus(resolved, 'injury-1', 'active', '2026-07-14T12:00:00Z')[0])
      .toMatchObject({ status: 'active', resolved_at: null })
  })
})
