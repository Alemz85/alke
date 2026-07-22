import type {
  Exercise,
  GymSession,
  GymSessionPatch,
  GymSet,
  GymTemplate,
  GymTemplateItem,
  GymTemplatePatch,
  NewGymSession,
  NewGymSet,
  NewGymTemplate,
  NewGymTemplateItem
} from '@shared/types'

function exerciseName(exercises: Exercise[], exerciseId: string): string {
  return exercises.find((exercise) => exercise.id === exerciseId)?.name ?? 'Unknown exercise'
}

function templateItems(
  templateId: string,
  items: NewGymTemplateItem[],
  exercises: Exercise[]
): GymTemplateItem[] {
  return items.map((item, position) => ({
    id: `${templateId}:item:${position}`,
    template_id: templateId,
    exercise_id: item.exercise_id,
    exercise_name: exerciseName(exercises, item.exercise_id),
    position,
    target_sets: item.target_sets,
    target_reps: item.target_reps,
    target_weight_kg: item.target_weight_kg,
    rest_after_s: item.rest_after_s ?? null,
    note: item.note ?? null
  }))
}

function sessionSets(sessionId: string, sets: NewGymSet[], exercises: Exercise[]): GymSet[] {
  return sets.map((set, position) => ({
    id: -(position + 1),
    session_id: sessionId,
    exercise_id: set.exercise_id,
    exercise_name: exerciseName(exercises, set.exercise_id),
    position,
    reps: set.reps,
    weight_kg: set.weight_kg,
    rpe: set.rpe ?? null,
    is_warmup: set.is_warmup ?? false,
    is_eccentric: set.is_eccentric ?? false,
    note: set.note ?? null
  }))
}

export function makeOptimisticTemplate(
  input: NewGymTemplate,
  exercises: Exercise[],
  id: string,
  nowIso = new Date().toISOString()
): GymTemplate {
  return {
    id,
    name: input.name,
    notes: input.notes,
    archived: false,
    default_rest_s: input.default_rest_s ?? null,
    // A brand-new template is its own family at version 1, current, not yet run.
    family_id: id,
    version: 1,
    is_current: true,
    items: templateItems(id, input.items, exercises),
    runs: [],
    created_at: nowIso,
    updated_at: nowIso
  }
}

export function applyOptimisticTemplatePatch(
  template: GymTemplate,
  patch: GymTemplatePatch,
  exercises: Exercise[]
): GymTemplate {
  return {
    ...template,
    ...patch,
    default_rest_s:
      patch.default_rest_s === undefined ? template.default_rest_s : patch.default_rest_s,
    items:
      patch.items === undefined ? template.items : templateItems(template.id, patch.items, exercises),
    updated_at: new Date().toISOString()
  }
}

export function makeOptimisticSession(
  input: NewGymSession,
  exercises: Exercise[],
  id: string,
  performedAt: string,
  nowIso = new Date().toISOString()
): GymSession {
  const templateIds = input.template_ids ?? (input.template_id ? [input.template_id] : [])
  return {
    id,
    workout_id: input.workout_id ?? null,
    template_id: templateIds[0] ?? null,
    template_ids: templateIds,
    performed_at: performedAt,
    title: input.title ?? null,
    notes: input.notes ?? null,
    source: 'user',
    body_parts: input.body_parts ?? null,
    sets: sessionSets(id, input.sets, exercises),
    created_at: nowIso,
    updated_at: nowIso
  }
}

export function applyOptimisticSessionPatch(
  session: GymSession,
  patch: GymSessionPatch,
  exercises: Exercise[]
): GymSession {
  const templateIds =
    patch.template_ids ??
    (patch.template_id !== undefined
      ? patch.template_id === null
        ? []
        : [patch.template_id]
      : session.template_ids)
  return {
    ...session,
    ...patch,
    template_id: templateIds[0] ?? null,
    template_ids: templateIds,
    sets: patch.sets === undefined ? session.sets : sessionSets(session.id, patch.sets, exercises),
    updated_at: new Date().toISOString()
  }
}
