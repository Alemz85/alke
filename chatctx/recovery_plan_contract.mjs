#!/usr/bin/env node
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const kinds = new Set(['exercise', 'activity', 'habit', 'constraint'])
// Keep in sync with injuries.py's BODY_PARTS / gym.py's BODY_PARTS — all
// three must match the exercises.body_part check constraint (see
// supabase/migrations/20260713010000_gym_exercise_catalog.sql).
const bodyParts = new Set(['chest', 'back', 'shoulders', 'arms', 'legs', 'core', 'full body'])

export function validatePlan(plan) {
  const errors = []
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['plan must be a JSON object']
  if (typeof plan.approach !== 'string' || !plan.approach.trim()) errors.push('approach must be a non-empty string')
  else if (plan.approach.trim().length > 500) errors.push('approach must be 500 characters or fewer')
  if (!Array.isArray(plan.items) || plan.items.length < 1 || plan.items.length > 16) {
    errors.push('items must contain 1–16 plan items')
    return errors
  }
  const names = new Set()
  plan.items.forEach((item, index) => {
    const at = `items[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${at} must be an object`); return }
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!name) errors.push(`${at}.name must be non-empty`)
    const key = name.toLowerCase()
    if (key && names.has(key)) errors.push(`${at}.name duplicates another item`)
    names.add(key)
    if (!kinds.has(item.kind)) errors.push(`${at}.kind is invalid`)
    if (!Number.isInteger(item.start_week) || item.start_week < 1 || item.start_week > 52) {
      errors.push(`${at}.start_week must be an integer from 1–52`)
    }
    for (const [field, max] of [['weekly_target', 14], ['green_min', 14], ['yellow_min', 14], ['target_sets', 20], ['target_reps', 100]]) {
      const value = item[field]
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > max)) errors.push(`${at}.${field} must be null or 1–${max}`)
    }
    if (item.note !== null && typeof item.note !== 'string') errors.push(`${at}.note must be a string or null`)
    if (item.exercise !== null && typeof item.exercise !== 'string') errors.push(`${at}.exercise must be a catalog name or null`)
    if (item.exercise !== null && typeof item.exercise === 'string' && !item.exercise.trim()) errors.push(`${at}.exercise must not be blank`)
    if (item.body_part !== undefined && item.body_part !== null && typeof item.body_part !== 'string') errors.push(`${at}.body_part must be a string or null`)
    if (typeof item.body_part === 'string' && !bodyParts.has(item.body_part)) errors.push(`${at}.body_part must be null or one of: ${[...bodyParts].join(', ')}`)
    if (item.create !== undefined && item.create !== null && typeof item.create !== 'boolean') errors.push(`${at}.create must be true, false, or null`)
    const create = item.create === true
    if (item.steps !== null && !Array.isArray(item.steps)) errors.push(`${at}.steps must be an array or null`)
    if (Array.isArray(item.steps)) item.steps.forEach((step, stepIndex) => {
      const stepAt = `${at}.steps[${stepIndex}]`
      if (!step || typeof step !== 'object' || Array.isArray(step)) { errors.push(`${stepAt} must be an object`); return }
      if (typeof step.name !== 'string' || !step.name.trim()) errors.push(`${stepAt}.name must be non-empty`)
      for (const [field, max] of [['sets', 20], ['reps', 1000], ['duration_seconds', 3600], ['distance_m', 10000]]) {
        const value = step[field]
        if (value !== null && (!Number.isFinite(value) || value <= 0 || value > max)) errors.push(`${stepAt}.${field} must be null or a positive number up to ${max}`)
      }
      if (![true, false, null].includes(step.per_side)) errors.push(`${stepAt}.per_side must be true, false, or null`)
      if (step.note !== null && typeof step.note !== 'string') errors.push(`${stepAt}.note must be a string or null`)
      if ([step.reps, step.duration_seconds, step.distance_m].filter(value => value !== null).length !== 1) errors.push(`${stepAt} requires exactly one of reps, duration_seconds, or distance_m`)
    })
    if (item.kind === 'constraint' && ['weekly_target', 'green_min', 'yellow_min', 'target_sets', 'target_reps', 'exercise', 'body_part', 'steps'].some((field) => item[field] != null) || (item.kind === 'constraint' && create)) {
      errors.push(`${at}: constraints cannot carry targets, a Gym dose, an exercise link, or create`)
    }
    if (item.kind === 'exercise') {
      if (item.weekly_target === null || item.green_min === null || item.yellow_min === null) errors.push(`${at}: exercises require weekly_target, green_min, and yellow_min`)
      if (item.yellow_min > item.green_min || item.green_min > item.weekly_target) errors.push(`${at}: require yellow_min ≤ green_min ≤ weekly_target`)
      // Every exercise-kind item is catalog-backed now: it links to an
      // existing exercises row, or (with the explicit opt-in "create": true)
      // mints one. There is no more off-catalog, steps-only exercise item —
      // `steps` may still ride along as plan-item detail on a linked item.
      const linked = typeof item.exercise === 'string' && item.exercise.trim()
      if (!linked) errors.push(`${at}: exercise items require a catalog exercise link (set "exercise" to an existing name, or "exercise" + "create": true to make one)`)
      if (linked && (item.target_sets === null || item.target_reps === null)) errors.push(`${at}: linked exercise lacks target_sets/target_reps`)
      if (item.body_part != null && !create) errors.push(`${at}.body_part only applies when "create": true`)
    } else if (item.target_sets !== null || item.target_reps !== null || item.exercise !== null || item.steps !== null || item.body_part != null || create) {
      errors.push(`${at}: only exercise items may carry Gym prescription fields`)
    }
  })
  return errors
}

const template = {
  approach: 'Short current approach, progression rule, and important caution.',
  items: [
    { name: 'Linked strength exercise', kind: 'exercise', start_week: 2, weekly_target: 3, green_min: 3, yellow_min: 2, note: 'Technique and progression guidance.', exercise: 'Exact catalog exercise name', create: false, body_part: null, target_sets: 3, target_reps: 12, steps: null },
    { name: 'New composite mobility routine', kind: 'exercise', start_week: 1, weekly_target: 7, green_min: 5, yellow_min: 3, note: 'When and how to perform the routine.', exercise: 'New catalog exercise name', create: true, body_part: 'legs', target_sets: 1, target_reps: 1, steps: [{ name: 'Named stretch', sets: 2, reps: null, duration_seconds: 30, distance_m: null, per_side: true, note: null }] }
  ]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file] = process.argv.slice(2)
  if (command === 'template') {
    process.stdout.write(`${JSON.stringify(template, null, 2)}\n`)
  } else if (command === 'validate' && file) {
    let plan
    try { plan = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { console.error(`invalid JSON: ${error.message}`); process.exit(1) }
    const errors = validatePlan(plan)
    if (errors.length) { console.error(errors.map((error) => `- ${error}`).join('\n')); process.exit(1) }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  } else {
    console.error('usage: node recovery_plan_contract.mjs template | validate <plan.json>')
    process.exit(2)
  }
}
