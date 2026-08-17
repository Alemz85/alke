// Pure parser + validators for the AI chat's "rich block" protocol: fenced
// code blocks whose info string is one of the CHAT_BLOCK_LANGUAGES below,
// body JSON. Every field here is MODEL OUTPUT — untrusted input — so every
// validator does strict shape/type/range checks rather than trusting the
// agent to have followed the schema in chatctx/modes/. Nothing parsed here is
// ever interpolated into HTML/SQL/shell; the renderer only ever puts these
// values into React text nodes or typed window.api calls.
//
// No React/DOM/window imports — this module must stay pure so it can be unit
// tested directly and reused unchanged by any future renderer.

export const CHAT_BLOCK_LANGUAGES = [
  'alke:workout',
  'alke:metric',
  'alke:template',
  'alke:recovery-plan'
] as const

export type ChatBlockLanguage = (typeof CHAT_BLOCK_LANGUAGES)[number]

export function isChatBlockLanguage(language: string): language is ChatBlockLanguage {
  return (CHAT_BLOCK_LANGUAGES as readonly string[]).includes(language)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEMPLATE_ID_RE = /^[a-z0-9-]{1,64}$/

// ── payload shapes ──────────────────────────────────────────────────────

export interface WorkoutBlockPayload {
  workout_id: string
  label?: string
}

export const METRIC_DAYS_MIN = 14
export const METRIC_DAYS_MAX = 365
export const METRIC_DAYS_DEFAULT = 56

export interface MetricBlockPayload {
  metric: string
  days: number
  label?: string
}

export interface TemplateExercisePayload {
  exercise: string
  sets: number
  reps?: number
  secs?: number
  kg?: number
  note?: string
  rest_after_s?: number
}

export interface TemplateDocPayload {
  name: string
  notes?: string
  default_rest_s?: number
  exercises: TemplateExercisePayload[]
}

export interface TemplateDocumentPayload {
  templates: TemplateDocPayload[]
}

export interface TemplateBlockPayload {
  id: string
  action: 'apply' | 'create-version'
  base_template_id?: string
  document: TemplateDocumentPayload
}

export const RECOVERY_PLAN_ITEM_KINDS = ['exercise', 'activity', 'habit', 'constraint'] as const
export type RecoveryPlanItemKind = (typeof RECOVERY_PLAN_ITEM_KINDS)[number]

export interface RecoveryPlanItemPayload {
  name: string
  kind: RecoveryPlanItemKind
  start_week?: number
  weekly_target?: number
  green_min?: number
  yellow_min?: number
  target_sets?: number
  target_reps?: number
  /** Composite-routine steps. Shape is model-defined and only ever shown as
   *  raw text/numbers — not deeply validated beyond "it's an array". */
  steps?: unknown[]
  note?: string
}

export interface RecoveryPlanDocumentPayload {
  approach: string
  items: RecoveryPlanItemPayload[]
}

export interface RecoveryPlanBlockPayload {
  id: string
  injury_id: string
  document: RecoveryPlanDocumentPayload
}

export type ChatBlock =
  | { kind: 'workout'; payload: WorkoutBlockPayload }
  | { kind: 'metric'; payload: MetricBlockPayload }
  | { kind: 'template'; payload: TemplateBlockPayload }
  | { kind: 'recovery-plan'; payload: RecoveryPlanBlockPayload }

/**
 * Result of parsing one fenced code block.
 * - 'ok': valid payload for a recognized block language — render the card.
 * - 'pending': recognized block language, but the JSON didn't parse/validate
 *   AND the message is still streaming — the fence is probably mid-stream.
 *   Render a skeleton, not an error.
 * - 'invalid': recognized block language, JSON didn't parse/validate, and the
 *   message is final — this is a genuinely malformed block. Fall back to a
 *   plain code block (never crash, never show a raw error to the user).
 * - 'not-a-block': the info string isn't one of CHAT_BLOCK_LANGUAGES at all —
 *   render exactly as a normal fenced code block, same as today.
 */
export type ParseChatBlockResult =
  | { status: 'ok'; block: ChatBlock }
  | { status: 'pending' }
  | { status: 'invalid' }
  | { status: 'not-a-block' }

// ── small shape helpers ─────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

function isNonNegInt(value: unknown): value is number {
  return isFiniteInt(value) && value >= 0
}

/** Bounded, non-empty string within [1, maxLength] characters. */
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

/** Optional bounded string: absent is fine, present must satisfy isBoundedString. */
function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ── per-type validators (each returns null on ANY shape violation) ────────

function parseWorkoutPayload(json: unknown): WorkoutBlockPayload | null {
  if (!isRecord(json)) return null
  const { workout_id, label } = json
  if (!isUuid(workout_id)) return null
  if (!isOptionalBoundedString(label, 120)) return null
  return { workout_id, label: typeof label === 'string' ? label : undefined }
}

function parseMetricPayload(json: unknown): MetricBlockPayload | null {
  if (!isRecord(json)) return null
  const { metric, days, label } = json
  if (!isBoundedString(metric, 64)) return null
  if (!isOptionalBoundedString(label, 120)) return null

  let resolvedDays = METRIC_DAYS_DEFAULT
  if (days !== undefined) {
    if (!isFiniteInt(days)) return null
    resolvedDays = clamp(days, METRIC_DAYS_MIN, METRIC_DAYS_MAX)
  }

  return { metric, days: resolvedDays, label: typeof label === 'string' ? label : undefined }
}

function parseTemplateExercise(json: unknown): TemplateExercisePayload | null {
  if (!isRecord(json)) return null
  const { exercise, sets, reps, secs, kg, note, rest_after_s } = json
  if (!isBoundedString(exercise, 200)) return null
  if (!isNonNegInt(sets) || sets < 1) return null

  const hasReps = reps !== undefined
  const hasSecs = secs !== undefined
  // A template line carries ONE dose measure — reps XOR secs, never both,
  // matching the DB's single-dose-measure constraint the apply script enforces.
  if (hasReps && hasSecs) return null
  if (hasReps && !isNonNegInt(reps)) return null
  if (hasSecs && !isNonNegInt(secs)) return null

  if (kg !== undefined && (typeof kg !== 'number' || !Number.isFinite(kg) || kg < 0)) return null
  if (!isOptionalBoundedString(note, 500)) return null
  if (rest_after_s !== undefined && !isNonNegInt(rest_after_s)) return null

  return {
    exercise,
    sets,
    reps: hasReps ? (reps as number) : undefined,
    secs: hasSecs ? (secs as number) : undefined,
    kg: typeof kg === 'number' ? kg : undefined,
    note: typeof note === 'string' ? note : undefined,
    rest_after_s: typeof rest_after_s === 'number' ? rest_after_s : undefined
  }
}

function parseTemplateDoc(json: unknown): TemplateDocPayload | null {
  if (!isRecord(json)) return null
  const { name, notes, default_rest_s, exercises } = json
  if (!isBoundedString(name, 200)) return null
  if (!isOptionalBoundedString(notes, 2000)) return null
  if (default_rest_s !== undefined && !isNonNegInt(default_rest_s)) return null
  if (!Array.isArray(exercises) || exercises.length < 1 || exercises.length > 30) return null

  const parsedExercises: TemplateExercisePayload[] = []
  for (const raw of exercises) {
    const parsed = parseTemplateExercise(raw)
    if (!parsed) return null
    parsedExercises.push(parsed)
  }

  return {
    name,
    notes: typeof notes === 'string' ? notes : undefined,
    default_rest_s: typeof default_rest_s === 'number' ? default_rest_s : undefined,
    exercises: parsedExercises
  }
}

function parseTemplateDocument(json: unknown): TemplateDocumentPayload | null {
  if (!isRecord(json)) return null
  const { templates } = json
  if (!Array.isArray(templates) || templates.length < 1 || templates.length > 12) return null

  const parsedTemplates: TemplateDocPayload[] = []
  for (const raw of templates) {
    const parsed = parseTemplateDoc(raw)
    if (!parsed) return null
    parsedTemplates.push(parsed)
  }
  return { templates: parsedTemplates }
}

function parseTemplatePayload(json: unknown): TemplateBlockPayload | null {
  if (!isRecord(json)) return null
  const { id, action, base_template_id, document } = json
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) return null
  if (action !== 'apply' && action !== 'create-version') return null

  if (action === 'create-version') {
    // create-version REQUIRES a base template to version from.
    if (!isUuid(base_template_id)) return null
  } else if (base_template_id !== undefined && !isUuid(base_template_id)) {
    return null
  }

  const parsedDocument = parseTemplateDocument(document)
  if (!parsedDocument) return null

  return {
    id,
    action,
    base_template_id: typeof base_template_id === 'string' ? base_template_id : undefined,
    document: parsedDocument
  }
}

