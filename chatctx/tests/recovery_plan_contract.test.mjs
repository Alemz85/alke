import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from '../recovery_plan_contract.mjs'

function exercise(overrides = {}) {
  return {
    name: 'Daily mobility',
    kind: 'exercise',
    start_week: 1,
    weekly_target: 14,
    green_min: 10,
    yellow_min: 7,
    note: null,
    exercise: null,
    target_sets: null,
    target_reps: null,
    steps: [{
      name: 'Straight-knee calf stretch',
      sets: 2,
      reps: null,
      duration_seconds: 30,
      distance_m: null,
      per_side: true,
      note: null
    }],
    ...overrides
  }
}

test('requires an explicit start week for every item', () => {
  const plan = { approach: 'Progress gradually.', items: [exercise({ start_week: undefined })] }
  assert.ok(validatePlan(plan).some((error) => error.includes('start_week')))
})

test('accepts comprehensive phased plans with up to sixteen items', () => {
  const items = Array.from({ length: 10 }, (_, index) => exercise({
    name: `Exercise ${index + 1}`,
    start_week: (index % 6) + 1
  }))
  assert.deepEqual(validatePlan({ approach: 'Stack the phases.', items }), [])
})

test('rejects phases outside the supported range', () => {
  const plan = { approach: 'Progress gradually.', items: [exercise({ start_week: 0 })] }
  assert.ok(validatePlan(plan).some((error) => error.includes('start_week')))
})

test('keeps adherence dose thresholds mandatory and ordered', () => {
  const missing = { approach: 'Progress gradually.', items: [exercise({ green_min: null })] }
  const reversed = { approach: 'Progress gradually.', items: [exercise({ green_min: 6, yellow_min: 8 })] }
  assert.ok(validatePlan(missing).some((error) => error.includes('require weekly_target')))
  assert.ok(validatePlan(reversed).some((error) => error.includes('yellow_min')))
})
