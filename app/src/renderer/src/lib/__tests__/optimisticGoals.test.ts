import { describe, expect, it } from 'vitest'
import type { Goal } from '@shared/types'
import { applyGoalPatch } from '../optimisticEntities'

describe('optimistic goals', () => {
  it('patches the selected goal and preserves the prior cache value', () => {
    const goals = [
      { id: 'goal-1', status: 'active', title: 'Run stronger' },
      { id: 'goal-2', status: 'on_hold', title: 'Swim faster' }
    ] as Goal[]

    const result = applyGoalPatch(goals, 'goal-1', { status: 'completed', title: 'Run 10K' })

    expect(result[0]).toMatchObject({ status: 'completed', title: 'Run 10K' })
    expect(result[1]).toBe(goals[1])
    expect(goals[0]).toMatchObject({ status: 'active', title: 'Run stronger' })
  })
})
