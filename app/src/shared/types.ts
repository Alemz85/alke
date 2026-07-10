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
  severity?: 'info' | 'warning' | 'critical'
  [key: string]: unknown
}

export interface DbStatus {
  connected: boolean
  error?: string
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
  getDbStatus(): Promise<DbStatus>
  getInsightCorrelations(): Promise<InsightCorrelation[]>
  getInsightModels(): Promise<InsightModel[]>
  chatStatus(): Promise<ChatStatus>
  chatListSessions(): Promise<ChatSessionMeta[]>
  chatGetSession(id: string): Promise<ChatSession | null>
  chatSend(sessionId: string | null, message: string): Promise<{ sessionId: string }>
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
  getDbStatus: 'db:getDbStatus',
  getInsightCorrelations: 'db:getInsightCorrelations',
  getInsightModels: 'db:getInsightModels',
  chatStatus: 'chat:status',
  chatListSessions: 'chat:listSessions',
  chatGetSession: 'chat:getSession',
  chatSend: 'chat:send'
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
