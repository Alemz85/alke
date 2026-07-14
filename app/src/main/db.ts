import WebSocket from 'ws'

// supabase-js requires a global WebSocket (native in Node 22+); Electron's
// bundled Node may be older, so polyfill before the client is created.
if (typeof globalThis.WebSocket === 'undefined') {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket
}

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  GYM_BODY_PARTS,
  INJURY_CONTEXTS,
  type GymBodyPart,
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
  type GymTemplateRun,
  type Injury,
  type InjuryLogEntry,
  type NewGoal,
  type NewGymSession,
  type NewGymSet,
  type NewGymTemplate,
  type NewGymTemplateItem,
  type NewInjuryLog,
  type PlanItemCheck,
  type ProteinDay,
  type RecoveryPlanItem,
  type RoutePoint,
  type SwimSet,
  type UserConfig,
  type UserConfigPatch,
  type Workout,
  type WorkoutDetail,
  type WorkoutGeo,
  type WorkoutPlace,
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
  'zone2_weekly_target_min',
  'sleep_goal_min',
  'bedtime_goal_min'
]

// Whitelist of user_config columns that may be modified via updateUserConfig.
// `id` is intentionally excluded — it is fixed at 1.
const USER_CONFIG_EDITABLE_KEYS: (keyof UserConfigPatch)[] = [
  'hr_max',
  'swim_hr_offset',
  'zone2_low_frac',
  'zone2_high_frac',
  'zone2_weekly_target_min',
  'sleep_goal_min',
  'bedtime_goal_min',
  'weekly_min_sessions',
  'timezone',
  'about_me'
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
  'id, hr_max, swim_hr_offset, zone2_low_frac, zone2_high_frac, zone2_weekly_target_min, sleep_goal_min, bedtime_goal_min, weekly_min_sessions, timezone, about_me'

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

const ROUTE_POINT_COLUMNS = 'workout_id, seq, lat, lon, elevation_m'

const ROUTE_POINT_NUMERIC_KEYS: (keyof RoutePoint)[] = ['seq', 'lat', 'lon', 'elevation_m']

const WORKOUT_GEO_COLUMNS = 'workout_id, city, country, admin, lat, lon, geocoded_at'

const WORKOUT_GEO_NUMERIC_KEYS: (keyof WorkoutGeo)[] = ['lat', 'lon']

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
    { data: swimSets, error: swimSetsError },
    { data: routePoints, error: routeError },
    { data: geo, error: geoError }
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
      .order('set_index', { ascending: true }),
    supabase
      .from('workout_route_points')
      .select(ROUTE_POINT_COLUMNS)
      .eq('workout_id', id)
      .order('seq', { ascending: true }),
    supabase.from('workout_geo').select(WORKOUT_GEO_COLUMNS).eq('workout_id', id).maybeSingle()
  ])

  if (hrError) throw new Error(`getWorkoutDetail (hr samples): ${hrError.message}`)
  if (computedError) throw new Error(`getWorkoutDetail (computed): ${computedError.message}`)
  if (swimSetsError) throw new Error(`getWorkoutDetail (swim sets): ${swimSetsError.message}`)
  if (routeError) throw new Error(`getWorkoutDetail (route points): ${routeError.message}`)
  if (geoError) throw new Error(`getWorkoutDetail (geo): ${geoError.message}`)

  return {
    workout: normalizeNumeric(workout as Workout, WORKOUT_NUMERIC_KEYS),
    hrSamples: (hrSamples ?? []) as WorkoutHrSample[],
    swimSets: (swimSets ?? []).map((row) => normalizeNumeric(row as SwimSet, SWIM_SET_NUMERIC_KEYS)),
    computed: computed
      ? normalizeNumeric(computed as ComputedWorkout, COMPUTED_WORKOUT_NUMERIC_KEYS)
      : null,
    route: (routePoints ?? []).map((row) =>
      normalizeNumeric(row as RoutePoint, ROUTE_POINT_NUMERIC_KEYS)
    ),
    geo: geo ? normalizeNumeric(geo as WorkoutGeo, WORKOUT_GEO_NUMERIC_KEYS) : null
  }
}

