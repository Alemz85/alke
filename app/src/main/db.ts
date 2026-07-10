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
  type Flag,
  type Injury,
  type InjuryLogEntry,
  type NewInjuryLog,
  type PlanItemCheck,
  type RecoveryPlanItem,
  type UserConfig,
  type UserConfigPatch,
  type Workout,
  type WorkoutDetail,
  type WorkoutHrSample
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

const USER_CONFIG_COLUMNS =
  'id, hr_max, swim_hr_offset, zone2_low_frac, zone2_high_frac, zone2_weekly_target_min, weekly_min_sessions, timezone'

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

  const [{ data: hrSamples, error: hrError }, { data: computed, error: computedError }] =
    await Promise.all([
      supabase
        .from('workout_hr_samples')
        .select('workout_id, offset_s, bpm')
        .eq('workout_id', id)
        .order('offset_s', { ascending: true }),
      supabase.from('computed_workout').select(COMPUTED_WORKOUT_COLUMNS).eq('workout_id', id).maybeSingle()
    ])

  if (hrError) throw new Error(`getWorkoutDetail (hr samples): ${hrError.message}`)
  if (computedError) throw new Error(`getWorkoutDetail (computed): ${computedError.message}`)

  return {
    workout: normalizeNumeric(workout as Workout, WORKOUT_NUMERIC_KEYS),
    hrSamples: (hrSamples ?? []) as WorkoutHrSample[],
    computed: computed
      ? normalizeNumeric(computed as ComputedWorkout, COMPUTED_WORKOUT_NUMERIC_KEYS)
      : null
  }
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
