import WebSocket from 'ws'

// supabase-js requires a global WebSocket (native in Node 22+); Electron's
// bundled Node may be older, so polyfill before the client is created.
if (typeof globalThis.WebSocket === 'undefined') {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket
}

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  INJURY_CONTEXTS,
  type InsightCorrelation,
  type InsightModel,
  type ChatMessage,
  type ChatSession,
  type ChatSessionMeta,
  type ComputedDaily,
  type ComputedWorkout,
  type DailyMetric,
  type DbStatus,
  type Exercise,
  type Flag,
  type Goal,
  type GoalPatch,
  type GoalProgressPoint,
  type GymSession,
  type GymSessionPatch,
  type GymSet,
  type GymTemplate,
  type GymTemplateItem,
  type GymTemplatePatch,
  type Injury,
  type InjuryLogEntry,
  type NewGoal,
  type NewGymSession,
  type NewGymSet,
  type NewGymTemplate,
  type NewGymTemplateItem,
  type NewInjuryLog,
  type PlanItemCheck,
  type RecoveryPlanItem,
  type SwimSet,
  type UserConfig,
  type UserConfigPatch,
  type Workout,
  type WorkoutDetail,
  type WorkoutHrSample,
  type Zone2Fitness
} from '@shared/types'

let client: SupabaseClient | null = null
let initError: string | null = null

function getClient(): SupabaseClient {
  if (client) return client

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) {
    initError = 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment (.env)'
    throw new Error(initError)
  }

  client = createClient(url, key, {
    auth: { persistSession: false }
  })
  return client
}

// PostgREST sometimes serializes numeric/decimal columns as strings.
// Normalize any of the given keys on an object to `number | null`.
function normalizeNumeric<T>(row: T, keys: (keyof T)[]): T {
  const out = row as Record<string, unknown>
  for (const key of keys) {
    const value = out[key as string]
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      const n = Number(value)
      out[key as string] = Number.isNaN(n) ? null : n
    }
  }
  return row
}

const WORKOUT_NUMERIC_KEYS: (keyof Workout)[] = [
  'duration_s',
  'distance_m',
  'energy_kcal',
  'avg_hr',
  'max_hr'
]

const COMPUTED_WORKOUT_NUMERIC_KEYS: (keyof ComputedWorkout)[] = [
  'trimp',
  'ef',
  'decoupling_pct',
  'hrr60'
]

const DAILY_METRIC_NUMERIC_KEYS: (keyof DailyMetric)[] = [
  'resting_hr',
  'hrv_sdnn_ms',
  'respiratory_rate',
  'sleep_duration_min',
  'vo2max',
  'steps',
  'active_energy_kcal',
  'wrist_temp_deviation_c',
  'weight_kg'
]

const COMPUTED_DAILY_NUMERIC_KEYS: (keyof ComputedDaily)[] = [
  'trimp_total',
  'ctl',
  'atl',
  'tsb',
  'acwr',
  'rhr_baseline_60d',
  'rhr_dev',
  'hrv_baseline_60d',
  'hrv_dev'
]

const ZONE2_FITNESS_NUMERIC_KEYS: (keyof Zone2Fitness)[] = [
  'durable_base',
  'durable_band_lo',
  'durable_band_hi',
  'sharpness',
  'vo2max_anchor_score',
  'days_since_vo2max',
  'durable_load',
  'sharp_load',
  'base_accum_b',
  'tau_slow_days',
  'floor_score',
  'confidence',
  'warn_after_days',
  'maintain_horizon_days',
  'build_interval_days',
  'expected_session_build'
]

const USER_CONFIG_NUMERIC_KEYS: (keyof UserConfig)[] = [
  'hr_max',
  'swim_hr_offset',
  'zone2_low_frac',
  'zone2_high_frac',
  'zone2_weekly_target_min'
]

// Whitelist of user_config columns that may be modified via updateUserConfig.
// `id` is intentionally excluded — it is fixed at 1.
const USER_CONFIG_EDITABLE_KEYS: (keyof UserConfigPatch)[] = [
  'hr_max',
  'swim_hr_offset',
  'zone2_low_frac',
  'zone2_high_frac',
  'zone2_weekly_target_min',
  'weekly_min_sessions',
  'timezone'
]

const WORKOUT_COLUMNS =
  'id, external_id, type, start_at, end_at, duration_s, distance_m, energy_kcal, avg_hr, max_hr, source, raw'

const COMPUTED_WORKOUT_COLUMNS =
  'workout_id, time_in_zones, trimp, ef, decoupling_pct, hrr60, computed_at'

const DAILY_METRIC_COLUMNS =
  'date, resting_hr, hrv_sdnn_ms, respiratory_rate, sleep_start, sleep_end, sleep_duration_min, sleep_stages, vo2max, steps, active_energy_kcal, wrist_temp_deviation_c, weight_kg, state_of_mind'

const COMPUTED_DAILY_COLUMNS =
  'date, trimp_total, ctl, atl, tsb, acwr, rhr_baseline_60d, rhr_dev, hrv_baseline_60d, hrv_dev, flags, computed_at'

const ZONE2_FITNESS_COLUMNS =
  'date, durable_base, durable_band_lo, durable_band_hi, sharpness, vo2max_anchor_score, days_since_vo2max, durable_load, sharp_load, base_accum_b, tau_slow_days, floor_score, confidence, evidence_state, contributing, stage, maintenance_met, warn_after_days, maintain_horizon_days, build_interval_days, expected_session_build, flags, computed_at'

