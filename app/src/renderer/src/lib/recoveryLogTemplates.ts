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
 * The set rows one linked plan item prescribes.
 *
 * `recovery_plan_items` has no duration column, so a timed or measured dose
 * lives in a structured `steps` entry and the rep column is left holding a
 * placeholder 1. Reading `target_reps` blindly therefore prefilled a 45-second
 * wall sit as "1 rep" — the exact hold-as-a-single-rep encoding the chat
 * helpers refuse to write, arriving through the app's own prefill instead
 * (agent_log #26). So the step, when it carries the real dose, wins.
 *
 * Only a SINGLE step can be collapsed into uniform set rows. A multi-movement
 * routine (a sequence of several stretches) has no one dose, and a distance
 * step has no measure a set row can hold at all — both yield blank rows, which
 * is the honest answer and consistent with never inventing a prescription.
 */
function prescribedRows(item: RecoveryPlanItem, exercise: Exercise): PrefillSetRow[] {
  const steps = item.steps ?? []
  const only = steps.length === 1 ? steps[0] : null
  // A single step's own `sets` outranks the item's: it is the more specific
  // prescription, and the item's value is often just the same number mirrored.
  const setCount = only?.sets ?? item.target_sets ?? 1
  const base = { exerciseId: exercise.id, exerciseName: exercise.name, weightKg: null, isWarmup: false }

  let dose: { reps: number | null; durationS?: number | null }
  if (only?.duration_seconds != null) dose = { reps: null, durationS: only.duration_seconds }
  else if (only?.reps != null) dose = { reps: only.reps }
  // Steps present but not collapsible (multi-step, or a distance-only step):
  // blank the dose rather than fall through to the placeholder rep count.
  else if (steps.length > 0) dose = { reps: null }
  else dose = { reps: item.target_reps }

  return Array.from({ length: setCount }, () => ({ ...base, ...dose }))
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
    rows: linked.flatMap(({ item, exercise }) => prescribedRows(item, exercise)),
    exerciseItems,
    guidance,
    unlinkedExerciseCount: exerciseItems.length - linked.length
  }
}
