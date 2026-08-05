import { describe, expect, it } from 'vitest'
import type { RecoveryPlanStep } from '@shared/types'
import { formatRecoveryDose, formatRecoveryItemDose, formatRecoveryStepDose } from '../recoveryPlan'

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

  it('reads a single-hold item dose from its step, not from a placeholder rep count', () => {
    // recovery_plan_items counts reps only, so a prescribed hold parks a
    // placeholder 1 in target_reps and puts the real dose in a step. The chip
    // used to render "3 sets × 1 reps" directly above a step table saying
    // "3 × 45 sec".
    const hold: RecoveryPlanStep = {
      name: 'Wall sit hold', sets: null, reps: null,
      duration_seconds: 45, distance_m: null, per_side: false, note: null
    }
    expect(formatRecoveryItemDose({ target_sets: 3, target_reps: 1, steps: [hold] })).toBe('3 × 45 sec')
  })

  it('keeps the sets × reps summary for a multi-step routine', () => {
    // Collapsing several movements into one chip would drop movements; their
    // detail is the step table's job.
    const a: RecoveryPlanStep = {
      name: 'Calf stretch', sets: 2, reps: null,
      duration_seconds: 30, distance_m: null, per_side: true, note: null
    }
    const b: RecoveryPlanStep = {
      name: 'Ankle circles', sets: null, reps: 10,
      duration_seconds: null, distance_m: null, per_side: true, note: null
    }
    expect(formatRecoveryItemDose({ target_sets: 3, target_reps: 12, steps: [a, b] })).toBe('3 sets × 12 reps')
  })

  it('keeps the rep summary when the single step is itself rep-counted', () => {
    const reps: RecoveryPlanStep = {
      name: 'Pelvic drop', sets: 3, reps: 15,
      duration_seconds: null, distance_m: null, per_side: true, note: null
    }
    expect(formatRecoveryItemDose({ target_sets: 3, target_reps: 15, steps: [reps] })).toBe('3 sets × 15 reps')
  })

  it('falls back to the rep summary for an item with no steps', () => {
    expect(formatRecoveryItemDose({ target_sets: 3, target_reps: 12, steps: null })).toBe('3 sets × 12 reps')
  })
})