const USER_CONFIG_COLUMNS =
  'id, hr_max, swim_hr_offset, zone2_low_frac, zone2_high_frac, zone2_weekly_target_min, weekly_min_sessions, timezone'

const SWIM_SET_COLUMNS =
  'workout_id, set_index, start_offset_s, duration_s, distance_m, strokes, rest_after_s'

const SWIM_SET_NUMERIC_KEYS: (keyof SwimSet)[] = [
  'set_index',
  'start_offset_s',
  'duration_s',
  'distance_m',
  'strokes',
  'rest_after_s'
]

export async function getWorkouts(fromIso: string, toIso: string): Promise<Workout[]> {
  const supabase = getClient()

  const { data: workouts, error } = await supabase
    .from('workouts')
    .select(WORKOUT_COLUMNS)
    .gte('start_at', fromIso)
    .lte('start_at', toIso)
    .order('start_at', { ascending: false })

  if (error) throw new Error(`getWorkouts: ${error.message}`)
  if (!workouts || workouts.length === 0) return []

  const ids = workouts.map((w) => w.id)
  const { data: computedRows, error: computedError } = await supabase
    .from('computed_workout')
    .select(COMPUTED_WORKOUT_COLUMNS)
    .in('workout_id', ids)

  if (computedError) throw new Error(`getWorkouts (computed join): ${computedError.message}`)

  const computedById = new Map<string, ComputedWorkout>()
  for (const row of computedRows ?? []) {
    const normalized = normalizeNumeric(row as ComputedWorkout, COMPUTED_WORKOUT_NUMERIC_KEYS)
    computedById.set(normalized.workout_id, normalized)
  }

  return workouts.map((w) => {
    const workout = normalizeNumeric(w as Workout, WORKOUT_NUMERIC_KEYS)
    return {
      ...workout,
      computed: computedById.get(workout.id) ?? null
    }
  })
}

export async function getWorkoutDetail(id: string): Promise<WorkoutDetail> {
  const supabase = getClient()

  const { data: workout, error } = await supabase
    .from('workouts')
    .select(WORKOUT_COLUMNS)
    .eq('id', id)
    .single()

  if (error) throw new Error(`getWorkoutDetail: ${error.message}`)

  const [
    { data: hrSamples, error: hrError },
    { data: computed, error: computedError },
    { data: swimSets, error: swimSetsError }
  ] = await Promise.all([
    supabase
      .from('workout_hr_samples')
      .select('workout_id, offset_s, bpm')
      .eq('workout_id', id)
      .order('offset_s', { ascending: true }),
    supabase.from('computed_workout').select(COMPUTED_WORKOUT_COLUMNS).eq('workout_id', id).maybeSingle(),
    supabase
      .from('swim_sets')
      .select(SWIM_SET_COLUMNS)
      .eq('workout_id', id)
      .order('set_index', { ascending: true })
  ])

  if (hrError) throw new Error(`getWorkoutDetail (hr samples): ${hrError.message}`)
  if (computedError) throw new Error(`getWorkoutDetail (computed): ${computedError.message}`)
  if (swimSetsError) throw new Error(`getWorkoutDetail (swim sets): ${swimSetsError.message}`)

  return {
    workout: normalizeNumeric(workout as Workout, WORKOUT_NUMERIC_KEYS),
    hrSamples: (hrSamples ?? []) as WorkoutHrSample[],
    swimSets: (swimSets ?? []).map((row) => normalizeNumeric(row as SwimSet, SWIM_SET_NUMERIC_KEYS)),
    computed: computed
      ? normalizeNumeric(computed as ComputedWorkout, COMPUTED_WORKOUT_NUMERIC_KEYS)
      : null
  }
}

/** Swim sets for all swim workouts starting in [fromIso, toIso], for trend views. */
export async function getSwimSets(fromIso: string, toIso: string): Promise<SwimSet[]> {
  const supabase = getClient()

  const { data: swims, error: swimsError } = await supabase
    .from('workouts')
    .select('id')
    .ilike('type', '%swim%')
    .gte('start_at', fromIso)
    .lte('start_at', toIso)
  if (swimsError) throw new Error(`getSwimSets (workouts): ${swimsError.message}`)
  if (!swims || swims.length === 0) return []

  const { data, error } = await supabase
    .from('swim_sets')
    .select(SWIM_SET_COLUMNS)
    .in('workout_id', swims.map((w) => w.id))
    .order('workout_id', { ascending: true })
    .order('set_index', { ascending: true })
  if (error) throw new Error(`getSwimSets: ${error.message}`)

  return (data ?? []).map((row) => normalizeNumeric(row as SwimSet, SWIM_SET_NUMERIC_KEYS))
}

export async function getDailyMetrics(fromDate: string, toDate: string): Promise<DailyMetric[]> {
  const supabase = getClient()

  const { data, error } = await supabase
    .from('daily_metrics')
    .select(DAILY_METRIC_COLUMNS)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date', { ascending: true })

  if (error) throw new Error(`getDailyMetrics: ${error.message}`)

  return (data ?? []).map((row) =>
    normalizeNumeric(row as DailyMetric, DAILY_METRIC_NUMERIC_KEYS)
  )
}

