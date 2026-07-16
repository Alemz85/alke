import test from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkoutTemplates } from '../workout_template_contract.mjs'

function template(name = 'Full body A') {
  return {
    name,
    notes: '45–60 minutes. Add reps before load.',
    exercises: [
      { exercise: 'Back Squat', sets: 3, reps: 8, kg: null, note: 'Leave 2 reps in reserve.' }
    ]
  }
}

test('accepts a multi-day reusable workout plan', () => {
  const plan = { templates: [template('Day A'), template('Day B'), template('Day C')] }
  assert.deepEqual(validateWorkoutTemplates(plan), [])
})

test('requires complete catalog exercise prescriptions', () => {
  const plan = { templates: [template()] }
  delete plan.templates[0].exercises[0].sets
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('sets')))
})

test('rejects duplicate template names', () => {
  const plan = { templates: [template('Day A'), template('day a')] }
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('duplicates')))
})

test('rejects an out-of-range template default_rest_s', () => {
  const plan = { templates: [template()] }
  plan.templates[0].default_rest_s = 99999
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('default_rest_s')))
})

test('rejects a negative default_rest_s', () => {
  const plan = { templates: [template()] }
  plan.templates[0].default_rest_s = -5
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('default_rest_s')))
})

test('accepts boundary default_rest_s values (0 and 3600)', () => {
  const plan = { templates: [template()] }
  plan.templates[0].default_rest_s = 0
  assert.deepEqual(validateWorkoutTemplates(plan), [])
  plan.templates[0].default_rest_s = 3600
  assert.deepEqual(validateWorkoutTemplates(plan), [])
})

test('rejects an out-of-range exercise rest_after_s', () => {
  const plan = { templates: [template()] }
  plan.templates[0].exercises[0].rest_after_s = 99999
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('rest_after_s')))
})

test('rejects a negative rest_after_s', () => {
  const plan = { templates: [template()] }
  plan.templates[0].exercises[0].rest_after_s = -5
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('rest_after_s')))
})
