// Shared types between main, preload, and renderer processes.
// Numeric columns from PostgREST may arrive as strings; db.ts normalizes them
// to numbers before they cross the IPC boundary, so these types describe the
// *normalized* shape the renderer can rely on.

export interface Workout {
  id: string
  external_id: string | null
  type: string
  start_at: string
  end_at: string | null
  duration_s: number | null
  distance_m: number | null
  energy_kcal: number | null
  avg_hr: number | null
  max_hr: number | null
  source: string | null
  raw: Record<string, unknown> | null
  // Joined from computed_workout (left join — may be null if not yet computed)
  computed: ComputedWorkout | null
}

export interface WorkoutHrSample {
  workout_id: string
  offset_s: number
  bpm: number
}

// One detected swim set (ingest-derived from HAE per-second swim series).
// Pace/SWOLF are intentionally NOT stored — derive via renderer lib/swimSets.ts.
export interface SwimSet {
  workout_id: string
  set_index: number
  start_offset_s: number
  duration_s: number
  distance_m: number
  strokes: number
  rest_after_s: number | null
}

export interface ComputedWorkout {
  workout_id: string
  time_in_zones: Record<string, unknown> | null
  trimp: number | null
  ef: number | null
  decoupling_pct: number | null
  hrr60: number | null
  computed_at: string | null
}

// One downsampled GPS point on a workout's route polyline, ordered by `seq`.
export interface RoutePoint {
  seq: number
  lat: number
  lon: number
  elevation_m: number | null
}

// Reverse-geocoded location for a workout (workout_geo table).
export interface WorkoutGeo {
  city: string | null
  country: string | null
  admin: string | null
  lat: number
  lon: number
}

/** Lightweight batched geography projection for history/summary views. */
export interface WorkoutPlace {
  workout_id: string
  city: string | null
  country: string | null
  admin: string | null
}

export interface WorkoutDetail {
  workout: Omit<Workout, 'computed'>
  hrSamples: WorkoutHrSample[]
  swimSets: SwimSet[]
  computed: ComputedWorkout | null
  route: RoutePoint[]
  geo: WorkoutGeo | null
}

export interface DailyMetric {
  date: string
  resting_hr: number | null
  hrv_sdnn_ms: number | null
  respiratory_rate: number | null
  sleep_start: string | null
  sleep_end: string | null
  sleep_duration_min: number | null
  sleep_stages: Record<string, unknown> | null
  vo2max: number | null
  steps: number | null
  active_energy_kcal: number | null
  wrist_temp_deviation_c: number | null
  weight_kg: number | null
  state_of_mind: Record<string, unknown> | null
}

export interface ComputedDaily {
  date: string
  trimp_total: number | null
  ctl: number | null
  atl: number | null
  tsb: number | null
  acwr: number | null
  rhr_baseline_60d: number | null
  rhr_dev: number | null
  hrv_baseline_60d: number | null
  hrv_dev: number | null
  flags: Flag[] | null
  computed_at: string | null
}

export interface UserConfig {
  id: number
  hr_max: number | null
  swim_hr_offset: number | null
  zone2_low_frac: number | null
  zone2_high_frac: number | null
  zone2_weekly_target_min: number
  sleep_goal_min: number
  bedtime_goal_min: number
  weekly_min_sessions: Record<string, unknown> | null
  timezone: string | null
  // Free-text personal context the user maintains on the Profile tab; read by
  // the chat agent so it knows who it's coaching.
  about_me: string | null
}

// Editable subset of UserConfig — excludes `id`, which is fixed at 1.
export type UserConfigPatch = Partial<
  Pick<
    UserConfig,
    | 'hr_max'
    | 'swim_hr_offset'
    | 'zone2_low_frac'
    | 'zone2_high_frac'
    | 'zone2_weekly_target_min'
    | 'sleep_goal_min'
    | 'bedtime_goal_min'
    | 'weekly_min_sessions'
    | 'timezone'
    | 'about_me'
  >
