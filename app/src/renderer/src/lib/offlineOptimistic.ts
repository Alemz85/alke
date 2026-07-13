import type {
  Injury,
  InjuryLogEntry,
  NewInjuryLog,
  PlanItemCheck,
  ProteinDay
} from '@shared/types'

export function makeOptimisticInjuryLog(
  input: NewInjuryLog,
  id: number,
  fallbackDate: string,
  nowIso = new Date().toISOString()
): InjuryLogEntry {
  return {
    id,
    injury_id: input.injury_id,
    entry_date: input.entry_date ?? fallbackDate,
    noted_at: nowIso,
    source: 'user',
    note: input.note,
    pain_level: input.pain_level,
    context: input.context,
    workout_id: input.workout_id ?? null
  }
}

export function patchInjuryPlanStart(
  injuries: Injury[],
  injuryId: string,
  planStartedAt: string
): Injury[] {
  return injuries.map((injury) =>
    injury.id === injuryId
      ? { ...injury, plan_started_at: planStartedAt, updated_at: new Date().toISOString() }
      : injury
  )
}

export function patchInjuryStatus(
  injuries: Injury[],
  injuryId: string,
  status: Injury['status'],
  nowIso = new Date().toISOString()
): Injury[] {
  return injuries.map((injury) =>
    injury.id === injuryId
      ? {
          ...injury,
          status,
          resolved_at: status === 'resolved' ? nowIso : null,
          updated_at: nowIso
        }
      : injury
  )
}

export function applyPlanCheckOptimistic(
  checks: PlanItemCheck[],
  itemId: string,
  doneDate: string,
  done: boolean
): PlanItemCheck[] {
  const matches = (check: PlanItemCheck): boolean =>
    check.item_id === itemId && check.done_date.slice(0, 10) === doneDate

  if (!done) return checks.filter((check) => !matches(check))
  if (checks.some(matches)) return checks

  return [
    ...checks,
    {
      id: -Date.now(),
      item_id: itemId,
      done_date: doneDate,
      source: 'user'
    }
  ]
}

export function applyProteinOptimistic(
  days: ProteinDay[],
  date: string,
  grams: number,
  mode: 'add' | 'set'
): ProteinDay[] {
  const existing = days.find((day) => day.log_date === date)
  const nextGrams = mode === 'add' ? (existing?.grams ?? 0) + grams : grams
  const nextDay = { log_date: date, grams: nextGrams }

  if (!existing) return [...days, nextDay].sort((a, b) => a.log_date.localeCompare(b.log_date))
  return days.map((day) => (day.log_date === date ? nextDay : day))
}
