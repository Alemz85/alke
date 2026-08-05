#!/usr/bin/env node
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// Catalog vocabularies, mirroring the CHECK constraints on `exercises` and the
// same lists in gym.py. Only consulted for entries that opt into "create".
const BODY_PARTS = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core', 'full body']
const MUSCLES = [
  'chest', 'lats', 'upper back', 'traps', 'lower back', 'front delts', 'side delts',
  'rear delts', 'biceps', 'triceps', 'forearms', 'quadriceps', 'hamstrings', 'glutes',
  'calves', 'tibialis', 'adductors', 'abductors', 'hip flexors', 'abs', 'obliques'
]
const EQUIPMENT = [
  'barbell', 'dumbbell', 'kettlebell', 'machine', 'cable', 'bodyweight', 'band',
  'smith machine', 'ez bar', 'trap bar', 'other'
]
const MECHANICS = ['compound', 'isolation']
const MOVEMENT_PATTERNS = [
  'squat', 'hinge', 'lunge', 'horizontal push', 'vertical push', 'horizontal pull',
  'vertical pull', 'carry', 'core', 'rotation', 'isolation'
]
const ATTR_KEYS = [
  'body_part', 'primary_muscles', 'secondary_muscles', 'equipment', 'mechanics',
  'movement_pattern', 'aliases'
]

function checkVocabulary(value, valid, label, errors) {
  if (value == null) return
  if (typeof value !== 'string' || !valid.includes(value)) {
    errors.push(`${label} must be one of: ${valid.join(', ')}`)
  }
}

function checkMuscleList(value, label, errors) {
  if (value == null) return
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    errors.push(`${label} must be an array of strings`)
    return
  }
  const unknown = value.filter((v) => !MUSCLES.includes(v))
  if (unknown.length) errors.push(`${label} has unknown muscle(s): ${unknown.join(', ')}`)
}

