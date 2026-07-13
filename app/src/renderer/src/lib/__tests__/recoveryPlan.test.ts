import { describe, expect, it } from 'vitest'
import type { RecoveryPlanStep } from '@shared/types'
import { formatRecoveryDose, formatRecoveryStepDose } from '../recoveryPlan'

describe('recovery plan display', () => {
  it('formats a simple linked exercise prescription below its name', () => {
    expect(formatRecoveryDose(3, 15)).toBe('3 sets × 15 reps')
  })

  it('formats composite mobility steps with reps, time, distance, and side', () => {
    const stretch: RecoveryPlanStep = {
      name: 'Straight-knee calf stretch', sets: 2, reps: null,
      duration_seconds: 30, distance_m: null, per_side: true, note: null
    }
    const circles: RecoveryPlanStep = {
      name: 'Ankle circles', sets: null, reps: 10,
      duration_seconds: null, distance_m: null, per_side: true, note: null
    }
    expect(formatRecoveryStepDose(stretch)).toBe('2 × 30 sec / side')
    expect(formatRecoveryStepDose(circles)).toBe('10 reps / side')
  })
})
