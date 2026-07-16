import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from '../recovery_plan_contract.mjs'

// Every exercise-kind item is catalog-backed now, so the default fixture
// carries a link plus target_sets/target_reps — with structured `steps`
// still attached as plan-item detail (routines stay tabular even though the
// item itself links to the catalog). Mirrors test_injuries.py's exercise().
function exercise(overrides = {}) {
  return {
    name: 'Daily mobility',
    kind: 'exercise',
    start_week: 1,
    weekly_target: 14,
    green_min: 10,
    yellow_min: 7,
    note: null,
    exercise: 'Daily Mobility Routine',
    create: null,
    body_part: null,
    target_sets: 2,
    target_reps: 1,
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

// ---- Every exercise-kind item is catalog-backed now (parity with
// test_injuries.py's equivalent Python-side assertions) ----

test('requires a catalog exercise link for every exercise item', () => {
  const plan = { approach: 'Stack phases.', items: [exercise({ exercise: null })] }
  assert.ok(validatePlan(plan).some((error) => error.includes('require a catalog exercise link')))
})

test('still requires target_sets and target_reps when linked', () => {
  const plan = { approach: 'Stack phases.', items: [exercise({ target_sets: null, target_reps: null })] }
  assert.ok(validatePlan(plan).some((error) => error.includes('lacks target_sets/target_reps')))
})

test('allows a linked exercise to also carry steps', () => {
  // Composite-routine detail (steps) is plan-item detail alongside a
  // catalog link now, not mutually exclusive with it.
  const plan = { approach: 'Stack phases.', items: [exercise()] }
  assert.deepEqual(validatePlan(plan), [])
})

test('accepts a linked exercise without steps', () => {
  const plan = { approach: 'Stack phases.', items: [exercise({ steps: null })] }
  assert.deepEqual(validatePlan(plan), [])
})

test('rejects a non-boolean create flag', () => {
  const plan = { approach: 'Stack phases.', items: [exercise({ create: 1 })] }
  assert.ok(validatePlan(plan).some((error) => error.includes('create must be true, false, or null')))
})

test('accepts create: true with a valid body_part', () => {
  const plan = { approach: 'Stack phases.', items: [exercise({ create: true, body_part: 'legs' })] }
  assert.deepEqual(validatePlan(plan), [])
})

test('rejects an invalid body_part', () => {
  const plan = { approach: 'Stack phases.', items: [exercise({ create: true, body_part: 'not-a-body-part' })] }
  assert.ok(validatePlan(plan).some((error) => error.includes('body_part must be null')))
})

test('rejects body_part without create', () => {
  const plan = { approach: 'Stack phases.', items: [exercise({ create: false, body_part: 'legs' })] }
  assert.ok(validatePlan(plan).some((error) => error.includes('body_part only applies')))
})

test('rejects create on constraint items', () => {
  const plan = {
    approach: 'Stack phases.',
    items: [{
      name: 'No overhead pressing', kind: 'constraint', start_week: 1,
      weekly_target: null, green_min: null, yellow_min: null, note: null,
      exercise: null, create: true, body_part: null,
      target_sets: null, target_reps: null, steps: null
    }]
  }
  assert.ok(validatePlan(plan).some((error) => error.includes('constraints cannot carry')))
})

test('rejects create on habit items', () => {
  const plan = {
    approach: 'Stack phases.',
    items: [{
      name: 'Wear supportive shoes', kind: 'habit', start_week: 1,
      weekly_target: null, green_min: null, yellow_min: null, note: null,
      exercise: null, create: true, body_part: null,
      target_sets: null, target_reps: null, steps: null
    }]
  }
  assert.ok(validatePlan(plan).some((error) => error.includes('only exercise items may carry Gym prescription fields')))
})

test('rejects a blank exercise link', () => {
  const plan = { approach: 'Stack phases.', items: [exercise({ exercise: '  ' })] }
  assert.ok(validatePlan(plan).some((error) => error.includes('must not be blank')))
})