export async function getComputedDaily(
  fromDate: string,
  toDate: string
): Promise<ComputedDaily[]> {
  const supabase = getClient()

  const { data, error } = await supabase
    .from('computed_daily')
    .select(COMPUTED_DAILY_COLUMNS)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date', { ascending: true })

  if (error) throw new Error(`getComputedDaily: ${error.message}`)

  return (data ?? []).map((row) =>
    normalizeNumeric(row as ComputedDaily, COMPUTED_DAILY_NUMERIC_KEYS)
  )
}

export async function getZone2Fitness(fromDate: string, toDate: string): Promise<Zone2Fitness[]> {
  assertDate(fromDate, 'fromDate')
  assertDate(toDate, 'toDate')

  const supabase = getClient()

  const { data, error } = await supabase
    .from('computed_zone2_fitness')
    .select(ZONE2_FITNESS_COLUMNS)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date', { ascending: true })

  if (error) throw new Error(`getZone2Fitness: ${error.message}`)

  return (data ?? []).map((row) =>
    normalizeNumeric(row as Zone2Fitness, ZONE2_FITNESS_NUMERIC_KEYS)
  )
}

export async function getUserConfig(): Promise<UserConfig> {
  const supabase = getClient()

  const { data, error } = await supabase
    .from('user_config')
    .select(USER_CONFIG_COLUMNS)
    .eq('id', 1)
    .single()

  if (error) throw new Error(`getUserConfig: ${error.message}`)

  return normalizeNumeric(data as UserConfig, USER_CONFIG_NUMERIC_KEYS)
}

export async function updateUserConfig(patch: UserConfigPatch): Promise<UserConfig> {
  const supabase = getClient()

  // Whitelist-filter: only editable keys pass through, `id` can never be
  // targeted (it's fixed at 1 by the table's check constraint anyway).
  const update: Record<string, unknown> = {}
  for (const key of USER_CONFIG_EDITABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      update[key] = (patch as Record<string, unknown>)[key]
    }
  }

  const numericFields: (keyof UserConfigPatch)[] = [
    'hr_max',
    'swim_hr_offset',
    'zone2_low_frac',
    'zone2_high_frac',
    'zone2_weekly_target_min'
  ]
  for (const field of numericFields) {
    if (field in update) {
      const value = update[field]
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`updateUserConfig: ${field} must be a finite number or null`)
      }
    }
  }

  if ('timezone' in update) {
    const tz = update.timezone
    if (tz !== null) {
      if (typeof tz !== 'string' || !Intl.supportedValuesOf('timeZone').includes(tz)) {
        throw new Error(`updateUserConfig: timezone "${String(tz)}" is not a recognized IANA timezone`)
      }
    }
  }

  if ('weekly_min_sessions' in update) {
    const sessions = update.weekly_min_sessions
    if (sessions !== null) {
      if (typeof sessions !== 'object' || Array.isArray(sessions)) {
        throw new Error('updateUserConfig: weekly_min_sessions must be an object')
      }
      for (const [k, v] of Object.entries(sessions as Record<string, unknown>)) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          throw new Error(
            `updateUserConfig: weekly_min_sessions.${k} must be a non-negative integer`
          )
        }
      }
    }
  }

  if (Object.keys(update).length === 0) {
    return getUserConfig()
  }

  const { data, error } = await supabase
    .from('user_config')
    .update(update)
    .eq('id', 1)
    .select(USER_CONFIG_COLUMNS)
    .single()

  if (error) throw new Error(`updateUserConfig: ${error.message}`)

  return normalizeNumeric(data as UserConfig, USER_CONFIG_NUMERIC_KEYS)
}

export async function getTodayFlags(): Promise<Flag[]> {
  const supabase = getClient()
  const today = new Date().toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('computed_daily')
    .select('flags')
    .eq('date', today)
    .maybeSingle()

  if (error) throw new Error(`getTodayFlags: ${error.message}`)
  if (!data || !data.flags) return []

  return Array.isArray(data.flags) ? (data.flags as Flag[]) : []
}

const INJURY_COLUMNS =
  'id, name, body_area, status, severity, started_at, resolved_at, summary, recovery_plan, created_at, updated_at'

const INJURY_LOG_COLUMNS =
  'id, injury_id, entry_date, noted_at, source, note, pain_level, context, workout_id'

const INJURY_LOG_NUMERIC_KEYS: (keyof InjuryLogEntry)[] = ['pain_level']

const RECOVERY_PLAN_ITEM_COLUMNS =
  'id, injury_id, name, kind, weekly_target, note, active, created_at, updated_at'

const RECOVERY_PLAN_ITEM_NUMERIC_KEYS: (keyof RecoveryPlanItem)[] = ['weekly_target']

const PLAN_ITEM_CHECK_COLUMNS = 'id, item_id, done_date, source'

const UUID_RE_GENERIC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function assertUuid(id: unknown, label: string): void {
  if (typeof id !== 'string' || !UUID_RE_GENERIC.test(id)) throw new Error(`invalid ${label}`)
}

function assertDate(date: unknown, label: string): void {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new Error(`invalid ${label}`)
}

// Read-only: injuries/injury_notes are written exclusively by the chat agent's
// separate injuries.py helper (chatctx/injuries.py), not by the app.
export async function getInjuries(): Promise<Injury[]> {
  const supabase = getClient()

  const { data, error } = await supabase
    .from('injuries')
    .select(INJURY_COLUMNS)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(`getInjuries: ${error.message}`)

  return (data ?? []) as Injury[]
}