>

export interface Flag {
  type: string
  message: string
  severity?: 'info' | 'warn'
  [key: string]: unknown
}

export interface DbStatus {
  connected: boolean
  error?: string
}

export interface Injury {
  id: string
  name: string
  body_area: string | null
  status: 'active' | 'recovering' | 'resolved'
  severity: 'mild' | 'moderate' | 'severe' | null
  started_at: string | null
  // Start of the current recovery plan, distinct from injury onset.
  plan_started_at: string | null
  resolved_at: string | null
  summary: string | null
  recovery_plan: string | null
  created_at: string | null
  updated_at: string | null
}

export const INJURY_CONTEXTS = ['during_workout', 'post_workout', 'at_rest', 'on_waking'] as const
export type InjuryNoteContext = (typeof INJURY_CONTEXTS)[number]

export interface InjuryLogEntry {
  id: number
  injury_id: string
  entry_date: string
  noted_at: string | null
  source: string | null
  note: string
  pain_level: number | null
  context: string[] | null
  workout_id: string | null
}

// User quick log from the Injuries tab (source is set to 'user' by the main
// process — not caller-controlled).
export interface NewInjuryLog {
  injury_id: string
  note: string
  pain_level: number | null
  context: InjuryNoteContext[]
  workout_id?: string | null
  entry_date?: string // YYYY-MM-DD, defaults to today
}

export interface RecoveryPlanStep {
  name: string
  sets: number | null
  reps: number | null
  duration_seconds: number | null
  distance_m: number | null
  per_side: boolean | null
  note: string | null
}

export interface RecoveryPlanItem {
  id: string
  injury_id: string
  name: string
  // 'exercise' = rehab work (counts toward adherence); 'activity' = cleared/
  // allowed training (tracked, not scored); 'habit' = recurring non-exercise
  // behavior; 'constraint' = standing rule (no checks).
  kind: 'exercise' | 'habit' | 'constraint' | 'activity'
  weekly_target: number | null
  // Per-item efficacy thresholds (agent-assigned, nullable): green_min = the
  // weekly count that is an acceptable therapeutic dose, yellow_min = the true
  // minimum-effective dose. Below yellow_min rates red even when non-zero.
  // Both null → the app's provisional blanket rating applies.
  green_min: number | null
  yellow_min: number | null
  // Cumulative plan phase: week 1 starts at injury.plan_started_at.
  start_week: number
  // Structured exercise dose authored by the recovery-plan agent. When the
  // item is linked to the exercise catalog these values prefill Gym logging.
  target_sets: number | null
  target_reps: number | null
  // Composite routines that do not map to one catalog exercise remain fully
  // structured instead of hiding their dose inside prose.
  steps: RecoveryPlanStep[] | null
  note: string | null
  active: boolean
  // Linked exercises-catalog entry (agent-maintained via injuries.py): gym
  // sessions logging this exercise auto-check the item (source='gym').
  exercise_id: string | null
  created_at: string | null
  updated_at: string | null
}

export interface PlanItemCheck {
  id: number
  item_id: string
  done_date: string
  source: string
}

// Body-part vocabulary shared by the exercise catalog, the picker's filter
// flow, and body-parts-only quick logs. Must match the CHECK constraints in
// the gym_exercise_catalog migration.
export const GYM_BODY_PARTS = [
  'chest',
  'back',
  'shoulders',
  'arms',
  'legs',
  'core',
  'full body'
] as const
export type GymBodyPart = (typeof GYM_BODY_PARTS)[number]

// Canonical exercise catalog for the Gym tab: curated rows seeded from
// data/exercise-catalog/ (source='catalog', structured metadata + lowercase
// aliases incl. non-English gym terms) plus user rows from create-on-type
// (source='user', name + optional body_part only). Case-insensitively unique
// by name; never deleted from the UI so set history keeps meaning.
export interface Exercise {
  id: string
  name: string
  aliases: string[]
  body_part: string | null
  primary_muscles: string[]
  secondary_muscles: string[]
  equipment: string | null
  mechanics: string | null
  movement_pattern: string | null
  source: string
  created_at: string | null
}

