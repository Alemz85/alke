import type { RecoveryPlanStep } from '@shared/types'

export function formatRecoveryDose(sets: number | null, reps: number | null): string | null {
  if (sets != null && reps != null) return `${sets} sets × ${reps} reps`
  if (sets != null) return `${sets} sets`
  if (reps != null) return `${reps} reps`
  return null
}

function formatMeasure(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function formatRecoveryStepDose(step: RecoveryPlanStep): string {
  const measures: string[] = []
  if (step.duration_seconds != null) measures.push(`${formatMeasure(step.duration_seconds)} sec`)
  else if (step.distance_m != null) measures.push(`${formatMeasure(step.distance_m)} m`)
  else if (step.reps != null) measures.push(`${step.reps} reps`)
  let value = measures.join(' · ') || 'As directed'
  if (step.sets != null) value = `${step.sets} × ${value.replace(' reps', '')}${step.reps != null ? ' reps' : ''}`
  if (step.per_side) value += ' / side'
  return value
}