export async function getInjuryLog(injuryId: string): Promise<InjuryLogEntry[]> {
  const supabase = getClient()

  const { data, error } = await supabase
    .from('injury_notes')
    .select(INJURY_LOG_COLUMNS)
    .eq('injury_id', injuryId)
    .order('entry_date', { ascending: false })

  if (error) throw new Error(`getInjuryLog: ${error.message}`)

  return (data ?? []).map((row) => normalizeNumeric(row as InjuryLogEntry, INJURY_LOG_NUMERIC_KEYS))
}

export async function addInjuryLog(entry: NewInjuryLog): Promise<InjuryLogEntry> {
  const supabase = getClient()

  assertUuid(entry.injury_id, 'injury_id')

  if (typeof entry.note !== 'string' || entry.note.trim().length === 0 || entry.note.length > 2000) {
    throw new Error('invalid note')
  }

  if (
    entry.pain_level !== null &&
    (typeof entry.pain_level !== 'number' ||
      !Number.isInteger(entry.pain_level) ||
      entry.pain_level < 0 ||
      entry.pain_level > 10)
  ) {
    throw new Error('invalid pain_level')
  }

  if (
    !Array.isArray(entry.context) ||
    !entry.context.every((c) => (INJURY_CONTEXTS as readonly string[]).includes(c))
  ) {
    throw new Error('invalid context')
  }

  if (entry.workout_id !== null && entry.workout_id !== undefined) {
    assertUuid(entry.workout_id, 'workout_id')
  }

  if (entry.entry_date !== undefined) {
    assertDate(entry.entry_date, 'entry_date')
  }

  const row: Record<string, unknown> = {
    injury_id: entry.injury_id,
    note: entry.note,
    pain_level: entry.pain_level,
    context: entry.context,
    workout_id: entry.workout_id ?? null,
    source: 'user'
  }
  if (entry.entry_date !== undefined) {
    row.entry_date = entry.entry_date
  }

  const { data, error } = await supabase
    .from('injury_notes')
    .insert(row)
    .select(INJURY_LOG_COLUMNS)
    .single()

  if (error) throw new Error(`addInjuryLog: ${error.message}`)

  return normalizeNumeric(data as InjuryLogEntry, INJURY_LOG_NUMERIC_KEYS)
}

export async function getInjuryPlan(injuryId: string): Promise<RecoveryPlanItem[]> {
  const supabase = getClient()

  assertUuid(injuryId, 'injury_id')

  const { data, error } = await supabase
    .from('recovery_plan_items')
    .select(RECOVERY_PLAN_ITEM_COLUMNS)
    .eq('injury_id', injuryId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`getInjuryPlan: ${error.message}`)

  return (data ?? []).map((row) =>
    normalizeNumeric(row as RecoveryPlanItem, RECOVERY_PLAN_ITEM_NUMERIC_KEYS)
  )
}

export async function getInjuryPlanChecks(
  injuryId: string,
  fromDate: string
): Promise<PlanItemCheck[]> {
  const supabase = getClient()

  assertUuid(injuryId, 'injury_id')
  assertDate(fromDate, 'fromDate')

  const { data: items, error: itemsError } = await supabase
    .from('recovery_plan_items')
    .select('id')
    .eq('injury_id', injuryId)

  if (itemsError) throw new Error(`getInjuryPlanChecks (items): ${itemsError.message}`)
  if (!items || items.length === 0) return []

  const itemIds = items.map((item) => item.id)

  const { data: checks, error: checksError } = await supabase
    .from('plan_item_checks')
    .select(PLAN_ITEM_CHECK_COLUMNS)
    .in('item_id', itemIds)
    .gte('done_date', fromDate)

  if (checksError) throw new Error(`getInjuryPlanChecks: ${checksError.message}`)

  return (checks ?? []) as PlanItemCheck[]
}

export async function setPlanItemCheck(
  itemId: string,
  doneDate: string,
  done: boolean
): Promise<void> {
  const supabase = getClient()

  assertUuid(itemId, 'item_id')
  assertDate(doneDate, 'doneDate')

  if (done) {
    const { error } = await supabase
      .from('plan_item_checks')
      .upsert(
        { item_id: itemId, done_date: doneDate, source: 'user' },
        { onConflict: 'item_id,done_date', ignoreDuplicates: true }
      )

    if (error) throw new Error(`setPlanItemCheck: ${error.message}`)
  } else {
    const { error } = await supabase
      .from('plan_item_checks')
      .delete()
      .eq('item_id', itemId)
      .eq('done_date', doneDate)

    if (error) throw new Error(`setPlanItemCheck: ${error.message}`)
  }
}

// ---- Gym lifting (exercises catalog, templates, session logs) ----
// All writes hardwire source='user' server-side; the chat agent gets its own
// scoped helper (chatctx) if/when chat logging lands.

const EXERCISE_COLUMNS = 'id, name, muscle_group, created_at'

const GYM_TEMPLATE_COLUMNS = 'id, name, notes, archived, created_at, updated_at'

const GYM_TEMPLATE_ITEM_COLUMNS =
  'id, template_id, exercise_id, position, target_sets, target_reps, target_weight_kg, note'

const GYM_TEMPLATE_ITEM_NUMERIC_KEYS: (keyof GymTemplateItem)[] = [
  'position',
  'target_sets',
  'target_reps',
  'target_weight_kg'
]

const GYM_SESSION_COLUMNS =
  'id, workout_id, template_id, performed_at, title, notes, source, created_at, updated_at'