// One line of a gym template: an exercise plus optional targets ("3×8 @ 60kg").
export interface GymTemplateItem {
  id: string
  template_id: string
  exercise_id: string
  exercise_name: string // joined from exercises at read time
  position: number
  target_sets: number | null
  target_reps: number | null
  target_weight_kg: number | null
  // Per-exercise rest override in seconds. null = fall back to the template's
  // default_rest_s. The effective rest is `rest_after_s ?? default_rest_s`.
  rest_after_s: number | null
  note: string | null
}

// One start→end period a template was in use. A new run opens when a template
// is activated/resurrected and closes on "mark complete" (or coach archive).
export interface GymTemplateRun {
  id: string
  template_id: string
  started_at: string
  ended_at: string | null // null = currently active
  source: string
}

export interface GymTemplate {
  id: string
  name: string
  notes: string | null
  archived: boolean
  // Default rest between sets (seconds) applied to every exercise unless the
  // exercise sets its own rest_after_s. null = no default configured.
  default_rest_s: number | null
  // Versioning: every version of a template shares family_id; version counts up;
  // is_current marks the one the app logs against and defaults the dropdown to.
  family_id: string
  version: number
  is_current: boolean
  items: GymTemplateItem[]
  // This version's run history, most recent first. A trailing run with
  // ended_at === null means the template is currently active.
  runs: GymTemplateRun[]
  created_at: string | null
  updated_at: string | null
}

export interface GymSet {
  id: number
  session_id: string
  exercise_id: string
  exercise_name: string // joined from exercises at read time
  position: number
  reps: number | null
  weight_kg: number | null // null = bodyweight
  rpe: number | null
  is_warmup: boolean
  note: string | null
}

// A logged gym session. `sets` empty = quick log ("did legs, roughly template
// X"); sets present = full per-set log. Dual granularity is a data shape, not
// a mode. workout_id links the Apple-Health-synced workout (one log per
// workout); null = logged without a synced workout.
export interface GymSession {
  id: string
  workout_id: string | null
  /** Legacy primary template, kept for older records and quick summaries. */
  template_id: string | null
  /** Every template applied to this log, in editor insertion order. */
  template_ids: string[]
  performed_at: string
  title: string | null
  notes: string | null
  source: string
  // User-declared body parts — the laziest logging tier ("did legs + core").
  // When sets exist the renderer derives body parts from the sets' exercises
  // instead; this column is the fallback for set-less logs.
  body_parts: string[] | null
  sets: GymSet[]
  created_at: string | null
  updated_at: string | null
}

export interface NewGymSet {
  exercise_id: string
  reps: number | null
  weight_kg: number | null
  rpe?: number | null
  is_warmup?: boolean
  note?: string | null
}

// New session log from the Gym tab (source is set to 'user' by the main
// process — not caller-controlled). When workout_id is set, performed_at is
// derived server-side from the linked workout and the field here is ignored.
export interface NewGymSession {
  workout_id?: string | null
  /** Legacy primary template. Prefer template_ids for new logs. */
  template_id?: string | null
  /** Templates whose exercise blocks were added to this log. */
  template_ids?: string[]
  performed_at?: string // ISO instant; only used when workout_id is null
  title?: string | null
  notes?: string | null
  body_parts?: GymBodyPart[] | null
  sets: NewGymSet[]
}

// Editable subset of a logged session; `sets`, when present, replaces the
// session's whole set list.
export interface GymSessionPatch {
  title?: string | null
  notes?: string | null
  template_id?: string | null
  /** Replaces this session's full applied-template list. */
  template_ids?: string[]
  body_parts?: GymBodyPart[] | null
  sets?: NewGymSet[]
}

