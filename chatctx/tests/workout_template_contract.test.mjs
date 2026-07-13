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