const GYM_SET_COLUMNS =
  'id, session_id, exercise_id, position, reps, weight_kg, rpe, is_warmup, note'

const GYM_SET_NUMERIC_KEYS: (keyof GymSet)[] = ['position', 'reps', 'weight_kg', 'rpe']

function assertInstant(value: unknown, label: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`invalid ${label}`)
  }
}

function assertOptionalText(value: unknown, label: string, max: number): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'string' || value.length > max) throw new Error(`invalid ${label}`)
}

function assertOptionalInt(value: unknown, label: string, min: number, max: number): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${label}`)
  }
}

function assertOptionalNumber(value: unknown, label: string, min: number, max: number): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`invalid ${label}`)
  }
}

function assertGymSets(sets: unknown): asserts sets is NewGymSet[] {
  if (!Array.isArray(sets) || sets.length > 200) throw new Error('invalid sets')
  for (const set of sets) {
    assertUuid(set.exercise_id, 'sets[].exercise_id')
    assertOptionalInt(set.reps, 'sets[].reps', 0, 500)
    assertOptionalNumber(set.weight_kg, 'sets[].weight_kg', 0, 1500)
    assertOptionalNumber(set.rpe, 'sets[].rpe', 1, 10)
    if (set.is_warmup !== undefined && typeof set.is_warmup !== 'boolean') {
      throw new Error('invalid sets[].is_warmup')
    }
    assertOptionalText(set.note, 'sets[].note', 500)
  }
}

function assertTemplateItems(items: unknown): asserts items is NewGymTemplateItem[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    throw new Error('a template needs 1–50 exercises')
  }
  for (const item of items) {
    assertUuid(item.exercise_id, 'items[].exercise_id')
    assertOptionalInt(item.target_sets, 'items[].target_sets', 1, 50)
    assertOptionalInt(item.target_reps, 'items[].target_reps', 1, 500)
    assertOptionalNumber(item.target_weight_kg, 'items[].target_weight_kg', 0, 1500)
    assertOptionalText(item.note, 'items[].note', 500)
  }
}

/** Map of exercises.id → name for the given ids (deduped; empty map for []). */
async function exerciseNamesById(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const { data, error } = await getClient().from('exercises').select('id, name').in('id', unique)
  if (error) throw new Error(`exerciseNamesById: ${error.message}`)
  return new Map((data ?? []).map((row) => [row.id as string, row.name as string]))
}

export async function getExercises(): Promise<Exercise[]> {
  const { data, error } = await getClient()
    .from('exercises')
    .select(EXERCISE_COLUMNS)
    .order('name', { ascending: true })
  if (error) throw new Error(`getExercises: ${error.message}`)
  return (data ?? []) as Exercise[]
}

// Create-on-type from the autocomplete. Case-insensitively idempotent: a name
// that already exists (any casing) returns the existing catalog row.
export async function addExercise(name: string, muscleGroup: string | null): Promise<Exercise> {
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 120) {
    throw new Error('invalid name')
  }
  assertOptionalText(muscleGroup, 'muscle_group', 40)
  const trimmed = name.trim()
  const group = muscleGroup?.trim() || null

  const supabase = getClient()
  const { data, error } = await supabase
    .from('exercises')
    .insert({ name: trimmed, muscle_group: group })
    .select(EXERCISE_COLUMNS)
    .single()

  if (!error) return data as Exercise
  // 23505 = unique violation on name_key → the exercise already exists.
  if (error.code !== '23505') throw new Error(`addExercise: ${error.message}`)

  const { data: existing, error: lookupError } = await supabase
    .from('exercises')
    .select(EXERCISE_COLUMNS)
    .eq('name_key', trimmed.toLowerCase())
    .single()
  if (lookupError) throw new Error(`addExercise (lookup): ${lookupError.message}`)
  return existing as Exercise
}

async function getGymTemplateById(id: string): Promise<GymTemplate> {
  const supabase = getClient()
  const { data: template, error } = await supabase
    .from('gym_templates')
    .select(GYM_TEMPLATE_COLUMNS)
    .eq('id', id)
    .single()
  if (error) throw new Error(`getGymTemplateById: ${error.message}`)

  const { data: items, error: itemsError } = await supabase
    .from('gym_template_exercises')
    .select(GYM_TEMPLATE_ITEM_COLUMNS)
    .eq('template_id', id)
    .order('position', { ascending: true })
  if (itemsError) throw new Error(`getGymTemplateById (items): ${itemsError.message}`)

  const names = await exerciseNamesById((items ?? []).map((item) => item.exercise_id))
  return {
    ...(template as Omit<GymTemplate, 'items'>),
    items: (items ?? []).map((row) => ({
      ...normalizeNumeric(row as GymTemplateItem, GYM_TEMPLATE_ITEM_NUMERIC_KEYS),
      exercise_name: names.get(row.exercise_id) ?? '?'
    }))
  }
}

export async function getGymTemplates(): Promise<GymTemplate[]> {
  const supabase = getClient()
  const { data: templates, error } = await supabase
    .from('gym_templates')
    .select(GYM_TEMPLATE_COLUMNS)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`getGymTemplates: ${error.message}`)
  if (!templates || templates.length === 0) return []

  const { data: items, error: itemsError } = await supabase
    .from('gym_template_exercises')
    .select(GYM_TEMPLATE_ITEM_COLUMNS)
    .in('template_id', templates.map((t) => t.id))
    .order('position', { ascending: true })
  if (itemsError) throw new Error(`getGymTemplates (items): ${itemsError.message}`)

  const names = await exerciseNamesById((items ?? []).map((item) => item.exercise_id))
  const itemsByTemplate = new Map<string, GymTemplateItem[]>()
  for (const row of items ?? []) {
    const item = {
      ...normalizeNumeric(row as GymTemplateItem, GYM_TEMPLATE_ITEM_NUMERIC_KEYS),
      exercise_name: names.get(row.exercise_id) ?? '?'
    }
    const list = itemsByTemplate.get(item.template_id)
    if (list) list.push(item)
    else itemsByTemplate.set(item.template_id, [item])
  }

  return templates.map((t) => ({
    ...(t as Omit<GymTemplate, 'items'>),
    items: itemsByTemplate.get(t.id) ?? []
  }))
}

async function insertTemplateItems(templateId: string, items: NewGymTemplateItem[]): Promise<void> {
  const rows = items.map((item, index) => ({
    template_id: templateId,
    exercise_id: item.exercise_id,
    position: index,
    target_sets: item.target_sets,
    target_reps: item.target_reps,
    target_weight_kg: item.target_weight_kg,
    note: item.note ?? null
  }))
  const { error } = await getClient().from('gym_template_exercises').insert(rows)
  if (error) throw new Error(`insertTemplateItems: ${error.message}`)
}

export async function addGymTemplate(template: NewGymTemplate): Promise<GymTemplate> {
  if (
    typeof template.name !== 'string' ||
    template.name.trim().length === 0 ||
    template.name.trim().length > 120
  ) {
    throw new Error('invalid name')
  }
  assertOptionalText(template.notes, 'notes', 2000)
  assertTemplateItems(template.items)

  const supabase = getClient()
  const { data, error } = await supabase
    .from('gym_templates')
    .insert({ name: template.name.trim(), notes: template.notes })
    .select(GYM_TEMPLATE_COLUMNS)
    .single()
  if (error) throw new Error(`addGymTemplate: ${error.message}`)

  try {
    await insertTemplateItems(data.id, template.items)
  } catch (err) {
    // No transactions over PostgREST — best-effort rollback of the header row.
    await supabase.from('gym_templates').delete().eq('id', data.id)
    throw err
  }
  return getGymTemplateById(data.id)
}

export async function updateGymTemplate(id: string, patch: GymTemplatePatch): Promise<GymTemplate> {
  assertUuid(id, 'template_id')

  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim().length === 0 || patch.name.trim().length > 120) {
      throw new Error('invalid name')
    }
    row.name = patch.name.trim()
  }
  if (patch.notes !== undefined) {
    assertOptionalText(patch.notes, 'notes', 2000)
    row.notes = patch.notes
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== 'boolean') throw new Error('invalid archived')
    row.archived = patch.archived
  }
  if (patch.items !== undefined) assertTemplateItems(patch.items)

  const supabase = getClient()
  const { error } = await supabase.from('gym_templates').update(row).eq('id', id)
  if (error) throw new Error(`updateGymTemplate: ${error.message}`)

  if (patch.items !== undefined) {
    const { error: deleteError } = await supabase
      .from('gym_template_exercises')
      .delete()
      .eq('template_id', id)
    if (deleteError) throw new Error(`updateGymTemplate (clear items): ${deleteError.message}`)
    await insertTemplateItems(id, patch.items)
  }
  return getGymTemplateById(id)
}

function toGymSet(row: Record<string, unknown>, names: Map<string, string>): GymSet {
  return {
    ...normalizeNumeric(row as unknown as GymSet, GYM_SET_NUMERIC_KEYS),
    exercise_name: names.get(row.exercise_id as string) ?? '?'
  }
}

async function getGymSessionById(id: string): Promise<GymSession> {
  const supabase = getClient()
  const { data: session, error } = await supabase
    .from('gym_sessions')
    .select(GYM_SESSION_COLUMNS)
    .eq('id', id)
    .single()
  if (error) throw new Error(`getGymSessionById: ${error.message}`)

  const { data: sets, error: setsError } = await supabase
    .from('gym_sets')
    .select(GYM_SET_COLUMNS)
    .eq('session_id', id)
    .order('position', { ascending: true })
  if (setsError) throw new Error(`getGymSessionById (sets): ${setsError.message}`)

  const names = await exerciseNamesById((sets ?? []).map((s) => s.exercise_id))
  return {
    ...(session as Omit<GymSession, 'sets'>),
    sets: (sets ?? []).map((row) => toGymSet(row, names))
  }
}

export async function getGymSessions(fromIso: string, toIso: string): Promise<GymSession[]> {
  const supabase = getClient()
  const { data: sessions, error } = await supabase
    .from('gym_sessions')
    .select(GYM_SESSION_COLUMNS)
    .gte('performed_at', fromIso)
    .lte('performed_at', toIso)
    .order('performed_at', { ascending: false })
  if (error) throw new Error(`getGymSessions: ${error.message}`)
  if (!sessions || sessions.length === 0) return []

  const { data: sets, error: setsError } = await supabase
    .from('gym_sets')
    .select(GYM_SET_COLUMNS)
    .in('session_id', sessions.map((s) => s.id))
    .order('position', { ascending: true })
  if (setsError) throw new Error(`getGymSessions (sets): ${setsError.message}`)

  const names = await exerciseNamesById((sets ?? []).map((s) => s.exercise_id))
  const setsBySession = new Map<string, GymSet[]>()
  for (const row of sets ?? []) {
    const set = toGymSet(row, names)
    const list = setsBySession.get(set.session_id)
    if (list) list.push(set)
    else setsBySession.set(set.session_id, [set])
  }

  return sessions.map((s) => ({
    ...(s as Omit<GymSession, 'sets'>),
    sets: setsBySession.get(s.id) ?? []
  }))
}

async function insertGymSets(sessionId: string, sets: NewGymSet[]): Promise<void> {
  if (sets.length === 0) return
  const rows = sets.map((set, index) => ({
    session_id: sessionId,
    exercise_id: set.exercise_id,
    position: index,
    reps: set.reps,
    weight_kg: set.weight_kg,
    rpe: set.rpe ?? null,
    is_warmup: set.is_warmup ?? false,
    note: set.note ?? null
  }))
  const { error } = await getClient().from('gym_sets').insert(rows)
  if (error) throw new Error(`insertGymSets: ${error.message}`)
}

export async function addGymSession(session: NewGymSession): Promise<GymSession> {
  assertOptionalText(session.title, 'title', 120)
  assertOptionalText(session.notes, 'notes', 2000)
  if (session.template_id !== undefined && session.template_id !== null) {
    assertUuid(session.template_id, 'template_id')
  }
  assertGymSets(session.sets)

  const supabase = getClient()
  const row: Record<string, unknown> = {
    workout_id: session.workout_id ?? null,
    template_id: session.template_id ?? null,
    title: session.title ?? null,
    notes: session.notes ?? null,
    source: 'user'
  }

  if (session.workout_id !== undefined && session.workout_id !== null) {
    assertUuid(session.workout_id, 'workout_id')
    // performed_at is authoritative from the linked synced workout.
    const { data: workout, error: workoutError } = await supabase
      .from('workouts')
      .select('id, start_at')
      .eq('id', session.workout_id)
      .single()
    if (workoutError) throw new Error(`addGymSession (workout): ${workoutError.message}`)
    if (workout.start_at) row.performed_at = workout.start_at
  } else if (session.performed_at !== undefined) {
    assertInstant(session.performed_at, 'performed_at')
    row.performed_at = session.performed_at
  }

  const { data, error } = await supabase
    .from('gym_sessions')
    .insert(row)
    .select(GYM_SESSION_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('this workout already has a gym log')
    throw new Error(`addGymSession: ${error.message}`)
  }

  try {
    await insertGymSets(data.id, session.sets)
  } catch (err) {
    // No transactions over PostgREST — best-effort rollback of the header row.
    await supabase.from('gym_sessions').delete().eq('id', data.id)
    throw err
  }
  return getGymSessionById(data.id)
}

export async function updateGymSession(id: string, patch: GymSessionPatch): Promise<GymSession> {
  assertUuid(id, 'session_id')

  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) {
    assertOptionalText(patch.title, 'title', 120)
    row.title = patch.title
  }
  if (patch.notes !== undefined) {
    assertOptionalText(patch.notes, 'notes', 2000)
    row.notes = patch.notes
  }
  if (patch.template_id !== undefined) {
    if (patch.template_id !== null) assertUuid(patch.template_id, 'template_id')
    row.template_id = patch.template_id
  }
  if (patch.sets !== undefined) assertGymSets(patch.sets)

  const supabase = getClient()
  const { error } = await supabase.from('gym_sessions').update(row).eq('id', id)
  if (error) throw new Error(`updateGymSession: ${error.message}`)

  if (patch.sets !== undefined) {
    const { error: deleteError } = await supabase.from('gym_sets').delete().eq('session_id', id)
    if (deleteError) throw new Error(`updateGymSession (clear sets): ${deleteError.message}`)
    await insertGymSets(id, patch.sets)
  }
  return getGymSessionById(id)
}

export async function deleteGymSession(id: string): Promise<void> {
  assertUuid(id, 'session_id')
  const { error } = await getClient().from('gym_sessions').delete().eq('id', id)
  if (error) throw new Error(`deleteGymSession: ${error.message}`)
}

const GOAL_COLUMNS =
  'id, title, description, status, started_at, duration_days, created_by, metric_name, metric_description, metric_sql, metric_direction, metric_unit, metric_baseline, metric_target, created_at, updated_at'

const GOAL_NUMERIC_KEYS: (keyof Goal)[] = ['duration_days', 'metric_baseline', 'metric_target']

const GOAL_STATUSES = ['active', 'on_hold', 'completed', 'abandoned'] as const

function assertGoalTitle(title: unknown): void {
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
    throw new Error('invalid title')
  }
}

function assertGoalDescription(description: unknown): void {
  if (description !== null && (typeof description !== 'string' || description.length > 5000)) {
    throw new Error('invalid description')
  }
}

function assertGoalDuration(days: unknown): void {
  if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1)) {
    throw new Error('invalid duration_days')
  }
}

export async function getGoals(): Promise<Goal[]> {
  const supabase = getClient()

  const { data, error } = await supabase
    .from('goals')
    .select(GOAL_COLUMNS)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`getGoals: ${error.message}`)

  return (data ?? []).map((row) => normalizeNumeric(row as Goal, GOAL_NUMERIC_KEYS))
}

export async function getGoalProgress(goalId: string): Promise<GoalProgressPoint[]> {
  const supabase = getClient()

  assertUuid(goalId, 'goal_id')

  const { data, error } = await supabase
    .from('goal_progress')
    .select('goal_id, date, value')
    .eq('goal_id', goalId)
    .order('date', { ascending: true })

  if (error) throw new Error(`getGoalProgress: ${error.message}`)

  return (data ?? []).map((row) => normalizeNumeric(row as GoalProgressPoint, ['value']))
}

// Metric columns are agent-owned (written by chatctx/goals.py); the app only
// creates/edits the card fields the user declares.
export async function addGoal(goal: NewGoal): Promise<Goal> {
  const supabase = getClient()

  assertGoalTitle(goal.title)
  assertGoalDescription(goal.description)
  assertGoalDuration(goal.duration_days)
  if (goal.started_at !== undefined) assertDate(goal.started_at, 'started_at')

  const row: Record<string, unknown> = {
    title: goal.title.trim(),
    description: goal.description,
    duration_days: goal.duration_days,
    created_by: 'user'
  }
  if (goal.started_at !== undefined) row.started_at = goal.started_at

  const { data, error } = await supabase.from('goals').insert(row).select(GOAL_COLUMNS).single()

  if (error) throw new Error(`addGoal: ${error.message}`)

  return normalizeNumeric(data as Goal, GOAL_NUMERIC_KEYS)
}

export async function updateGoal(id: string, patch: GoalPatch): Promise<Goal> {
  const supabase = getClient()

  assertUuid(id, 'goal_id')

  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) {
    assertGoalTitle(patch.title)
    row.title = patch.title.trim()
  }
  if (patch.description !== undefined) {
    assertGoalDescription(patch.description)
    row.description = patch.description
  }
  if (patch.duration_days !== undefined) {
    assertGoalDuration(patch.duration_days)
    row.duration_days = patch.duration_days
  }
  if (patch.status !== undefined) {
    if (!(GOAL_STATUSES as readonly string[]).includes(patch.status)) {
      throw new Error('invalid status')
    }
    row.status = patch.status
  }

  const { data, error } = await supabase
    .from('goals')
    .update(row)
    .eq('id', id)
    .select(GOAL_COLUMNS)
    .single()

  if (error) throw new Error(`updateGoal: ${error.message}`)

  return normalizeNumeric(data as Goal, GOAL_NUMERIC_KEYS)
}

export async function getDbStatus(): Promise<DbStatus> {
  try {
    const supabase = getClient()
    const { error } = await supabase.from('user_config').select('id', { head: true, count: 'exact' })
    if (error) return { connected: false, error: error.message }
    return { connected: true }
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Most recent raw_payloads.received_at — the last moment Health Auto Export
 * POSTed anything. Doubles as a lightweight connectivity probe: it throws if
 * the DB is unreachable, so the Refresh button can distinguish "no new data"
 * from "couldn't reach the database". Null when the table is empty.
 */
export async function getLastIngestAt(): Promise<string | null> {
  const { data, error } = await getClient()
    .from('raw_payloads')
    .select('received_at')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`getLastIngestAt: ${error.message}`)
  return data?.received_at ?? null
}

export async function getInsightCorrelations(): Promise<InsightCorrelation[]> {
  const { data, error } = await getClient()
    .from('insight_correlations')
    .select('var_x, var_y, lag_days, r, n, p_value')
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) =>
    normalizeNumeric(row as unknown as InsightCorrelation, ['r', 'n', 'p_value', 'lag_days'])
  )
}

export async function getInsightModels(): Promise<InsightModel[]> {
  const { data, error } = await getClient()
    .from('insight_models')
    .select('name, computed_at, spec, coefficients, diagnostics')
  if (error) throw new Error(error.message)
  return (data ?? []) as InsightModel[]
}

export async function listChatSessions(): Promise<ChatSessionMeta[]> {
  const { data, error } = await getClient()
    .from('chat_sessions')
    .select('id, started_at, title')
    .order('started_at', { ascending: false })
  if (error) throw new Error(`listChatSessions: ${error.message}`)
  return (data ?? []) as ChatSessionMeta[]
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
  const { data, error } = await getClient()
    .from('chat_sessions')
    .select('id, started_at, title, claude_session_id, messages')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`getChatSession: ${error.message}`)
  return (data as ChatSession) ?? null
}

export async function createChatSession(title: string): Promise<ChatSession> {
  const { data, error } = await getClient()
    .from('chat_sessions')
    .insert({ title, messages: [] })
    .select('id, started_at, title, claude_session_id, messages')
    .single()
  if (error) throw new Error(`createChatSession: ${error.message}`)
  return data as ChatSession
}

export async function updateChatSession(
  id: string,
  patch: { messages?: ChatMessage[]; claude_session_id?: string }
): Promise<void> {
  const { error } = await getClient().from('chat_sessions').update(patch).eq('id', id)
  if (error) throw new Error(`updateChatSession: ${error.message}`)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertSessionId(id: unknown): void {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('invalid session id')
}

export async function renameChatSession(id: string, title: string): Promise<void> {
  assertSessionId(id)
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
    throw new Error('invalid title')
  }
  const { error } = await getClient().from('chat_sessions').update({ title }).eq('id', id)
  if (error) throw new Error(`renameChatSession: ${error.message}`)
}

export async function deleteChatSession(id: string): Promise<void> {
  assertSessionId(id)
  const { error } = await getClient().from('chat_sessions').delete().eq('id', id)
  if (error) throw new Error(`deleteChatSession: ${error.message}`)
}