export interface NewGymTemplateItem {
  exercise_id: string
  target_sets: number | null
  target_reps: number | null
  target_weight_kg: number | null
  // Per-exercise rest override in seconds; null/omitted = use the template default.
  rest_after_s?: number | null
  note?: string | null
}

export interface NewGymTemplate {
  name: string
  notes: string | null
  // Default rest between sets (seconds) for the whole template; null = none.
  default_rest_s?: number | null
  items: NewGymTemplateItem[]
}

// `items`, when present, replaces the template's whole item list.
export interface GymTemplatePatch {
  name?: string
  notes?: string | null
  archived?: boolean
  default_rest_s?: number | null
  items?: NewGymTemplateItem[]
}

// Manual protein tracker: one daily-total row (protein_log table). grams is
// additive across the day — addProtein increments the existing row rather
// than replacing it, so "40g at lunch, +40g at dinner" becomes {grams: 80}.
// setProtein overwrites instead, for corrections.
export interface ProteinDay {
  log_date: string // YYYY-MM-DD
  grams: number
}

/** Returned instead of a database row when a supported write is durable locally. */
export interface QueuedWriteReceipt {
  queued: true
  operationId: string
}

export type QueueableWriteResult<T> = T | QueuedWriteReceipt

export interface OfflineQueueStatus {
  pending: number
  failed: number
  syncing: boolean
  lastError: string | null
}

export interface Goal {
  id: string
  title: string
  description: string | null
  status: 'active' | 'on_hold' | 'completed' | 'abandoned'
  started_at: string
  // When the status last changed (drives the card's "active for X since …").
  status_changed_at: string | null
  duration_days: number | null
  created_by: 'user' | 'chat'
  // AI-built progress metric — all null until the chat agent defines it.
  metric_name: string | null
  metric_description: string | null
  metric_sql: string | null
  metric_direction: 'up' | 'down' | null
  metric_unit: string | null
  metric_baseline: number | null
  metric_target: number | null
  created_at: string | null
  updated_at: string | null
}

export interface GoalProgressPoint {
  goal_id: string
  date: string
  value: number
}

// User-created goal card from the Profile tab (created_by is set to 'user' by
// the main process — not caller-controlled). Metric fields are agent-owned and
// intentionally absent here.
export interface NewGoal {
  title: string
  description: string | null
  duration_days: number | null
  started_at?: string // YYYY-MM-DD, defaults to today
}

// User-editable subset of an existing goal. Metric fields stay agent-owned.
export type GoalPatch = Partial<Pick<Goal, 'title' | 'description' | 'status' | 'duration_days'>>

// One nightly row of the Zone-2-scoped fitness model (docs/zone2-fitness-model.md).
// Two independent numbers, NEVER summed: durable_base (slow, VO2max-anchored
// headline) and sharpness (fast current-form companion). Distinct from the
// whole-body ctl/atl/tsb in ComputedDaily.
export type Zone2EvidenceState = 'ok' | 'insufficient' | 'ambiguous' | 'low_confidence'
export type Zone2Stage = 'literature' | 'lightly_tuned' | 'personalized'

// Fixed-ceiling two-component model (docs/zone2-fitness-model.md v2): the headline
// index is durable_base + sharpness, each bounded by its own FIXED ceiling. These
// are design constants — the split never shifts with training age.
export const ZONE2_DURABLE_CEILING = 70
export const ZONE2_FAST_CEILING = 30
export const ZONE2_INDEX_CEILING = ZONE2_DURABLE_CEILING + ZONE2_FAST_CEILING // 100