/** Batched place labels for history views. Avoids fetching full workout detail N times. */
export async function getWorkoutPlaces(workoutIds: string[]): Promise<WorkoutPlace[]> {
  if (workoutIds.length === 0) return []
  const supabase = getClient()
  const { data, error } = await supabase
    .from('workout_geo')
    .select('workout_id, city, country, admin')
    .in('workout_id', workoutIds)

  if (error) throw new Error(`getWorkoutPlaces: ${error.message}`)
  return (data ?? []) as WorkoutPlace[]
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
    'zone2_weekly_target_min',
    'sleep_goal_min',
    'bedtime_goal_min'
  ]
  for (const field of numericFields) {
    if (field in update) {
      const value = update[field]
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`updateUserConfig: ${field} must be a finite number or null`)
      }
    }
  }

  if ('sleep_goal_min' in update) {
    const value = update.sleep_goal_min
    if (!Number.isInteger(value) || (value as number) < 60 || (value as number) > 1440) {
      throw new Error('updateUserConfig: sleep_goal_min must be a whole number from 60 to 1440')
    }
  }

  if ('bedtime_goal_min' in update) {
    const value = update.bedtime_goal_min
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1439) {
      throw new Error('updateUserConfig: bedtime_goal_min must be a whole number from 0 to 1439')
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

  if ('about_me' in update) {
    const about = update.about_me
    if (about !== null && (typeof about !== 'string' || about.length > 5000)) {
      throw new Error('updateUserConfig: about_me must be text up to 5000 characters or null')
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
  'id, name, body_area, status, severity, started_at, plan_started_at, resolved_at, summary, recovery_plan, created_at, updated_at'

const INJURY_LOG_COLUMNS =
  'id, injury_id, entry_date, entry_end_date, date_precision, noted_at, source, note, pain_level, context, workout_id'

const INJURY_LOG_NUMERIC_KEYS: (keyof InjuryLogEntry)[] = ['pain_level']

const RECOVERY_PLAN_ITEM_COLUMNS =
  'id, injury_id, name, kind, weekly_target, green_min, yellow_min, start_week, target_sets, target_reps, steps, note, active, exercise_id, created_at, updated_at'

const RECOVERY_PLAN_ITEM_NUMERIC_KEYS: (keyof RecoveryPlanItem)[] = [
  'weekly_target',
  'green_min',
  'yellow_min',
  'start_week',
  'target_sets',
  'target_reps'
]

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

export async function addInjuryLog(
  entry: NewInjuryLog,
  mutationId: string
): Promise<InjuryLogEntry> {
  const supabase = getClient()

  assertUuid(entry.injury_id, 'injury_id')
  assertUuid(mutationId, 'mutationId')

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

  // Offline replays carry the same mutationId. If this write already landed,
  // return that row untouched rather than re-running the day-merge below.
  const { data: prior, error: priorError } = await supabase
    .from('injury_notes')
    .select(INJURY_LOG_COLUMNS)
    .eq('client_mutation_id', mutationId)
    .maybeSingle()
  if (priorError) throw new Error(`addInjuryLog (idempotency): ${priorError.message}`)
  if (prior) return normalizeNumeric(prior as InjuryLogEntry, INJURY_LOG_NUMERIC_KEYS)

  // One log per day, highest pain wins: a same-day entry only supersedes the
  // existing one when its pain is >= the day's current pain. Corrections that
  // lower the reading are made by deleting the log, not by re-logging.
  //
  // The merge is scoped to this app's own single-day quick logs (source 'user',
  // no span). Chat-authored notes and period spans are exempt — they can share a
  // date with a quick log without being clobbered, matching the partial unique
  // index injury_notes_user_daily_unique.
  const entryDate = entry.entry_date ?? new Date().toISOString().slice(0, 10)
  const { data: dayRow, error: dayError } = await supabase
    .from('injury_notes')
    .select('id, pain_level')
    .eq('injury_id', entry.injury_id)
    .eq('entry_date', entryDate)
    .eq('source', 'user')
    .is('entry_end_date', null)
    .maybeSingle()
  if (dayError) throw new Error(`addInjuryLog (day lookup): ${dayError.message}`)

  const fields: Record<string, unknown> = {
    client_mutation_id: mutationId,
    injury_id: entry.injury_id,
    entry_date: entryDate,
    note: entry.note,
    pain_level: entry.pain_level,
    context: entry.context,
    workout_id: entry.workout_id ?? null,
    source: 'user',
    noted_at: new Date().toISOString()
  }

  if (dayRow) {
    // null pain sorts below any real 0–10 reading, so a genuine reading always
    // supersedes a note that carried no pain level.
    const existingPain = dayRow.pain_level ?? -1
    const incomingPain = entry.pain_level ?? -1
    if (incomingPain < existingPain) {
      const { data: kept, error: keptError } = await supabase
        .from('injury_notes')
        .select(INJURY_LOG_COLUMNS)
        .eq('id', dayRow.id)
        .single()
      if (keptError) throw new Error(`addInjuryLog (keep existing): ${keptError.message}`)
      return normalizeNumeric(kept as InjuryLogEntry, INJURY_LOG_NUMERIC_KEYS)
    }
    const { data: updated, error: updateError } = await supabase
      .from('injury_notes')
      .update(fields)
      .eq('id', dayRow.id)
      .select(INJURY_LOG_COLUMNS)
      .single()
    if (updateError) throw new Error(`addInjuryLog (overwrite): ${updateError.message}`)
    return normalizeNumeric(updated as InjuryLogEntry, INJURY_LOG_NUMERIC_KEYS)
  }

  const { data, error } = await supabase
    .from('injury_notes')
    .insert(fields)
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

export async function updateInjuryPlanStart(
  injuryId: string,
  planStartedAt: string
): Promise<Injury> {
  const supabase = getClient()

  assertUuid(injuryId, 'injury_id')
  assertDate(planStartedAt, 'planStartedAt')

  const { data, error } = await supabase
    .from('injuries')
    .update({ plan_started_at: planStartedAt })
    .eq('id', injuryId)
    .select(INJURY_COLUMNS)
    .single()

  if (error) throw new Error(`updateInjuryPlanStart: ${error.message}`)
  return data as Injury
}

export async function updateInjuryStartedAt(
  injuryId: string,
  startedAt: string
): Promise<Injury> {
  const supabase = getClient()

  assertUuid(injuryId, 'injury_id')
  assertDate(startedAt, 'startedAt')

  const { data, error } = await supabase
    .from('injuries')
    .update({ started_at: startedAt, updated_at: new Date().toISOString() })
    .eq('id', injuryId)
    .select(INJURY_COLUMNS)
    .single()

  if (error) throw new Error(`updateInjuryStartedAt: ${error.message}`)
  return data as Injury
}

export async function deleteInjuryLog(id: number): Promise<void> {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new Error('invalid injury log id')
  }
  const { error } = await getClient().from('injury_notes').delete().eq('id', id)
  if (error) throw new Error(`deleteInjuryLog: ${error.message}`)
}

export async function updateInjuryStatus(
  injuryId: string,
  status: Injury['status']
): Promise<Injury> {
  assertUuid(injuryId, 'injury_id')
  if (status !== 'active' && status !== 'recovering' && status !== 'resolved') {
    throw new Error('invalid status')
  }

  // Resolving stamps resolved_at (a date); reopening clears it.
  const row: Record<string, unknown> = {
    status,
    resolved_at: status === 'resolved' ? new Date().toISOString().slice(0, 10) : null,
    updated_at: new Date().toISOString()
  }

  const { data, error } = await getClient()
    .from('injuries')
    .update(row)
    .eq('id', injuryId)
    .select(INJURY_COLUMNS)
    .single()

  if (error) throw new Error(`updateInjuryStatus: ${error.message}`)
  return data as Injury
}

export async function deleteInjury(id: string): Promise<void> {
  assertUuid(id, 'injury_id')
  // injury_notes, recovery_plan_items (and their checks) all cascade on delete.
  const { error } = await getClient().from('injuries').delete().eq('id', id)
  if (error) throw new Error(`deleteInjury: ${error.message}`)
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

const EXERCISE_COLUMNS =
  'id, name, aliases, body_part, primary_muscles, secondary_muscles, equipment, mechanics, movement_pattern, source, created_at'

const GYM_TEMPLATE_COLUMNS =
  'id, name, notes, archived, default_rest_s, family_id, version, is_current, created_at, updated_at'

const GYM_TEMPLATE_RUN_COLUMNS = 'id, template_id, started_at, ended_at, source'

const GYM_TEMPLATE_ITEM_COLUMNS =
  'id, template_id, exercise_id, position, target_sets, target_reps, target_weight_kg, rest_after_s, note'

const GYM_TEMPLATE_ITEM_NUMERIC_KEYS: (keyof GymTemplateItem)[] = [
  'position',
  'target_sets',
  'target_reps',
  'target_weight_kg',
  'rest_after_s'
]

const GYM_SESSION_COLUMNS =
  'id, workout_id, template_id, performed_at, title, notes, source, body_parts, created_at, updated_at'

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

function assertTemplateIds(templateIds: unknown): asserts templateIds is string[] {
  if (!Array.isArray(templateIds) || templateIds.length > 20) {
    throw new Error('invalid template_ids')
  }
  const seen = new Set<string>()
  for (const templateId of templateIds) {
    assertUuid(templateId, 'template_ids[]')
    if (seen.has(templateId)) throw new Error('template_ids must not contain duplicates')
    seen.add(templateId)
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
    assertOptionalInt(item.rest_after_s, 'items[].rest_after_s', 0, 3600)
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

function assertBodyParts(parts: unknown): asserts parts is GymBodyPart[] {
  if (
    !Array.isArray(parts) ||
    parts.length > GYM_BODY_PARTS.length ||
    new Set(parts).size !== parts.length ||
    !parts.every((p) => (GYM_BODY_PARTS as readonly string[]).includes(p))
  ) {
    throw new Error('invalid body_parts')
  }
}

// Create-on-type from the autocomplete. Case-insensitively idempotent: a name
// that already exists (any casing) returns the existing catalog row. Custom
// rows carry only name + optional body part; the curated catalog rows come
// from scripts/seed_exercises.ts.
export async function addExercise(name: string, bodyPart: GymBodyPart | null): Promise<Exercise> {
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 120) {
    throw new Error('invalid name')
  }
  if (bodyPart !== null && !(GYM_BODY_PARTS as readonly string[]).includes(bodyPart)) {
    throw new Error('invalid body_part')
  }
  const trimmed = name.trim()

  const supabase = getClient()
  const { data, error } = await supabase
    .from('exercises')
    .insert({ name: trimmed, body_part: bodyPart })
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

// Runs for a set of template versions, grouped by template_id, most recent first.
async function templateRunsByTemplate(
  templateIds: string[]
): Promise<Map<string, GymTemplateRun[]>> {
  const byTemplate = new Map<string, GymTemplateRun[]>()
  if (templateIds.length === 0) return byTemplate
  const { data, error } = await getClient()
    .from('gym_template_runs')
    .select(GYM_TEMPLATE_RUN_COLUMNS)
    .in('template_id', templateIds)
    .order('started_at', { ascending: false })
  if (error) throw new Error(`templateRunsByTemplate: ${error.message}`)
  for (const row of (data ?? []) as GymTemplateRun[]) {
    const list = byTemplate.get(row.template_id)
    if (list) list.push(row)
    else byTemplate.set(row.template_id, [row])
  }
  return byTemplate
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

  const runs = (await templateRunsByTemplate([id])).get(id) ?? []
  const names = await exerciseNamesById((items ?? []).map((item) => item.exercise_id))
  return {
    ...(template as Omit<GymTemplate, 'items' | 'runs'>),
    items: (items ?? []).map((row) => ({
      ...normalizeNumeric(row as GymTemplateItem, GYM_TEMPLATE_ITEM_NUMERIC_KEYS),
      exercise_name: names.get(row.exercise_id) ?? '?'
    })),
    runs
  }
}

export async function getGymTemplates(): Promise<GymTemplate[]> {
  const supabase = getClient()
  // Only the current version of each family shows in the tab; older versions are
  // reached through the version dropdown (getGymTemplateVersions).
  const { data: templates, error } = await supabase
    .from('gym_templates')
    .select(GYM_TEMPLATE_COLUMNS)
    .eq('is_current', true)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`getGymTemplates: ${error.message}`)
  if (!templates || templates.length === 0) return []

  const templateIds = templates.map((t) => t.id)
  const { data: items, error: itemsError } = await supabase
    .from('gym_template_exercises')
    .select(GYM_TEMPLATE_ITEM_COLUMNS)
    .in('template_id', templateIds)
    .order('position', { ascending: true })
  if (itemsError) throw new Error(`getGymTemplates (items): ${itemsError.message}`)

  const runsByTemplate = await templateRunsByTemplate(templateIds)
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
    ...(t as Omit<GymTemplate, 'items' | 'runs'>),
    items: itemsByTemplate.get(t.id) ?? [],
    runs: runsByTemplate.get(t.id) ?? []
  }))
}

// Every version of a template family, ascending by version — powers the dropdown.
export async function getGymTemplateVersions(familyId: string): Promise<GymTemplate[]> {
  assertUuid(familyId, 'family_id')
  const supabase = getClient()
  const { data: templates, error } = await supabase
    .from('gym_templates')
    .select(GYM_TEMPLATE_COLUMNS)
    .eq('family_id', familyId)
    .order('version', { ascending: true })
  if (error) throw new Error(`getGymTemplateVersions: ${error.message}`)
  if (!templates || templates.length === 0) return []

  const templateIds = templates.map((t) => t.id)
  const { data: items, error: itemsError } = await supabase
    .from('gym_template_exercises')
    .select(GYM_TEMPLATE_ITEM_COLUMNS)
    .in('template_id', templateIds)
    .order('position', { ascending: true })
  if (itemsError) throw new Error(`getGymTemplateVersions (items): ${itemsError.message}`)

  const runsByTemplate = await templateRunsByTemplate(templateIds)
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
    ...(t as Omit<GymTemplate, 'items' | 'runs'>),
    items: itemsByTemplate.get(t.id) ?? [],
    runs: runsByTemplate.get(t.id) ?? []
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
    rest_after_s: item.rest_after_s ?? null,
    note: item.note ?? null
  }))
  const { error } = await getClient().from('gym_template_exercises').insert(rows)
  if (error) throw new Error(`insertTemplateItems: ${error.message}`)
}

