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

export interface ComputedWorkout {
  workout_id: string
  time_in_zones: Record<string, unknown> | null
  trimp: number | null
  ef: number | null
  decoupling_pct: number | null
  hrr60: number | null
  computed_at: string | null
}

export interface WorkoutDetail {
  workout: Omit<Workout, 'computed'>
  hrSamples: WorkoutHrSample[]
  computed: ComputedWorkout | null
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
  weekly_min_sessions: Record<string, unknown> | null
  timezone: string | null
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
    | 'weekly_min_sessions'
    | 'timezone'
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

export interface RecoveryPlanItem {
  id: string
  injury_id: string
  name: string
  // 'exercise' = rehab work (counts toward adherence); 'activity' = cleared/
  // allowed training (tracked, not scored); 'habit' = recurring non-exercise
  // behavior; 'constraint' = standing rule (no checks).
  kind: 'exercise' | 'habit' | 'constraint' | 'activity'
  weekly_target: number | null
  note: string | null
  active: boolean
  created_at: string | null
  updated_at: string | null
}

export interface PlanItemCheck {
  id: number
  item_id: string
  done_date: string
  source: string
}

// The typed surface exposed on window.api by the preload script.
export interface HealthApi {
  getWorkouts(fromIso: string, toIso: string): Promise<Workout[]>
  getWorkoutDetail(id: string): Promise<WorkoutDetail>
  getDailyMetrics(fromDate: string, toDate: string): Promise<DailyMetric[]>
  getComputedDaily(fromDate: string, toDate: string): Promise<ComputedDaily[]>
  getUserConfig(): Promise<UserConfig>
  updateUserConfig(patch: UserConfigPatch): Promise<UserConfig>
  getTodayFlags(): Promise<Flag[]>
  getInjuries(): Promise<Injury[]>
  getInjuryLog(injuryId: string): Promise<InjuryLogEntry[]>
  addInjuryLog(entry: NewInjuryLog): Promise<InjuryLogEntry>
  getInjuryPlan(injuryId: string): Promise<RecoveryPlanItem[]>
  getInjuryPlanChecks(injuryId: string, fromDate: string): Promise<PlanItemCheck[]>
  setPlanItemCheck(itemId: string, doneDate: string, done: boolean): Promise<void>
  getDbStatus(): Promise<DbStatus>
  getInsightCorrelations(): Promise<InsightCorrelation[]>
  getInsightModels(): Promise<InsightModel[]>
  chatStatus(): Promise<ChatStatus>
  chatListSessions(): Promise<ChatSessionMeta[]>
  chatGetSession(id: string): Promise<ChatSession | null>
  chatSend(sessionId: string | null, message: string): Promise<{ sessionId: string }>
  chatStop(sessionId: string): Promise<boolean>
  chatRename(id: string, title: string): Promise<void>
  chatDelete(id: string): Promise<void>
  onChatStream(listener: (payload: { sessionId: string; event: ChatStreamEvent }) => void): () => void
}

export const IPC_CHANNELS = {
  getWorkouts: 'db:getWorkouts',
  getWorkoutDetail: 'db:getWorkoutDetail',
  getDailyMetrics: 'db:getDailyMetrics',
  getComputedDaily: 'db:getComputedDaily',
  getUserConfig: 'db:getUserConfig',
  updateUserConfig: 'db:updateUserConfig',
  getTodayFlags: 'db:getTodayFlags',
  getInjuries: 'db:getInjuries',
  getInjuryLog: 'db:getInjuryLog',
  addInjuryLog: 'db:addInjuryLog',
  getInjuryPlan: 'db:getInjuryPlan',
  getInjuryPlanChecks: 'db:getInjuryPlanChecks',
  setPlanItemCheck: 'db:setPlanItemCheck',
  getDbStatus: 'db:getDbStatus',
  getInsightCorrelations: 'db:getInsightCorrelations',
  getInsightModels: 'db:getInsightModels',
  chatStatus: 'chat:status',
  chatListSessions: 'chat:listSessions',
  chatGetSession: 'chat:getSession',
  chatSend: 'chat:send',
  // Registered in chat.ts (not main/index.ts) since chat.ts owns process lifecycle.
  chatStop: 'chat:stop',
  chatRename: 'chat:rename',
  chatDelete: 'chat:delete'
} as const

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
  coefficients: Record<string, { coef: number; ci_low: number; ci_high: number; p_value: number }> | null
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