export interface Zone2Fitness {
  date: string
  // two fixed-ceiling components summed into the headline index (= durable_base +
  // sharpness). durable_base ∈ [0, ZONE2_DURABLE_CEILING]; sharpness ∈
  // [0, ZONE2_FAST_CEILING]. The band columns are the INDEX band.
  durable_base: number | null
  durable_band_lo: number | null
  durable_band_hi: number | null
  sharpness: number | null
  // provenance / anchor
  vo2max_anchor_score: number | null
  days_since_vo2max: number | null
  // internal state (for the projection trail + audit)
  durable_load: number | null
  sharp_load: number | null
  base_accum_b: number | null
  tau_slow_days: number | null
  floor_score: number | null
  // confidence + evidence
  confidence: number | null
  evidence_state: Zone2EvidenceState
  contributing: Record<string, number> | null
  stage: Zone2Stage
  // maintenance / degradation warning + coaching horizons — ALL derived by the
  // nightly job from its own forward projection (docs v3 pt6). The renderer
  // only places these as dates from the row's date; it derives nothing itself.
  maintenance_met: boolean | null
  warn_after_days: number | null // continuous decay-onset horizon (days from row date)
  maintain_horizon_days: number | null // last day one session still holds the level
  build_interval_days: number | null // cadence where a session's build outpaces fast decay
  expected_session_build: number | null // per-session index increment used above (provenance)
  flags: Flag[]
  computed_at: string | null
}