export async function addGymTemplate(
  template: NewGymTemplate,
  mutationId: string
): Promise<GymTemplate> {
  if (
    typeof template.name !== 'string' ||
    template.name.trim().length === 0 ||
    template.name.trim().length > 120
  ) {
    throw new Error('invalid name')
  }
  assertOptionalText(template.notes, 'notes', 2000)
  assertOptionalInt(template.default_rest_s, 'default_rest_s', 0, 3600)
  assertTemplateItems(template.items)
  assertUuid(mutationId, 'mutationId')

  const supabase = getClient()
  const { data, error } = await supabase
    .from('gym_templates')
    .upsert(
      {
        id: mutationId,
        name: template.name.trim(),
        notes: template.notes,
        archived: false,
        default_rest_s: template.default_rest_s ?? null,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'id' }
    )
    .select(GYM_TEMPLATE_COLUMNS)
    .single()
  if (error) throw new Error(`addGymTemplate: ${error.message}`)

  try {
    const { error: clearError } = await supabase
      .from('gym_template_exercises')
      .delete()
      .eq('template_id', data.id)
    if (clearError) throw new Error(`addGymTemplate (clear items): ${clearError.message}`)
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
  if (patch.default_rest_s !== undefined) {
    assertOptionalInt(patch.default_rest_s, 'default_rest_s', 0, 3600)
    row.default_rest_s = patch.default_rest_s
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

export async function deleteGymTemplate(id: string): Promise<void> {
  assertUuid(id, 'template_id')
  const supabase = getClient()
  // gym_session_templates links this template to past logs with ON DELETE
  // RESTRICT (the schema favours archiving to preserve history). An explicit
  // delete therefore has to drop those join rows first; gym_template_exercises
  // (cascade) and gym_sessions.template_id (set null) clean themselves up.
  const { error: linkError } = await supabase
    .from('gym_session_templates')
    .delete()
    .eq('template_id', id)
  if (linkError) throw new Error(`deleteGymTemplate (links): ${linkError.message}`)

  const { error } = await supabase.from('gym_templates').delete().eq('id', id)
  if (error) throw new Error(`deleteGymTemplate: ${error.message}`)
}

async function familyTemplateIds(familyId: string): Promise<string[]> {
  const { data, error } = await getClient()
    .from('gym_templates')
    .select('id')
    .eq('family_id', familyId)
  if (error) throw new Error(`familyTemplateIds: ${error.message}`)
  return (data ?? []).map((r) => (r as { id: string }).id)
}

// Save an edited template as the next version in its family. The previous
// versions are demoted (is_current=false) and kept as history; any active run
// carries forward onto the new version so the family stays active.
export async function createGymTemplateVersion(
  baseTemplateId: string,
  template: NewGymTemplate,
  mutationId: string
): Promise<GymTemplate> {
  assertUuid(baseTemplateId, 'baseTemplateId')
  assertUuid(mutationId, 'mutationId')
  if (
    typeof template.name !== 'string' ||
    template.name.trim().length === 0 ||
    template.name.trim().length > 120
  ) {
    throw new Error('invalid name')
  }
  assertOptionalText(template.notes, 'notes', 2000)
  assertOptionalInt(template.default_rest_s, 'default_rest_s', 0, 3600)
  assertTemplateItems(template.items)

  const supabase = getClient()

  const { data: base, error: baseError } = await supabase
    .from('gym_templates')
    .select('family_id')
    .eq('id', baseTemplateId)
    .single()
  if (baseError) throw new Error(`createGymTemplateVersion (base): ${baseError.message}`)
  const familyId = (base as { family_id: string }).family_id

  const { data: latest, error: latestError } = await supabase
    .from('gym_templates')
    .select('version')
    .eq('family_id', familyId)
    .order('version', { ascending: false })
    .limit(1)
  if (latestError) throw new Error(`createGymTemplateVersion (version): ${latestError.message}`)
  const nextVersion = ((latest?.[0] as { version: number } | undefined)?.version ?? 0) + 1

  const { data, error } = await supabase
    .from('gym_templates')
    .upsert(
      {
        id: mutationId,
        name: template.name.trim(),
        notes: template.notes,
        archived: false,
        default_rest_s: template.default_rest_s ?? null,
        family_id: familyId,
        version: nextVersion,
        is_current: true,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'id' }
    )
    .select(GYM_TEMPLATE_COLUMNS)
    .single()
  if (error) throw new Error(`createGymTemplateVersion: ${error.message}`)

  try {
    const { error: clearError } = await supabase
      .from('gym_template_exercises')
      .delete()
      .eq('template_id', data.id)
    if (clearError) throw new Error(`createGymTemplateVersion (clear items): ${clearError.message}`)
    await insertTemplateItems(data.id, template.items)
  } catch (err) {
    // No transactions over PostgREST — best-effort rollback of the header row.
    await supabase.from('gym_templates').delete().eq('id', data.id)
    throw err
  }

  // Demote the previous versions and carry any active run forward.
  const { error: demoteError } = await supabase
    .from('gym_templates')
    .update({ is_current: false })
    .eq('family_id', familyId)
    .neq('id', data.id)
  if (demoteError) throw new Error(`createGymTemplateVersion (demote): ${demoteError.message}`)

  const siblingIds = (await familyTemplateIds(familyId)).filter((fid) => fid !== data.id)
  if (siblingIds.length > 0) {
    const { error: carryError } = await supabase
      .from('gym_template_runs')
      .update({ template_id: data.id })
      .in('template_id', siblingIds)
      .is('ended_at', null)
    if (carryError) throw new Error(`createGymTemplateVersion (carry run): ${carryError.message}`)
  }

  return getGymTemplateById(data.id)
}

// Open a run (activate / resurrect). Idempotent when already active on this
// version; otherwise closes any other open run in the family first (one active
// run per family) and opens a fresh one.
export async function startGymTemplateRun(templateId: string): Promise<GymTemplateRun> {
  assertUuid(templateId, 'template_id')
  const supabase = getClient()

  const { data: tpl, error: tplError } = await supabase
    .from('gym_templates')
    .select('family_id')
    .eq('id', templateId)
    .single()
  if (tplError) throw new Error(`startGymTemplateRun (template): ${tplError.message}`)

  const { data: openOnThis, error: openError } = await supabase
    .from('gym_template_runs')
    .select(GYM_TEMPLATE_RUN_COLUMNS)
    .eq('template_id', templateId)
    .is('ended_at', null)
    .maybeSingle()
  if (openError) throw new Error(`startGymTemplateRun (open): ${openError.message}`)
  if (openOnThis) return openOnThis as GymTemplateRun

  const today = new Date().toISOString().slice(0, 10)
  const familyIds = await familyTemplateIds((tpl as { family_id: string }).family_id)
  const { error: closeError } = await supabase
    .from('gym_template_runs')
    .update({ ended_at: today })
    .in('template_id', familyIds)
    .is('ended_at', null)
  if (closeError) throw new Error(`startGymTemplateRun (close siblings): ${closeError.message}`)

  const { data, error } = await supabase
    .from('gym_template_runs')
    .insert({ template_id: templateId, started_at: today, source: 'user' })
    .select(GYM_TEMPLATE_RUN_COLUMNS)
    .single()
  if (error) throw new Error(`startGymTemplateRun: ${error.message}`)
  return data as GymTemplateRun
}

// Close the family's open run ("mark complete" / coach archive). Null if none open.
export async function completeGymTemplateRun(
  templateId: string
): Promise<GymTemplateRun | null> {
  assertUuid(templateId, 'template_id')
  const supabase = getClient()

  const { data: tpl, error: tplError } = await supabase
    .from('gym_templates')
    .select('family_id')
    .eq('id', templateId)
    .single()
  if (tplError) throw new Error(`completeGymTemplateRun (template): ${tplError.message}`)

  const familyIds = await familyTemplateIds((tpl as { family_id: string }).family_id)
  const { data, error } = await supabase
    .from('gym_template_runs')
    .update({ ended_at: new Date().toISOString().slice(0, 10) })
    .in('template_id', familyIds)
    .is('ended_at', null)
    .select(GYM_TEMPLATE_RUN_COLUMNS)
  if (error) throw new Error(`completeGymTemplateRun: ${error.message}`)
  return data && data.length > 0 ? (data[0] as GymTemplateRun) : null
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

  const [names, templateIdsBySession] = await Promise.all([
    exerciseNamesById((sets ?? []).map((s) => s.exercise_id)),
    getGymSessionTemplateIds([id])
  ])
  return {
    ...(session as Omit<GymSession, 'sets'>),
    template_ids: templateIdsBySession.get(id) ?? (session.template_id ? [session.template_id] : []),
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

  const [names, templateIdsBySession] = await Promise.all([
    exerciseNamesById((sets ?? []).map((s) => s.exercise_id)),
    getGymSessionTemplateIds((sessions ?? []).map((s) => s.id))
  ])
  const setsBySession = new Map<string, GymSet[]>()
  for (const row of sets ?? []) {
    const set = toGymSet(row, names)
    const list = setsBySession.get(set.session_id)
    if (list) list.push(set)
    else setsBySession.set(set.session_id, [set])
  }

  return sessions.map((s) => ({
    ...(s as Omit<GymSession, 'sets'>),
    template_ids: templateIdsBySession.get(s.id) ?? (s.template_id ? [s.template_id] : []),
    sets: setsBySession.get(s.id) ?? []
  }))
}

/** All template blocks applied to the requested sessions, in editor order. */
async function getGymSessionTemplateIds(sessionIds: string[]): Promise<Map<string, string[]>> {
  const bySession = new Map<string, string[]>()
  if (sessionIds.length === 0) return bySession

  const { data, error } = await getClient()
    .from('gym_session_templates')
    .select('session_id, template_id, position')
    .in('session_id', sessionIds)
    .order('position', { ascending: true })
  if (error) throw new Error(`getGymSessionTemplateIds: ${error.message}`)

  for (const row of data ?? []) {
    const ids = bySession.get(row.session_id)
    if (ids) ids.push(row.template_id)
    else bySession.set(row.session_id, [row.template_id])
  }
  return bySession
}

/** "2026-07-12" for an ISO instant in the user's timezone (falls back to the instant's UTC date). */
function localDateInTz(iso: string, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(iso))
  } catch {
    return iso.slice(0, 10)
  }
}

/**
 * Recovery-plan compliance from gym logs: any active plan item (of a
 * non-resolved injury) linked to an exercise this session just logged gets its
 * plan_item_check upserted for the session's local date, source='gym'. An
 * existing manual check for the day wins (ignoreDuplicates). Additive only —
 * editing sets away or deleting the session leaves past checks standing; the
 * user can untick in the Injuries tab. Never fails the session save: the log
 * is the primary artifact, the check is derived convenience.
 */
async function syncPlanChecksFromGymSets(
  sets: NewGymSet[],
  performedAtIso: string
): Promise<void> {
  try {
    const exerciseIds = [...new Set(sets.map((s) => s.exercise_id))]
    if (exerciseIds.length === 0) return
    const supabase = getClient()

    const { data: items, error } = await supabase
      .from('recovery_plan_items')
      .select('id, exercise_id, injuries!inner(status)')
      .eq('active', true)
      .neq('injuries.status', 'resolved')
      .in('exercise_id', exerciseIds)
    if (error) throw new Error(error.message)
    if (!items || items.length === 0) return

    const timezone = (await getUserConfig()).timezone
    const doneDate = localDateInTz(performedAtIso, timezone)
    const { error: upsertError } = await supabase.from('plan_item_checks').upsert(
      items.map((item) => ({ item_id: item.id, done_date: doneDate, source: 'gym' })),
      { onConflict: 'item_id,done_date', ignoreDuplicates: true }
    )
    if (upsertError) throw new Error(upsertError.message)
  } catch (err) {
    console.error(
      '[gym] plan-check sync failed (session saved fine):',
      err instanceof Error ? err.message : err
    )
  }
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

async function replaceGymSessionTemplates(sessionId: string, templateIds: string[]): Promise<void> {
  const supabase = getClient()
  const { error: clearError } = await supabase
    .from('gym_session_templates')
    .delete()
    .eq('session_id', sessionId)
  if (clearError) throw new Error(`replaceGymSessionTemplates (clear): ${clearError.message}`)
  if (templateIds.length === 0) return

  const { error } = await supabase.from('gym_session_templates').insert(
    templateIds.map((template_id, position) => ({ session_id: sessionId, template_id, position }))
  )
  if (error) throw new Error(`replaceGymSessionTemplates: ${error.message}`)
}

export async function addGymSession(
  session: NewGymSession,
  mutationId: string
): Promise<GymSession> {
  assertOptionalText(session.title, 'title', 120)
  assertOptionalText(session.notes, 'notes', 2000)
  if (session.template_id !== undefined && session.template_id !== null) {
    assertUuid(session.template_id, 'template_id')
  }
  if (session.template_ids !== undefined) assertTemplateIds(session.template_ids)
  if (session.body_parts !== undefined && session.body_parts !== null) {
    assertBodyParts(session.body_parts)
  }
  assertGymSets(session.sets)
  assertUuid(mutationId, 'mutationId')

  const templateIds = session.template_ids ?? (session.template_id ? [session.template_id] : [])
  const supabase = getClient()
  const row: Record<string, unknown> = {
    id: mutationId,
    workout_id: session.workout_id ?? null,
    template_id: templateIds[0] ?? null,
    title: session.title ?? null,
    notes: session.notes ?? null,
    body_parts: session.body_parts ?? null,
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
    .upsert(row, { onConflict: 'id' })
    .select(GYM_SESSION_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('this workout already has a gym log')
    throw new Error(`addGymSession: ${error.message}`)
  }

  try {
    await replaceGymSessionTemplates(data.id, templateIds)
    const { error: clearSetsError } = await supabase
      .from('gym_sets')
      .delete()
      .eq('session_id', data.id)
    if (clearSetsError) throw new Error(`addGymSession (clear sets): ${clearSetsError.message}`)
    await insertGymSets(data.id, session.sets)
  } catch (err) {
    // No transactions over PostgREST — best-effort rollback of the header row.
    await supabase.from('gym_sessions').delete().eq('id', data.id)
    throw err
  }
  await syncPlanChecksFromGymSets(session.sets, data.performed_at as string)
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
  let replacementTemplateIds: string[] | undefined
  if (patch.template_ids !== undefined) {
    assertTemplateIds(patch.template_ids)
    replacementTemplateIds = patch.template_ids
    row.template_id = patch.template_ids[0] ?? null
  } else if (patch.template_id !== undefined) {
    if (patch.template_id !== null) assertUuid(patch.template_id, 'template_id')
    replacementTemplateIds = patch.template_id ? [patch.template_id] : []
    row.template_id = patch.template_id
  }
  if (patch.body_parts !== undefined) {
    if (patch.body_parts !== null) assertBodyParts(patch.body_parts)
    row.body_parts = patch.body_parts
  }
  if (patch.sets !== undefined) assertGymSets(patch.sets)

  const supabase = getClient()
  const { error } = await supabase.from('gym_sessions').update(row).eq('id', id)
  if (error) throw new Error(`updateGymSession: ${error.message}`)

  if (replacementTemplateIds !== undefined) {
    await replaceGymSessionTemplates(id, replacementTemplateIds)
  }

  if (patch.sets !== undefined) {
    const { error: deleteError } = await supabase.from('gym_sets').delete().eq('session_id', id)
    if (deleteError) throw new Error(`updateGymSession (clear sets): ${deleteError.message}`)
    await insertGymSets(id, patch.sets)
    const session = await getGymSessionById(id)
    await syncPlanChecksFromGymSets(patch.sets, session.performed_at)
    return session
  }
  return getGymSessionById(id)
}

export async function deleteGymSession(id: string): Promise<void> {
  assertUuid(id, 'session_id')
  const { error } = await getClient().from('gym_sessions').delete().eq('id', id)
  if (error) throw new Error(`deleteGymSession: ${error.message}`)
}

// ---- Protein tracker (manual daily log, additive per entry) ----
// One row per date; addProtein increments it (stacking), setProtein
// overwrites it (corrections). No source column — this is app-only, no
// chat-agent writer exists (or is planned) for this table.

const PROTEIN_LOG_COLUMNS = 'log_date, grams'

const PROTEIN_LOG_NUMERIC_KEYS: (keyof ProteinDay)[] = ['grams']

function assertGrams(grams: unknown): asserts grams is number {
  if (typeof grams !== 'number' || !Number.isFinite(grams) || grams < 0 || grams > 2000) {
    throw new Error('invalid grams')
  }
}

export async function getProteinLog(fromDate: string, toDate: string): Promise<ProteinDay[]> {
  assertDate(fromDate, 'fromDate')
  assertDate(toDate, 'toDate')

  const supabase = getClient()
  const { data, error } = await supabase
    .from('protein_log')
    .select(PROTEIN_LOG_COLUMNS)
    .gte('log_date', fromDate)
    .lte('log_date', toDate)
    .order('log_date', { ascending: true })

  if (error) throw new Error(`getProteinLog: ${error.message}`)

  return (data ?? []).map((row) => normalizeNumeric(row as ProteinDay, PROTEIN_LOG_NUMERIC_KEYS))
}

/**
 * Increments the day's existing total (stacking: "+40g at dinner" adds onto
 * today's row). supabase-js's upsert() can't express `grams = grams +
 * excluded.grams` (it only replaces or ignores on conflict), so this reads
 * the current total then writes the sum — same "no transactions over
 * PostgREST" tradeoff already accepted elsewhere in this file. Fine for a
 * single-user desktop app issuing one write at a time.
 */
export async function addProtein(
  date: string,
  grams: number,
  mutationId: string
): Promise<ProteinDay> {
  assertDate(date, 'date')
  assertGrams(grams)
  assertUuid(mutationId, 'mutationId')

  const supabase = getClient()
  const { data, error } = await supabase.rpc('apply_protein_delta', {
    p_mutation_id: mutationId,
    p_log_date: date,
    p_grams: grams
  })

  if (error) throw new Error(`addProtein: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('addProtein: no row returned')
  return normalizeNumeric(row as ProteinDay, PROTEIN_LOG_NUMERIC_KEYS)
}

/** Overwrites the day's total outright — for corrections, not stacking. */
export async function setProtein(date: string, grams: number): Promise<ProteinDay> {
  assertDate(date, 'date')
  assertGrams(grams)

  const supabase = getClient()
  const { data, error } = await supabase
    .from('protein_log')
    .upsert(
      { log_date: date, grams, updated_at: new Date().toISOString() },
      { onConflict: 'log_date' }
    )
    .select(PROTEIN_LOG_COLUMNS)
    .single()

  if (error) throw new Error(`setProtein: ${error.message}`)

  return normalizeNumeric(data as ProteinDay, PROTEIN_LOG_NUMERIC_KEYS)
}

const GOAL_COLUMNS =
  'id, title, description, status, started_at, status_changed_at, duration_days, created_by, metric_name, metric_description, metric_sql, metric_direction, metric_unit, metric_baseline, metric_target, created_at, updated_at'

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

  // Open the status timeline (best-effort — the card doesn't depend on it; it's
  // context for the chat agent). goals.status_changed_at is DB-defaulted to now.
  await supabase
    .from('goal_status_events')
    .insert({ goal_id: (data as Goal).id, status: 'active', source: 'user' })

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
  let statusChanged = false
  if (patch.status !== undefined) {
    if (!(GOAL_STATUSES as readonly string[]).includes(patch.status)) {
      throw new Error('invalid status')
    }
    row.status = patch.status
    // Only stamp the timeline when the status genuinely transitions, so
    // "active for X since …" reflects the last real change, not every edit.
    const { data: current, error: readError } = await supabase
      .from('goals')
      .select('status')
      .eq('id', id)
      .single()
    if (readError) throw new Error(`updateGoal (status read): ${readError.message}`)
    if ((current as { status: string }).status !== patch.status) {
      statusChanged = true
      row.status_changed_at = new Date().toISOString()
    }
  }

  const { data, error } = await supabase
    .from('goals')
    .update(row)
    .eq('id', id)
    .select(GOAL_COLUMNS)
    .single()

  if (error) throw new Error(`updateGoal: ${error.message}`)

  if (statusChanged) {
    await supabase
      .from('goal_status_events')
      .insert({ goal_id: id, status: patch.status, source: 'user' })
  }

  return normalizeNumeric(data as Goal, GOAL_NUMERIC_KEYS)
}

export async function deleteGoal(id: string): Promise<void> {
  assertUuid(id, 'goal_id')
  // goal_progress and goal_status_events cascade on delete.
  const { error } = await getClient().from('goals').delete().eq('id', id)
  if (error) throw new Error(`deleteGoal: ${error.message}`)
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