function parseRecoveryPlanItem(json: unknown): RecoveryPlanItemPayload | null {
  if (!isRecord(json)) return null
  const {
    name,
    kind,
    start_week,
    weekly_target,
    green_min,
    yellow_min,
    target_sets,
    target_reps,
    steps,
    note
  } = json

  if (!isBoundedString(name, 200)) return null
  if (typeof kind !== 'string' || !(RECOVERY_PLAN_ITEM_KINDS as readonly string[]).includes(kind)) {
    return null
  }

  const optionalNonNegInt = (value: unknown): boolean => value === undefined || isNonNegInt(value)
  if (
    !optionalNonNegInt(start_week) ||
    !optionalNonNegInt(weekly_target) ||
    !optionalNonNegInt(green_min) ||
    !optionalNonNegInt(yellow_min) ||
    !optionalNonNegInt(target_sets) ||
    !optionalNonNegInt(target_reps)
  ) {
    return null
  }
  if (!isOptionalBoundedString(note, 1000)) return null
  if (steps !== undefined && !Array.isArray(steps)) return null

  return {
    name,
    kind: kind as RecoveryPlanItemKind,
    start_week: start_week as number | undefined,
    weekly_target: weekly_target as number | undefined,
    green_min: green_min as number | undefined,
    yellow_min: yellow_min as number | undefined,
    target_sets: target_sets as number | undefined,
    target_reps: target_reps as number | undefined,
    steps: steps as unknown[] | undefined,
    note: typeof note === 'string' ? note : undefined
  }
}

