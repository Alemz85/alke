#!/usr/bin/env node
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

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
    if (template.notes !== null && (typeof template.notes !== 'string' || template.notes.length > 2000)) {
      errors.push(`${at}.notes must be null or at most 2000 characters`)
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
      for (const [field, minimum, maximum] of [['sets', 1, 50], ['reps', 1, 500]]) {
        if (!Number.isInteger(exercise[field]) || exercise[field] < minimum || exercise[field] > maximum) {
          errors.push(`${exerciseAt}.${field} must be an integer from ${minimum}–${maximum}`)
        }
      }
      if (exercise.kg !== null && (typeof exercise.kg !== 'number' || !Number.isFinite(exercise.kg) || exercise.kg < 0 || exercise.kg > 1500)) {
        errors.push(`${exerciseAt}.kg must be null or a number from 0–1500`)
      }
      if (exercise.note !== null && (typeof exercise.note !== 'string' || exercise.note.length > 500)) {
        errors.push(`${exerciseAt}.note must be null or at most 500 characters`)
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
        { exercise: 'Bench Press', sets: 3, reps: 8, kg: null, note: null }
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