export function validateWorkoutTemplates(plan) {
  const errors = []
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['plan must be a JSON object']
  if (!Array.isArray(plan.templates) || plan.templates.length < 1 || plan.templates.length > 12) {
    return ['templates must contain 1–12 reusable templates']
  }
  const names = new Set()
  plan.templates.forEach((template, templateIndex) => {
    const at = `templates[${templateIndex}]`
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      errors.push(`${at} must be an object`)
      return
    }
    const name = typeof template.name === 'string' ? template.name.trim() : ''
    if (!name || name.length > 120) errors.push(`${at}.name must contain 1–120 characters`)
    const key = name.toLowerCase()
    if (key && names.has(key)) errors.push(`${at}.name duplicates another template`)
    names.add(key)
    if (template.notes != null && (typeof template.notes !== 'string' || template.notes.length > 2000)) {
      errors.push(`${at}.notes must be null or at most 2000 characters`)
    }
    if (template.default_rest_s != null && (!Number.isInteger(template.default_rest_s) || template.default_rest_s < 0 || template.default_rest_s > 3600)) {
      errors.push(`${at}.default_rest_s must be null or an integer from 0–3600`)
    }
    if (!Array.isArray(template.exercises) || template.exercises.length < 1 || template.exercises.length > 30) {
      errors.push(`${at}.exercises must contain 1–30 exercises`)
      return
    }
    template.exercises.forEach((exercise, exerciseIndex) => {
      const exerciseAt = `${at}.exercises[${exerciseIndex}]`
      if (!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) {
        errors.push(`${exerciseAt} must be an object`)
        return
      }
      if (typeof exercise.exercise !== 'string' || !exercise.exercise.trim()) {
        errors.push(`${exerciseAt}.exercise must be an exact catalog name`)
      }
      if (!Number.isInteger(exercise.sets) || exercise.sets < 1 || exercise.sets > 50) {
        errors.push(`${exerciseAt}.sets must be an integer from 1–50`)
      }
      // One dose measure per exercise: reps OR a timed hold. A prescribed hold
      // encoded as 1 rep misreports the dose everywhere the template renders.
      const hasReps = exercise.reps != null
      const hasSecs = exercise.secs != null
      if (hasReps && hasSecs) {
        errors.push(`${exerciseAt} sets both reps and secs — an exercise takes one`)
      } else if (!hasReps && !hasSecs) {
        errors.push(`${exerciseAt} needs reps (1–500) or secs (1–3600) for a timed hold`)
      }
      if (hasReps && (!Number.isInteger(exercise.reps) || exercise.reps < 1 || exercise.reps > 500)) {
        errors.push(`${exerciseAt}.reps must be an integer from 1–500`)
      }
      if (hasSecs && (!Number.isInteger(exercise.secs) || exercise.secs < 1 || exercise.secs > 3600)) {
        errors.push(`${exerciseAt}.secs must be an integer from 1–3600`)
      }
      if (exercise.create != null && typeof exercise.create !== 'boolean') {
        errors.push(`${exerciseAt}.create must be true or false`)
      }
      const attrsGiven = ATTR_KEYS.filter((key) => exercise[key] != null)
      if (attrsGiven.length && exercise.create !== true) {
        errors.push(
          `${exerciseAt} carries catalog metadata (${attrsGiven.join(', ')}) without "create": true — ` +
            'edit an existing row with `gym.py exercise-update` instead'
        )
      }
      checkVocabulary(exercise.body_part, BODY_PARTS, `${exerciseAt}.body_part`, errors)
      checkVocabulary(exercise.equipment, EQUIPMENT, `${exerciseAt}.equipment`, errors)
      checkVocabulary(exercise.mechanics, MECHANICS, `${exerciseAt}.mechanics`, errors)
      checkVocabulary(exercise.movement_pattern, MOVEMENT_PATTERNS, `${exerciseAt}.movement_pattern`, errors)
      checkMuscleList(exercise.primary_muscles, `${exerciseAt}.primary_muscles`, errors)
      checkMuscleList(exercise.secondary_muscles, `${exerciseAt}.secondary_muscles`, errors)
      if (exercise.aliases != null && (!Array.isArray(exercise.aliases) || exercise.aliases.some((a) => typeof a !== 'string'))) {
        errors.push(`${exerciseAt}.aliases must be an array of strings`)
      }
      if (exercise.kg != null && (typeof exercise.kg !== 'number' || !Number.isFinite(exercise.kg) || exercise.kg < 0 || exercise.kg > 1500)) {
        errors.push(`${exerciseAt}.kg must be null or a number from 0–1500`)
      }
      if (exercise.note != null && (typeof exercise.note !== 'string' || exercise.note.length > 500)) {
        errors.push(`${exerciseAt}.note must be null or at most 500 characters`)
      }
      if (exercise.rest_after_s != null && (!Number.isInteger(exercise.rest_after_s) || exercise.rest_after_s < 0 || exercise.rest_after_s > 3600)) {
        errors.push(`${exerciseAt}.rest_after_s must be null or an integer from 0–3600`)
      }
    })
  })
  return errors
}

const template = {
  templates: [
    {
      name: 'Full body A',
      notes: '45–60 minutes. Add reps before load; keep about 2 reps in reserve.',
      exercises: [
        { exercise: 'Back Squat', sets: 3, reps: 8, kg: null, note: 'Controlled working sets.' },
        { exercise: 'Bench Press', sets: 3, reps: 8, kg: null, note: null },
        // A prescribed hold uses `secs` instead of `reps` — never "1 rep".
        { exercise: 'Wall Sit', sets: 3, secs: 45, note: 'Thighs parallel; hold.' },
        // `create` mints the catalog row this template needs. Describe it while
        // you are here: an empty primary_muscles is invisible to the muscle
        // analytics, with no error to tell you.
        {
          exercise: 'Pelvic Drop',
          sets: 3,
          reps: 10,
          create: true,
          body_part: 'legs',
          primary_muscles: ['glutes'],
          equipment: 'bodyweight',
          mechanics: 'isolation',
          movement_pattern: 'hinge'
        }
      ]
    }
  ]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file] = process.argv.slice(2)
  if (command === 'template') {
    process.stdout.write(`${JSON.stringify(template, null, 2)}\n`)
  } else if (command === 'validate' && file) {
    let plan
    try { plan = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { console.error(`invalid JSON: ${error.message}`); process.exit(1) }
    const errors = validateWorkoutTemplates(plan)
    if (errors.length) { console.error(errors.map((error) => `- ${error}`).join('\n')); process.exit(1) }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  } else {
    console.error('usage: node workout_template_contract.mjs template | validate <plan.json>')
    process.exit(2)
  }
}