function parseRecoveryPlanDocument(json: unknown): RecoveryPlanDocumentPayload | null {
  if (!isRecord(json)) return null
  const { approach, items } = json
  if (!isBoundedString(approach, 4000)) return null
  if (!Array.isArray(items) || items.length < 1 || items.length > 16) return null

  const parsedItems: RecoveryPlanItemPayload[] = []
  for (const raw of items) {
    const parsed = parseRecoveryPlanItem(raw)
    if (!parsed) return null
    parsedItems.push(parsed)
  }
  return { approach, items: parsedItems }
}

function parseRecoveryPlanPayload(json: unknown): RecoveryPlanBlockPayload | null {
  if (!isRecord(json)) return null
  const { id, injury_id, document } = json
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) return null
  if (!isUuid(injury_id)) return null

  const parsedDocument = parseRecoveryPlanDocument(document)
  if (!parsedDocument) return null

  return { id, injury_id, document: parsedDocument }
}

// ── entry point ──────────────────────────────────────────────────────────

function buildBlock(language: ChatBlockLanguage, json: unknown): ChatBlock | null {
  switch (language) {
    case 'alke:workout': {
      const payload = parseWorkoutPayload(json)
      return payload ? { kind: 'workout', payload } : null
    }
    case 'alke:metric': {
      const payload = parseMetricPayload(json)
      return payload ? { kind: 'metric', payload } : null
    }
    case 'alke:template': {
      const payload = parseTemplatePayload(json)
      return payload ? { kind: 'template', payload } : null
    }
    case 'alke:recovery-plan': {
      const payload = parseRecoveryPlanPayload(json)
      return payload ? { kind: 'recovery-plan', payload } : null
    }
    default: {
      const exhaustive: never = language
      return exhaustive
    }
  }
}

/**
 * Parse one fenced code block's (language, body) pair. `streaming` tells the
 * parser whether the surrounding message is still being written — while
 * streaming, a fence that hasn't closed yet will fail to parse (or validate)
 * for reasons that have nothing to do with the model's eventual output being
 * wrong, so those failures render a "preparing" skeleton instead of an error
 * or a premature code-block fallback.
 */
export function parseChatBlock(
  language: string,
  body: string,
  streaming: boolean
): ParseChatBlockResult {
  if (!isChatBlockLanguage(language)) return { status: 'not-a-block' }

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return streaming ? { status: 'pending' } : { status: 'invalid' }
  }

  const block = buildBlock(language, json)
  if (!block) return streaming ? { status: 'pending' } : { status: 'invalid' }
  return { status: 'ok', block }
}
