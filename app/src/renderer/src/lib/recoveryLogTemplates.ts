import type { Exercise, Injury, RecoveryPlanItem } from '@shared/types'
import type { PrefillSetRow } from './gymLog'

export interface RecoveryLogTemplate {
  id: string
  injuryId: string
  planStartedAt: string | null
  name: string
  summary: string | null
  rows: PrefillSetRow[]
  exerciseItems: RecoveryPlanItem[]
  guidance: RecoveryPlanItem[]
  unlinkedExerciseCount: number
}

/**
 * Produce the actual text stored in a compact recovery card preview. This is
 * deliberately truncated in data, not merely clipped by card overflow, so no
 * hidden continuation can run underneath the footer.
 */
export function recoveryOverviewPreview(summary: string, maxChars = 90): string {
  const normalized = summary.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  const budget = Math.max(1, maxChars - 1)
  const candidate = normalized.slice(0, budget)
  const wordBoundary = candidate.lastIndexOf(' ')
  const excerpt = wordBoundary >= Math.floor(budget * 0.65)
    ? candidate.slice(0, wordBoundary)
    : candidate
  return `${excerpt.trimEnd()}…`
}

/**
 * Project an injury's active plan into a logging-safe template. A linked rehab
 * exercise contributes its prescribed set rows. Legacy items without a
 * structured dose retain one blank row; the app never invents a prescription.
 */
export function buildRecoveryLogTemplate(
  injury: Injury,
  items: RecoveryPlanItem[],
  exercisesById: Map<string, Exercise>
): RecoveryLogTemplate {
  const active = items.filter((item) => item.active)
  const exerciseItems = active.filter((item) => item.kind === 'exercise')
  const guidance = active.filter((item) => item.kind !== 'exercise')
  const linked = exerciseItems.flatMap((item) => {
    if (!item.exercise_id) return []
    const exercise = exercisesById.get(item.exercise_id)
    return exercise ? [{ item, exercise }] : []
  })

  return {
    id: `recovery:${injury.id}`,
    injuryId: injury.id,
    planStartedAt: injury.plan_started_at,
    name: `${injury.name} recovery`,
    summary: injury.recovery_plan,
    rows: linked.flatMap(({ item, exercise }) =>
      Array.from({ length: item.target_sets ?? 1 }, () => ({
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        reps: item.target_reps,
        weightKg: null,
        isWarmup: false
      }))
    ),
    exerciseItems,
    guidance,
    unlinkedExerciseCount: exerciseItems.length - linked.length
  }
}