// The typed surface exposed on window.api by the preload script.
export interface HealthApi {
  getWorkouts(fromIso: string, toIso: string): Promise<Workout[]>
  getWorkoutDetail(id: string): Promise<WorkoutDetail>
  getWorkoutPlaces(workoutIds: string[]): Promise<WorkoutPlace[]>
  getSwimSets(fromIso: string, toIso: string): Promise<SwimSet[]>
  getDailyMetrics(fromDate: string, toDate: string): Promise<DailyMetric[]>
  getComputedDaily(fromDate: string, toDate: string): Promise<ComputedDaily[]>
  getUserConfig(): Promise<UserConfig>
  updateUserConfig(patch: UserConfigPatch): Promise<UserConfig>
  getTodayFlags(): Promise<Flag[]>
  getInjuries(): Promise<Injury[]>
  getInjuryLog(injuryId: string): Promise<InjuryLogEntry[]>
  addInjuryLog(entry: NewInjuryLog): Promise<QueueableWriteResult<InjuryLogEntry>>
  deleteInjuryLog(id: number): Promise<QueueableWriteResult<void>>
  // End/reopen a recovery plan: 'resolved' marks it healed (sets resolved_at
  // server-side); 'active'/'recovering' reopen it (clears resolved_at).
  updateInjuryStatus(
    injuryId: string,
    status: Injury['status']
  ): Promise<QueueableWriteResult<Injury>>
  getInjuryPlan(injuryId: string): Promise<RecoveryPlanItem[]>
  updateInjuryPlanStart(injuryId: string, planStartedAt: string): Promise<QueueableWriteResult<Injury>>
  // Edit when the injury itself began (distinct from when the recovery plan started).
  updateInjuryStartedAt(injuryId: string, startedAt: string): Promise<QueueableWriteResult<Injury>>
  getInjuryPlanChecks(injuryId: string, fromDate: string): Promise<PlanItemCheck[]>
  setPlanItemCheck(itemId: string, doneDate: string, done: boolean): Promise<QueueableWriteResult<void>>
  getExercises(): Promise<Exercise[]>
  addExercise(name: string, bodyPart: GymBodyPart | null): Promise<Exercise>
  getGymTemplates(): Promise<GymTemplate[]>
  addGymTemplate(template: NewGymTemplate): Promise<QueueableWriteResult<GymTemplate>>
  updateGymTemplate(id: string, patch: GymTemplatePatch): Promise<QueueableWriteResult<GymTemplate>>
  deleteGymTemplate(id: string): Promise<QueueableWriteResult<void>>
  // Save an edited template as the next version in its family (previous versions
  // stay in history; the new one becomes current).
  createGymTemplateVersion(
    baseTemplateId: string,
    template: NewGymTemplate
  ): Promise<QueueableWriteResult<GymTemplate>>
  // All versions of a template family, ascending by version — powers the dropdown.
  getGymTemplateVersions(familyId: string): Promise<GymTemplate[]>
  // Open a run (activate / resurrect). No-op returning the open run if one exists.
  startGymTemplateRun(templateId: string): Promise<QueueableWriteResult<GymTemplateRun>>
  // Close the open run ("mark complete" / coach archive). Returns null if none open.
  completeGymTemplateRun(templateId: string): Promise<QueueableWriteResult<GymTemplateRun | null>>
  getGymSessions(fromIso: string, toIso: string): Promise<GymSession[]>
  addGymSession(session: NewGymSession): Promise<QueueableWriteResult<GymSession>>
  updateGymSession(id: string, patch: GymSessionPatch): Promise<QueueableWriteResult<GymSession>>
  deleteGymSession(id: string): Promise<QueueableWriteResult<void>>
  getGoals(): Promise<Goal[]>
  getGoalProgress(goalId: string): Promise<GoalProgressPoint[]>
  addGoal(goal: NewGoal): Promise<Goal>
  updateGoal(id: string, patch: GoalPatch): Promise<Goal>
  // Spawns a headless chat-agent run (cwd chatctx/) that designs the goal's
  // progress metric via goals.py; resolves when the run exits. Long-running.
  buildGoalMetric(goalId: string): Promise<{ ok: boolean; error?: string }>
  getZone2Fitness(fromDate: string, toDate: string): Promise<Zone2Fitness[]>
  getProteinLog(fromDate: string, toDate: string): Promise<ProteinDay[]>
  /** Increments the day's existing total (additive stacking — "+40g at dinner"). */
  addProtein(date: string, grams: number): Promise<QueueableWriteResult<ProteinDay>>
  /** Overwrites the day's total outright — for corrections, not stacking. */
  setProtein(date: string, grams: number): Promise<QueueableWriteResult<ProteinDay>>
  getOfflineQueueStatus(): Promise<OfflineQueueStatus>
  retryOfflineQueue(): Promise<OfflineQueueStatus>
  onOfflineQueueStatus(listener: (status: OfflineQueueStatus) => void): () => void
  getDbStatus(): Promise<DbStatus>
  /** Most recent raw_payloads.received_at (ISO string), or null if no payloads. Used as the data-freshness probe behind the Refresh button. */
  getLastIngestAt(): Promise<string | null>
  getInsightCorrelations(): Promise<InsightCorrelation[]>
  getInsightModels(): Promise<InsightModel[]>
  chatStatus(): Promise<ChatStatus>
  chatListSessions(): Promise<ChatSessionMeta[]>
  chatGetSession(id: string): Promise<ChatSession | null>
  chatPickAttachments(): Promise<ChatAttachment[]>
  // Validate drag-and-dropped file paths through the same size/type/existence
  // checks as the picker; returns the accepted attachments or throws.
  chatValidateAttachments(paths: string[]): Promise<ChatAttachment[]>
  // Resolve the absolute filesystem path of a dropped File. Runs in the preload
  // via Electron's webUtils (dropped File objects no longer expose `.path`).
  getPathForFile(file: File): string
  chatSend(
    sessionId: string | null,
    message: string,
    attachmentPaths?: string[]
  ): Promise<{ sessionId: string }>
  chatStop(sessionId: string): Promise<boolean>
  chatRename(id: string, title: string): Promise<void>
  chatDelete(id: string): Promise<void>
  onChatStream(
    listener: (payload: { sessionId: string; event: ChatStreamEvent }) => void
  ): () => void
}

