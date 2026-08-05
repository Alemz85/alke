import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

// ── timed doses ────────────────────────────────────────────────────────────
// A prescribed hold ("wall sit 3 × 45s") had no representation before `secs`,
// so it shipped as "3 sets × 1 rep" with the duration buried in a note.

test('accepts a timed hold in place of reps', () => {
  const plan = { templates: [template()] }
  plan.templates[0].exercises[0] = { exercise: 'Wall Sit', sets: 3, secs: 45 }
  assert.deepEqual(validateWorkoutTemplates(plan), [])
})

test('rejects an exercise carrying both reps and secs', () => {
  const plan = { templates: [template()] }
  plan.templates[0].exercises[0].secs = 45
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('takes one')))
})

test('rejects an exercise with neither reps nor secs', () => {
  const plan = { templates: [template()] }
  delete plan.templates[0].exercises[0].reps
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('secs')))
})

test('rejects an out-of-range hold', () => {
  const plan = { templates: [template()] }
  plan.templates[0].exercises[0] = { exercise: 'Wall Sit', sets: 3, secs: 3601 }
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('secs')))
})

// ── minting a catalog row from a template ──────────────────────────────────

test('accepts a create entry carrying full catalog metadata', () => {
  const plan = { templates: [template()] }
  plan.templates[0].exercises[0] = {
    exercise: 'Pelvic Drop',
    sets: 3,
    reps: 10,
    create: true,
    body_part: 'legs',
    primary_muscles: ['glutes'],
    secondary_muscles: ['abductors'],
    equipment: 'bodyweight',
    mechanics: 'isolation',
    movement_pattern: 'hinge',
    aliases: ['hip hitch']
  }
  assert.deepEqual(validateWorkoutTemplates(plan), [])
})

test('rejects catalog metadata without an explicit create opt-in', () => {
  const plan = { templates: [template()] }
  plan.templates[0].exercises[0].primary_muscles = ['glutes']
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('"create": true')))
})

test('rejects a muscle outside the catalog vocabulary', () => {
  const plan = { templates: [template()] }
  Object.assign(plan.templates[0].exercises[0], { create: true, primary_muscles: ['gluteus'] })
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('unknown muscle')))
})

test('rejects an equipment value outside the vocabulary', () => {
  const plan = { templates: [template()] }
  Object.assign(plan.templates[0].exercises[0], { create: true, equipment: 'resistance band' })
  assert.ok(validateWorkoutTemplates(plan).some((error) => error.includes('equipment')))
})

test('the shipped starter template validates against its own contract', () => {
  // The `template` subcommand's output is the thing an agent starts from; if it
  // ever stopped validating, every plan authored from it would start broken.
  const script = fileURLToPath(new URL('../workout_template_contract.mjs', import.meta.url))
  const out = execFileSync('node', [script, 'template'])
  assert.deepEqual(validateWorkoutTemplates(JSON.parse(out.toString())), [])
})
