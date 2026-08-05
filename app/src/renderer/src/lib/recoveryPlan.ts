import type { RecoveryPlanItem, RecoveryPlanStep } from '@shared/types'

export function formatRecoveryDose(sets: number | null, reps: number | null): string | null {
  if (sets != null && reps != null) return `${sets} sets × ${reps} reps`
  if (sets != null) return `${sets} sets`
  if (reps != null) return `${reps} reps`
  return null
}

function formatMeasure(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * The dose chip for one plan item. `recovery_plan_items` counts reps only, so a
 * prescribed hold has to carry its real dose in a structured step — and the
 * rep column then holds a placeholder 1, which rendered as "3 sets × 1 reps"
 * directly above a step table reading "3 × 45 sec".
 *
 * When the item is a single non-rep step (a hold or a distance), that step IS
 * the dose, so the chip reads from it. Multi-step routines keep the
 * sets × reps summary for the loggable block: their per-movement detail is the
 * step table's job, and collapsing it into one chip would drop movements.
 */
export function formatRecoveryItemDose(
  item: Pick<RecoveryPlanItem, 'target_sets' | 'target_reps' | 'steps'>
): string | null {
  const steps = item.steps ?? []
  const only = steps.length === 1 ? steps[0] : null
  if (only && only.reps == null && (only.duration_seconds != null || only.distance_m != null)) {
    return formatRecoveryStepDose({ ...only, sets: only.sets ?? item.target_sets })
  }
  return formatRecoveryDose(item.target_sets, item.target_reps)
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