export const IPC_CHANNELS = {
  getWorkouts: 'db:getWorkouts',
  getWorkoutDetail: 'db:getWorkoutDetail',
  getWorkoutPlaces: 'db:getWorkoutPlaces',
  getSwimSets: 'db:getSwimSets',
  getDailyMetrics: 'db:getDailyMetrics',
  getComputedDaily: 'db:getComputedDaily',
  getUserConfig: 'db:getUserConfig',
  updateUserConfig: 'db:updateUserConfig',
  getTodayFlags: 'db:getTodayFlags',
  getInjuries: 'db:getInjuries',
  getInjuryLog: 'db:getInjuryLog',
  addInjuryLog: 'db:addInjuryLog',
  deleteInjuryLog: 'db:deleteInjuryLog',
  updateInjuryStatus: 'db:updateInjuryStatus',
  getInjuryPlan: 'db:getInjuryPlan',
  updateInjuryPlanStart: 'db:updateInjuryPlanStart',
  updateInjuryStartedAt: 'db:updateInjuryStartedAt',
  getInjuryPlanChecks: 'db:getInjuryPlanChecks',
  setPlanItemCheck: 'db:setPlanItemCheck',
  getExercises: 'db:getExercises',
  addExercise: 'db:addExercise',
  getGymTemplates: 'db:getGymTemplates',
  addGymTemplate: 'db:addGymTemplate',
  updateGymTemplate: 'db:updateGymTemplate',
  deleteGymTemplate: 'db:deleteGymTemplate',
  createGymTemplateVersion: 'db:createGymTemplateVersion',
  getGymTemplateVersions: 'db:getGymTemplateVersions',
  startGymTemplateRun: 'db:startGymTemplateRun',
  completeGymTemplateRun: 'db:completeGymTemplateRun',
  getGymSessions: 'db:getGymSessions',
  addGymSession: 'db:addGymSession',
  updateGymSession: 'db:updateGymSession',
  deleteGymSession: 'db:deleteGymSession',
  getGoals: 'db:getGoals',
  getGoalProgress: 'db:getGoalProgress',
  addGoal: 'db:addGoal',
  updateGoal: 'db:updateGoal',
  getZone2Fitness: 'db:getZone2Fitness',
  getProteinLog: 'db:getProteinLog',
  addProtein: 'db:addProtein',
  setProtein: 'db:setProtein',
  getOfflineQueueStatus: 'offlineQueue:getStatus',
  retryOfflineQueue: 'offlineQueue:retry',
  offlineQueueStatus: 'offlineQueue:status',
  // Handler in index.ts delegates to chat.ts, which owns CLI process spawning.
  buildGoalMetric: 'goals:buildMetric',
  getDbStatus: 'db:getDbStatus',
  getLastIngestAt: 'db:getLastIngestAt',
  getInsightCorrelations: 'db:getInsightCorrelations',
  getInsightModels: 'db:getInsightModels',
  chatStatus: 'chat:status',
  chatListSessions: 'chat:listSessions',
  chatGetSession: 'chat:getSession',
  chatPickAttachments: 'chat:pickAttachments',
  chatValidateAttachments: 'chat:validateAttachments',
  chatSend: 'chat:send',
  // Registered in chat.ts (not main/index.ts) since chat.ts owns process lifecycle.
  chatStop: 'chat:stop',
  chatRename: 'chat:rename',
  chatDelete: 'chat:delete'
} as const

/** A user-selected local file. Contents never cross into the renderer process. */
export interface ChatAttachment {
  path: string
  name: string
  sizeBytes: number
}

export const MAX_CHAT_ATTACHMENTS = 8

export interface InsightCorrelation {
  var_x: string
  var_y: string
  lag_days: number
  r: number
  n: number
  p_value: number
}

export interface InsightModel {
  name: string
  computed_at: string | null
  spec: string | null
  coefficients: Record<
    string,
    { coef: number; ci_low: number; ci_high: number; p_value: number }
  > | null
  diagnostics: { n?: number; r2?: number; caveat?: string } | null
}

export interface ChatStatus {
  available: boolean
  version?: string
  error?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  ts: string
}

export interface ChatSessionMeta {
  id: string
  started_at: string
  title: string | null
}

export interface ChatSession extends ChatSessionMeta {
  claude_session_id: string | null
  messages: ChatMessage[]
}

export type ChatStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
