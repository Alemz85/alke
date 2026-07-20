import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactElement
} from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowUpRight,
  ArrowDownRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Minus,
  Trash2,
  X
} from 'lucide-react'
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts'
import {
  INJURY_CONTEXTS,
  type Injury,
  type InjuryDatePrecision,
  type InjuryLogEntry,
  type InjuryNoteContext,
  type NewInjuryLog,
  type PlanItemCheck,
  type RecoveryPlanItem
} from '@shared/types'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'
import { BadgeDomain } from '../components/BadgeDomain'
import type { Domain } from '../components/domain'
import { RecoveryPlanDetail } from '../components/RecoveryPlanDetail'
import { useCardOrder } from '../hooks/useCardOrder'
import { toZonedYMD, ymdKey } from '../hooks/sessionsDate'
import {
  adherencePct,
  adherenceRating,
  currentPlanWeek,
  currentWeekAdherenceSummary,
  itemAdherenceRating,
  isPlanItemAccountable,
  phaseStartYMD,
  dailyPainSeries,
  dayScore,
  flareStats,
  humanizeDuration,
  isoWeekStart,
  maxWeeksAvailable,
  shiftYMD,
  todayUserEntry,
  weeklyAdherence,
  weeklyMatrix,
  weeklyProgressStatus,
  type FlareStats
} from '../lib/injuryStats'
import {
  applyPlanCheckOptimistic,
  makeOptimisticInjuryLog,
  patchInjuryPlanStart,
  patchInjuryStatus
} from '../lib/offlineOptimistic'
import { isQueuedWriteReceipt, replaceById } from '../lib/optimisticEntities'
import './InjuriesView.css'

const STATUS_LABEL: Record<Injury['status'], string> = {
  active: 'Active',
  recovering: 'Recovering',
  resolved: 'Resolved'
}

// Status is a claim about trajectory, so it borrows the same domain accents
// as the rest of the app: resolved reads as healed (aerobic), recovering as
// in-progress (sessions), active as the ongoing concern (flag).
const STATUS_DOMAIN: Record<Injury['status'], Domain> = {
  active: 'flag',
  recovering: 'sessions',
  resolved: 'aerobic'
}

const CONTEXT_LABEL: Record<InjuryNoteContext, string> = {
  during_workout: 'During workout',
  post_workout: 'Post-workout',
  at_rest: 'At rest',
  on_waking: 'On waking'
}

/** Severity tint: mild reads as neutral, moderate/severe escalate through the
 *  same warn/alert accents used everywhere else pain and adherence appear. */
function severityClass(severity: Injury['severity']): string {
  if (severity === 'severe') return 'injury-severity--severe'
  if (severity === 'moderate') return 'injury-severity--moderate'
  return 'injury-severity--mild'
}

/** Pain-number tint: 0–3 neutral, 4–6 caution, 7–10 concern. Always paired
 *  with the digit itself — color never stands alone for meaning. */
function painClass(pain: number): string {
  if (pain >= 7) return 'injury-pain--high'
  if (pain >= 4) return 'injury-pain--mid'
  return 'injury-pain--low'
}

type InjuryQuerySnapshot = [QueryKey, unknown]

function restoreInjurySnapshots(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshots: InjuryQuerySnapshot[] | undefined
): void {
  for (const [queryKey, data] of snapshots ?? []) queryClient.setQueryData(queryKey, data)
}

function isInjuryListQuery(queryKey: readonly unknown[]): boolean {
  return (
    (queryKey[0] === 'injuries' && queryKey[1] === 'list') ||
    (queryKey[0] === 'health' && queryKey[1] === 'injuries')
  )
}

type TabKey = 'active' | 'history'

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Short date for dense table rows: "Jul 10". */
function formatDateShort(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ymd
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** One endpoint of a log period, rendered only as precisely as it is known. */
function formatLogDate(ymd: string, precision: InjuryDatePrecision): string {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ymd
  if (precision === 'year') return d.toLocaleDateString(undefined, { year: 'numeric' })
  if (precision === 'month') return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A log entry's when: a single date, or "start – end" for a span. */
function formatLogPeriod(entry: InjuryLogEntry): string {
  const precision = entry.date_precision ?? 'day'
  const start = formatLogDate(entry.entry_date, precision)
  if (!entry.entry_end_date) return start
  const end = formatLogDate(entry.entry_end_date, precision)
  return end === start ? start : `${start} – ${end}`
}

function sourceLabel(source: string | null): string {
  if (source === 'user') return 'You'
  if (source === 'chat') return 'AI'
  return source ?? ''
}

// ── shared queries (one hook set per injury) ─────────────────────────────────

interface InjuryData {
  log: InjuryLogEntry[]
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  loading: boolean
}

function useInjuryData(injuryId: string, enabled: boolean, todayYMD: string): InjuryData {
  // A year of checks: the past-weeks table pages back 8 weeks at a time, so the
  // 90d chart window alone would starve it (check rows are tiny — fetch wide).
  const fromDate = shiftYMD(todayYMD, -365)
  const logQuery = useQuery({
    queryKey: ['injuries', 'log', injuryId],
    queryFn: () => window.api.getInjuryLog(injuryId),
    staleTime: 60_000,
    enabled
  })
  const planQuery = useQuery({
    queryKey: ['injuries', 'plan', injuryId],
    queryFn: () => window.api.getInjuryPlan(injuryId),
    staleTime: 60_000,
    enabled
  })
  const checksQuery = useQuery({
    queryKey: ['injuries', 'checks', injuryId, fromDate],
    queryFn: () => window.api.getInjuryPlanChecks(injuryId, fromDate),
    staleTime: 60_000,
    enabled
  })
  return {
    log: logQuery.data ?? [],
    plan: planQuery.data ?? [],
    checks: checksQuery.data ?? [],
    loading: logQuery.isLoading || planQuery.isLoading || checksQuery.isLoading
  }
}

// ── stat pieces ───────────────────────────────────────────────────────────────

/** Pain decreasing = improving = good (down arrow, aerobic). Pain increasing
 *  = worsening = bad (up arrow, flag). Flat stays neutral tertiary text. */
function TrendPill({ trend }: { trend: FlareStats['trend'] }): ReactElement {
  if (trend == null) return <span className="injury-stat-value">—</span>
  const Icon = trend === 'improving' ? ArrowDownRight : trend === 'worsening' ? ArrowUpRight : Minus
  const cls =
    trend === 'improving'
      ? 'injury-trend--improving'
      : trend === 'worsening'
        ? 'injury-trend--worsening'
        : 'injury-trend--stable'
  return (
    <span className={`injury-stat-value injury-trend ${cls}`}>
      <Icon size={14} strokeWidth={2} />
      {trend}
    </span>
  )
}

/** Section heading used throughout the full view: uppercase tertiary eyebrow
 *  over a display-weight title, so the page reads as an instrument with
 *  clear stops rather than a flat scroll of stacked cards. */
function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }): ReactElement {
  return (
    <div className="injury-section-head">
      <span className="injury-section-eyebrow">{eyebrow}</span>
      <h4 className="injury-section-title">{title}</h4>
    </div>
  )
}

function StatCell({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="injury-stat">
      <span className="injury-stat-label">{label}</span>
      {typeof children === 'string' ? (
        <span className="injury-stat-value tabular-nums">{children}</span>
      ) : (
        children
      )}
    </div>
  )
}

function StatRow({
  stats,
  adherence
}: {
  stats: FlareStats
  adherence: number | null
}): ReactElement {
  return (
    <div className="injury-stat-row">
      <StatCell label="Flare freq">
        {stats.perWeek30d == null ? '—' : `${stats.perWeek30d.toFixed(1)}/wk`}
      </StatCell>
      <StatCell label="Avg intensity">
        {stats.avgIntensity30d == null ? (
          '—'
        ) : (
          <span className={`injury-stat-value tabular-nums ${painClass(stats.avgIntensity30d)}`}>
            {stats.avgIntensity30d.toFixed(1)}/10
          </span>
        )}
      </StatCell>
      <StatCell label="Trend">
        <TrendPill trend={stats.trend} />
      </StatCell>
      <StatCell label="Adherence 7d">{adherence == null ? '—' : `${adherence}%`}</StatCell>
    </div>
  )
}

interface PainPoint {
  date: string
  pain: number | null
  adherence: number | null
}

/** Chart series: per-day-max pain (last 90d) + weekly-adherence underlay bars. */
function usePainSeries(
  log: InjuryLogEntry[],
  plan: RecoveryPlanItem[],
  checks: PlanItemCheck[],
  todayYMD: string,
  planStartedAt: string | null
): PainPoint[] {
  return useMemo(() => {
    const start = shiftYMD(todayYMD, -90)
    // 13 ISO weeks ≈ 90 days of underlay bars.
    const weekly = weeklyAdherence(plan, checks, todayYMD, 13, planStartedAt)

    const points: PainPoint[] = []
    // One point per day carrying that day's MAX pain.
    for (const d of dailyPainSeries(log)) {
      if (d.date < start || d.date > todayYMD) continue
      points.push({ date: d.date, pain: d.pain, adherence: null })
    }
    // Adherence underlay: one point per week start carrying its pct.
    for (const w of weekly) {
      if (w.weekStart < start) continue
      points.push({ date: w.weekStart, pain: null, adherence: w.pct })
    }
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    return points
  }, [log, plan, checks, todayYMD, planStartedAt])
}

const CHART_TERTIARY = 'var(--color-text-tertiary)'
const CHART_GRID = 'var(--color-divider-soft)'
// Pain is the flagged metric in this view: the line takes the flag accent so
// a glance at the chart reads the same as a glance at the pain digits.
const CHART_LINE = 'var(--color-flag)'
const CHART_UNDERLAY = 'var(--color-zone-neutral-1)'

const tooltipStyle = {
  backgroundColor: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 12,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums' as const
}

function PainChart({ data, tall }: { data: PainPoint[]; tall: boolean }): ReactElement {
  return (
    <ResponsiveContainer width="100%" height={tall ? 200 : 64}>
      <ComposedChart data={data} margin={{ top: 6, right: 6, left: tall ? -20 : -40, bottom: 0 }}>
        {tall && <CartesianGrid stroke={CHART_GRID} vertical={false} />}
        <XAxis
          dataKey="date"
          hide={!tall}
          tick={{ fill: CHART_TERTIARY, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(d: string) => d.slice(5)}
          minTickGap={24}
        />
        <YAxis
          yAxisId="pain"
          domain={[0, 10]}
          hide={!tall}
          tick={{ fill: CHART_TERTIARY, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={28}
        />
        <YAxis yAxisId="adh" domain={[0, 100]} hide orientation="right" />
        {tall && <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--color-chart-cursor)' }} />}
        <Bar
          yAxisId="adh"
          dataKey="adherence"
          fill={CHART_UNDERLAY}
          radius={[2, 2, 0, 0]}
          maxBarSize={tall ? 28 : 14}
          isAnimationActive={false}
        />
        <Line
          yAxisId="pain"
          type="monotone"
          dataKey="pain"
          stroke={CHART_LINE}
          strokeWidth={1.5}
          dot={{ r: tall ? 2.5 : 1.5, fill: CHART_LINE }}
          connectNulls
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ── quick-log flare form ──────────────────────────────────────────────────────

function FlareForm({
  injuryId,
  todayYMD,
  onDone,
  onCancel
}: {
  injuryId: string
  todayYMD: string
  onDone: () => void
  onCancel: () => void
}): ReactElement {
  const queryClient = useQueryClient()
  const [pain, setPain] = useState<number | null>(null)
  const [contexts, setContexts] = useState<InjuryNoteContext[]>([])
  const [note, setNote] = useState('')

  const mutation = useMutation({
    mutationFn: async () => {
      let workoutId: string | null = null
      // If the flare is tied to activity, attach the latest workout that day.
      if (contexts.includes('during_workout') || contexts.includes('post_workout')) {
        const fromIso = `${todayYMD}T00:00:00.000Z`
        const toIso = `${todayYMD}T23:59:59.999Z`
        const workouts = await window.api.getWorkouts(fromIso, toIso)
        if (workouts.length > 0) {
          const latest = [...workouts].sort((a, b) => (a.start_at < b.start_at ? 1 : -1))[0]
          workoutId = latest.id
        }
      }
      return window.api.addInjuryLog({
        injury_id: injuryId,
        note: note.trim() || 'Flare-up',
        pain_level: pain,
        context: contexts,
        workout_id: workoutId
      })
    },
    scope: { id: `injury-log:${injuryId}` },
    meta: { errorMessage: 'Couldn’t save the injury note. It was removed from the log.' },
    onMutate: async () => {
      const queryKey = ['injuries', 'log', injuryId] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueriesData<InjuryLogEntry[]>({ queryKey }) as InjuryQuerySnapshot[]
      const temporaryId = -Date.now()
      const input: NewInjuryLog = {
        injury_id: injuryId,
        note: note.trim() || 'Flare-up',
        pain_level: pain,
        context: contexts
      }
      const temporary = makeOptimisticInjuryLog(input, temporaryId, todayYMD)
      queryClient.setQueryData<InjuryLogEntry[]>(queryKey, (rows = []) => [temporary, ...rows])
      return { previous, temporaryId }
    },
    onSuccess: (result, _variables, context) => {
      if (isQueuedWriteReceipt(result)) return
      queryClient.setQueryData<InjuryLogEntry[]>(['injuries', 'log', injuryId], (rows = []) =>
        rows.map((row) => (row.id === context.temporaryId ? result : row))
      )
    },
    onError: (_error, _variables, context) =>
      restoreInjurySnapshots(queryClient, context?.previous)
  })

  return (
    <div className="injury-flare-form">
      <div className="injury-pain-scale" role="group" aria-label="Pain level">
        <div className="injury-pain-buttons">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              className={`injury-pain-btn${pain === n ? ' injury-pain-btn--active' : ''}`}
              aria-pressed={pain === n}
              onClick={() => setPain(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="injury-pain-anchors">
          <span>1–3 noticeable, doesn&apos;t limit</span>
          <span>4–6 modifies activity</span>
          <span>7–10 prevents activity</span>
        </div>
      </div>

      <div className="injury-context-chips" role="group" aria-label="Context">
        {INJURY_CONTEXTS.map((c) => (
          <button
            key={c}
            type="button"
            className={`chip injury-context-chip${contexts.includes(c) ? ' chip--active' : ''}`}
            aria-pressed={contexts.includes(c)}
            onClick={() =>
              setContexts((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
            }
          >
            {CONTEXT_LABEL[c]}
          </button>
        ))}
      </div>

      <input
        className="injury-note-input"
        type="text"
        placeholder="Optional note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="injury-form-actions">
        <button
          type="button"
          className="injury-btn injury-btn--primary"
          disabled={mutation.isPending}
          onClick={() => {
            mutation.mutate()
            onDone()
          }}
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="injury-btn" onClick={onCancel} disabled={mutation.isPending}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── action row (Feeling fine · Log flare-up · Recovery plan) ──────────────────

function ActionRow({
  injury,
  todayYMD,
  log,
  flareOpen,
  onToggleFlare,
  onOpenPlan,
  showPlanAction = true
}: {
  injury: Injury
  todayYMD: string
  log: InjuryLogEntry[]
  flareOpen: boolean
  onToggleFlare: () => void
  onOpenPlan: () => void
  showPlanAction?: boolean
}): ReactElement {
  const queryClient = useQueryClient()

  // Ground "already logged today" in the actual log rather than a timer:
  // the button stays disabled/labelled for as long as today's entry exists,
  // however long that is, and re-enables the instant it's edited away (e.g.
  // the user deletes today's entry). This is also what stops repeat clicks
  // from appending duplicate optimistic rows — see logFeelingFine below.
  const todaysEntry = useMemo(() => todayUserEntry(log, todayYMD), [log, todayYMD])
  const loggedFineToday = todaysEntry != null && todaysEntry.note === 'Feeling fine'

  const fineMutation = useMutation({
    mutationFn: () =>
      window.api.addInjuryLog({ injury_id: injury.id, note: 'Feeling fine', pain_level: 0, context: [] }),
    scope: { id: `injury-log:${injury.id}` },
    meta: { errorMessage: 'Couldn’t save the recovery note. It was removed from the log.' },
    onMutate: async () => {
      const queryKey = ['injuries', 'log', injury.id] as const
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueriesData<InjuryLogEntry[]>({ queryKey }) as InjuryQuerySnapshot[]
      const temporaryId = -Date.now()
      const temporary = makeOptimisticInjuryLog(
        { injury_id: injury.id, note: 'Feeling fine', pain_level: 0, context: [] },
        temporaryId,
        todayYMD
      )
      // Mirror the server's same-day merge: replace today's existing
      // single-day user entry in place rather than always prepending a new
      // one, so a stray repeat click can never produce a second row.
      queryClient.setQueryData<InjuryLogEntry[]>(queryKey, (rows = []) => {
        const existing = todayUserEntry(rows, todayYMD)
        if (existing) return rows.map((row) => (row.id === existing.id ? temporary : row))
        return [temporary, ...rows]
      })
      return { previous, temporaryId }
    },
    onSuccess: (result, _variables, context) => {
      if (isQueuedWriteReceipt(result)) return
      queryClient.setQueryData<InjuryLogEntry[]>(['injuries', 'log', injury.id], (rows = []) =>
        rows.map((row) => (row.id === context.temporaryId ? result : row))
      )
    },
    onError: (_error, _variables, context) => restoreInjurySnapshots(queryClient, context?.previous)
  })

  const logFeelingFine = (): void => {
    // Already-logged-today is a no-op at the source, not just a disabled
    // button: guards against a click that lands between the disabled prop
    // updating and the next render (e.g. rapid double-click).
    if (loggedFineToday || fineMutation.isPending) return
    fineMutation.mutate()
  }

  // Buttons stop propagation so they never trigger the card's navigation.
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  return (
    <div className="injury-actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="injury-btn injury-action-btn"
        disabled={fineMutation.isPending || loggedFineToday}
        aria-pressed={loggedFineToday}
        onClick={stop(logFeelingFine)}
      >
        {loggedFineToday ? '✓ Logged today' : 'Feeling fine'}
      </button>
      <button
        type="button"
        className={`injury-btn injury-action-btn${flareOpen ? ' injury-action-btn--active' : ''}`}
        aria-expanded={flareOpen}
        onClick={stop(onToggleFlare)}
      >
        Log flare-up
      </button>
      {showPlanAction && (
        <button type="button" className="injury-btn injury-action-btn" onClick={stop(onOpenPlan)}>
          Recovery plan
        </button>
      )}
    </div>
  )
}

// ── recovery plan modal ───────────────────────────────────────────────────────

function RecoveryPlanModal({
  injury,
  plan,
  checks,
  todayYMD,
  onClose
}: {
  injury: Injury
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  todayYMD: string
  onClose: () => void
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="injury-modal-overlay" onClick={onClose}>
      <div
        className="injury-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${injury.name} recovery plan`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="injury-modal-head">
          <div>
            <span className="injury-modal-kicker">Recovery plan</span>
            <h3 className="injury-modal-title">{injury.name}</h3>
          </div>
          <button type="button" className="injury-modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className="injury-modal-body">
          <RecoveryPlanDetail
            overview={injury.recovery_plan}
            items={plan}
            currentWeek={currentPlanWeek(injury.plan_started_at, todayYMD)}
            emptyText="No plan items yet."
            statusFor={(item) => {
              return weeklyProgressStatus(
                item,
                checks,
                todayYMD,
                injury.plan_started_at
              )
            }}
          />
        </div>
      </div>
    </div>
  )
}

function PlanStartControl({
  injury,
  todayYMD,
  readOnly = false
}: {
  injury: Injury
  todayYMD: string
  readOnly?: boolean
}): ReactElement {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const mutation = useMutation({
    mutationFn: (planStartedAt: string) =>
      window.api.updateInjuryPlanStart(injury.id, planStartedAt),
    scope: { id: `injury-plan-start:${injury.id}` },
    meta: { errorMessage: 'Couldn’t update the plan start. The previous date was restored.' },
    onMutate: async (planStartedAt) => {
      await queryClient.cancelQueries({ predicate: (query) => isInjuryListQuery(query.queryKey) })
      const previous = queryClient.getQueriesData<Injury[]>({
        predicate: (query) => isInjuryListQuery(query.queryKey)
      }) as InjuryQuerySnapshot[]
      for (const [queryKey, rows] of previous as Array<[QueryKey, Injury[] | undefined]>) {
        queryClient.setQueryData(queryKey, patchInjuryPlanStart(rows ?? [], injury.id, planStartedAt))
      }
      return { previous }
    },
    onSuccess: (result) => {
      setEditing(false)
      if (isQueuedWriteReceipt(result)) return
      for (const [queryKey, rows] of queryClient.getQueriesData<Injury[]>({
        predicate: (query) => isInjuryListQuery(query.queryKey)
      })) {
        queryClient.setQueryData(queryKey, replaceById(rows ?? [], injury.id, result))
      }
    },
    onError: (_error, _date, context) => restoreInjurySnapshots(queryClient, context?.previous)
  })
  const planWeek = currentPlanWeek(injury.plan_started_at, todayYMD)

  return (
    <div className="injury-plan-timing">
      <CalendarDays size={15} strokeWidth={1.75} aria-hidden="true" />
      {editing && !readOnly ? (
        <DateEditField
          label="Plan start"
          value={injury.plan_started_at ?? todayYMD}
          max={todayYMD}
          disabled={mutation.isPending}
          onCommit={(nextValue) => mutation.mutate(nextValue)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          className="injury-plan-date-button"
          disabled={readOnly}
          onClick={() => setEditing(true)}
        >
          {injury.plan_started_at ? `Plan started ${formatDateShort(injury.plan_started_at)}` : 'Set plan start'}
        </button>
      )}
      {planWeek != null && planWeek > 0 && (
        <span className="injury-plan-week tabular-nums">Week {planWeek}</span>
      )}
      {mutation.isError && <span className="injury-plan-date-error">Could not update date</span>}
    </div>
  )
}

function StartedAtControl({
  injury,
  todayYMD,
  readOnly = false
}: {
  injury: Injury
  todayYMD: string
  readOnly?: boolean
}): ReactElement {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const mutation = useMutation({
    mutationFn: (startedAt: string) => window.api.updateInjuryStartedAt(injury.id, startedAt),
    scope: { id: `injury-started-at:${injury.id}` },
    meta: { errorMessage: 'Couldn’t update the injury start. The previous date was restored.' },
    onMutate: async (startedAt) => {
      await queryClient.cancelQueries({ predicate: (query) => isInjuryListQuery(query.queryKey) })
      const previous = queryClient.getQueriesData<Injury[]>({
        predicate: (query) => isInjuryListQuery(query.queryKey)
      }) as InjuryQuerySnapshot[]
      for (const [queryKey, rows] of previous as Array<[QueryKey, Injury[] | undefined]>) {
        queryClient.setQueryData(
          queryKey,
          (rows ?? []).map((row) =>
            row.id === injury.id
              ? { ...row, started_at: startedAt, updated_at: new Date().toISOString() }
              : row
          )
        )
      }
      return { previous }
    },
    onSuccess: (result) => {
      setEditing(false)
      if (isQueuedWriteReceipt(result)) return
      for (const [queryKey, rows] of queryClient.getQueriesData<Injury[]>({
        predicate: (query) => isInjuryListQuery(query.queryKey)
      })) {
        queryClient.setQueryData(queryKey, replaceById(rows ?? [], injury.id, result))
      }
    },
    onError: (_error, _date, context) => restoreInjurySnapshots(queryClient, context?.previous)
  })

  return (
    <div className="injury-plan-timing">
      <CalendarDays size={15} strokeWidth={1.75} aria-hidden="true" />
      {editing && !readOnly ? (
        <DateEditField
          label="Injury started"
          value={injury.started_at ?? todayYMD}
          max={todayYMD}
          disabled={mutation.isPending}
          onCommit={(nextValue) => mutation.mutate(nextValue)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          className="injury-plan-date-button"
          disabled={readOnly}
          onClick={() => setEditing(true)}
        >
          {injury.started_at ? `Injury started ${formatDate(injury.started_at)}` : 'Set injury start'}
        </button>
      )}
      {mutation.isError && <span className="injury-plan-date-error">Could not update date</span>}
    </div>
  )
}

/**
 * Shared editing mechanism for the `type="date"` fields in this view
 * (plan start, injury start — and any future date field). The browser fires
 * `onChange` on every keystroke into a date subfield and on every calendar
 * click, long before the user is done composing a value, so `onChange` must
 * never itself commit. Instead: track a local draft, and commit exactly once
 * — on blur (if the draft changed and is a complete, valid date) or on
 * Enter. Escape cancels back to the last committed value without saving.
 */
function DateEditField({
  label,
  value,
  max,
  disabled,
  onCommit,
  onCancel
}: {
  label: string
  value: string
  max?: string
  disabled?: boolean
  onCommit: (nextValue: string) => void
  onCancel: () => void
}): ReactElement {
  const [draft, setDraft] = useState(value)

  const commitIfChanged = (): void => {
    if (draft && draft !== value) onCommit(draft)
    else onCancel()
  }

  return (
    <label className="injury-plan-date-field">
      <span>{label}</span>
      <input
        type="date"
        value={draft}
        max={max}
        disabled={disabled}
        autoFocus
        // Composing only — never commits. The native picker and manual typing
        // both fire this repeatedly before the user has finished choosing.
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!disabled) commitIfChanged()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (!disabled) commitIfChanged()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(value)
            onCancel()
          }
        }}
      />
    </label>
  )
}

// ── status control (Mark as healed / Reopen) ──────────────────────────────────

/**
 * Ends or reopens an injury's recovery. A two-step inline confirm (never the
 * renderer-freezing browser confirm()): the first click arms a confirm state
 * that auto-disarms after a few seconds, the second click commits.
 */
function StatusControl({ injury }: { injury: Injury }): ReactElement {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const mutation = useMutation({
    mutationFn: (status: Injury['status']) => window.api.updateInjuryStatus(injury.id, status),
    scope: { id: `injury-status:${injury.id}` },
    meta: { errorMessage: 'Couldn’t update the injury status. The previous status was restored.' },
    onMutate: async (status) => {
      await queryClient.cancelQueries({ predicate: (query) => isInjuryListQuery(query.queryKey) })
      const previous = queryClient.getQueriesData<Injury[]>({
        predicate: (query) => isInjuryListQuery(query.queryKey)
      }) as InjuryQuerySnapshot[]
      for (const [queryKey, rows] of previous as Array<[QueryKey, Injury[] | undefined]>) {
        queryClient.setQueryData(queryKey, patchInjuryStatus(rows ?? [], injury.id, status))
      }
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      setConfirming(false)
      return { previous }
    },
    onSuccess: (result) => {
      if (isQueuedWriteReceipt(result)) return
      for (const [queryKey, rows] of queryClient.getQueriesData<Injury[]>({
        predicate: (query) => isInjuryListQuery(query.queryKey)
      })) {
        queryClient.setQueryData(queryKey, replaceById(rows ?? [], injury.id, result))
      }
    },
    onError: (_error, _status, context) => {
      restoreInjurySnapshots(queryClient, context?.previous)
    }
  })

  if (injury.status === 'resolved') {
    return (
      <div className="injury-status-control">
        <button
          type="button"
          className="injury-btn injury-action-btn"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate('active')}
        >
          {mutation.isPending ? 'Reopening…' : 'Reopen'}
        </button>
        {mutation.isError && <span className="injury-plan-date-error">Could not reopen</span>}
      </div>
    )
  }

  const handleClick = (): void => {
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 4000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    mutation.mutate('resolved')
  }

  return (
    <div className="injury-status-control">
      {confirming ? (
        <>
          <span className="injury-confirm-label">Mark healed?</span>
          <button
            type="button"
            className="injury-btn injury-action-btn injury-action-btn--confirm"
            disabled={mutation.isPending}
            onClick={handleClick}
          >
            {mutation.isPending ? 'Saving…' : 'Confirm'}
          </button>
          <button
            type="button"
            className="injury-btn injury-action-btn"
            disabled={mutation.isPending}
            onClick={() => {
              if (confirmTimer.current) clearTimeout(confirmTimer.current)
              setConfirming(false)
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="injury-btn injury-action-btn" onClick={handleClick}>
          Mark as healed
        </button>
      )}
      {mutation.isError && <span className="injury-plan-date-error">Could not update status</span>}
    </div>
  )
}

// ── delete control (permanent — distinct from Mark as healed / resolve) ───────

/**
 * Permanently deletes an injury (logs/plan/checks cascade server-side).
 * Two-step inline confirm — never browser confirm()/alert() — mirrors
 * StatusControl/LogRowDelete above. deleteInjury may queue offline, so this
 * refetches the list rather than trusting the return value, then navigates
 * back to the list either way (the item is gone from the user's perspective).
 */
function InjuryDeleteControl({ injuryId, onDeleted }: { injuryId: string; onDeleted: () => void }): ReactElement {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const mutation = useMutation({
    mutationFn: () => window.api.deleteInjury(injuryId),
    meta: { errorMessage: 'Couldn’t delete the injury. It has not been removed.' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['injuries'] })
      onDeleted()
    }
  })

  const handleClick = (): void => {
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 4000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    mutation.mutate()
  }

  return (
    <div className="injury-delete-control">
      {confirming ? (
        <>
          <span className="injury-confirm-label">Delete permanently?</span>
          <button
            type="button"
            className="injury-btn injury-action-btn injury-action-btn--danger"
            disabled={mutation.isPending}
            onClick={handleClick}
          >
            {mutation.isPending ? 'Deleting…' : 'Confirm'}
          </button>
          <button
            type="button"
            className="injury-btn injury-action-btn"
            disabled={mutation.isPending}
            onClick={() => {
              if (confirmTimer.current) clearTimeout(confirmTimer.current)
              setConfirming(false)
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="injury-delete-btn"
          onClick={handleClick}
          title="Permanently deletes this injury and its logs, plan and checks"
        >
          <Trash2 size={14} strokeWidth={1.6} aria-hidden="true" />
          Delete injury
        </button>
      )}
      {mutation.isError && <span className="injury-plan-date-error">Could not delete</span>}
    </div>
  )
}

// ── this-week daily table ─────────────────────────────────────────────────────

/** Active checkable columns: exercises first, then activities. */
function checkableColumns(plan: RecoveryPlanItem[]): {
  exercises: RecoveryPlanItem[]
  activities: RecoveryPlanItem[]
} {
  return {
    exercises: plan.filter((i) => i.active && i.kind === 'exercise'),
    activities: plan.filter((i) => i.active && i.kind === 'activity')
  }
}

function ThisWeekTable({
  injuryId,
  plan,
  checks,
  todayYMD,
  log,
  readOnly,
  planStartedAt
}: {
  injuryId: string
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  todayYMD: string
  log: InjuryLogEntry[]
  readOnly: boolean
  planStartedAt: string | null
}): ReactElement | null {
  const queryClient = useQueryClient()

  const checkMutation = useMutation({
    mutationFn: ({ itemId, dateYMD, done }: { itemId: string; dateYMD: string; done: boolean }) =>
      window.api.setPlanItemCheck(itemId, dateYMD, done),
    // Scoped per-injury (not a single flat string): mutations sharing a
    // scope run serially, one at a time. A flat 'injury-plan-checks' scope
    // meant toggling a check for injury A queued behind an in-flight toggle
    // for unrelated injury B — worse, `useMutation`'s scope is fixed at
    // construction time, so it can't vary per (itemId, dateYMD) click the
    // way the finding's ideal key would; injuryId is the finest key stable
    // across this table's lifetime (one ThisWeekTable per injury's full
    // view), and different items/dates within the SAME injury toggling in
    // quick succession is an acceptable, rare serialization cost — the same
    // tradeoff useUpdateGymSession/useAddProtein make at their own stable
    // per-render key.
    scope: { id: `injury-plan-checks:${injuryId}` },
    meta: { errorMessage: 'Couldn’t update the recovery check. The checkbox was restored.' },
    onMutate: async ({ itemId, dateYMD, done }) => {
      await queryClient.cancelQueries({ queryKey: ['injuries', 'checks'] })
      const previous = queryClient.getQueriesData<PlanItemCheck[]>({
        queryKey: ['injuries', 'checks']
      })
      queryClient.setQueriesData<PlanItemCheck[]>(
        { queryKey: ['injuries', 'checks'] },
        (current) =>
          current ? applyPlanCheckOptimistic(current, itemId, dateYMD, done) : current
      )
      return { previous }
    },
    onError: (_error, _variables, context) => {
      for (const [queryKey, data] of context?.previous ?? []) {
        queryClient.setQueryData(queryKey, data)
      }
    },
    onSuccess: (result) => {
      if (!isQueuedWriteReceipt(result)) {
        void queryClient.invalidateQueries({ queryKey: ['injuries'] })
        // The Gym tab's recovery-plan bundles (useRecoveryPlanBundles in
        // useGymData.ts) read the view-neutral ['health', 'injuries'] /
        // ['health', 'injuryPlan', id] families, not this view's ['injuries', ...]
        // keys — without this, a plan-check toggled here never refreshed the
        // Gym tab's copy of the same plan.
        void queryClient.invalidateQueries({ queryKey: ['health', 'injuries'] })
      }
    }
  })

  const { exercises, activities } = checkableColumns(plan)
  const columns = [...exercises, ...activities]
  const summary = currentWeekAdherenceSummary(plan, checks, todayYMD, planStartedAt)
  const summaryByItem = new Map(summary.rows.map((row) => [row.itemId, row]))

  // checked ids per YMD, and day-max pain per YMD.
  const checkedByDay = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const c of checks) {
      const d = c.done_date.slice(0, 10)
      let set = m.get(d)
      if (!set) {
        set = new Set()
        m.set(d, set)
      }
      set.add(c.item_id)
    }
    return m
  }, [checks])

  const painByDay = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of dailyPainSeries(log)) m.set(d.date, d.pain)
    return m
  }, [log])

  if (columns.length === 0) return null

  // Monday of the current ISO week through today (future days omitted).
  const weekStart = isoWeekStart(todayYMD)
  const rows: string[] = []
  for (let d = weekStart; d <= todayYMD; d = shiftYMD(d, 1)) rows.push(d)

  // "Done for the week": a scored item whose weekly count met its acceptable
  // dose. Its whole column mutes for the rest of the week (still clickable).
  const isMet = (item: RecoveryPlanItem): boolean => {
    const row = summaryByItem.get(item.id)
    return (
      row != null &&
      row.accountable &&
      row.scored &&
      row.acceptable != null &&
      row.done >= row.acceptable
    )
  }

  const toggle = (itemId: string, dateYMD: string, done: boolean): void => {
    if (readOnly) return
    checkMutation.mutate({ itemId, dateYMD, done })
  }

  const renderHeader = (item: RecoveryPlanItem, isActivity: boolean, i: number): ReactElement => {
    const summaryRow = summaryByItem.get(item.id)
    const met = isMet(item)
    const accountable = isPlanItemAccountable(item, planStartedAt, todayYMD)
    const phaseStart = accountable ? null : phaseStartYMD(item, planStartedAt)
    const progressDetails: string[] = []
    if (summaryRow != null) {
      if (!summaryRow.accountable) {
        if (!summaryRow.scored) progressDetails.push('Unscored')
        if (summaryRow.done > 0) progressDetails.push(`${summaryRow.done} done early`)
      } else if (!summaryRow.scored) {
        progressDetails.push('Unscored')
        progressDetails.push(
          summaryRow.prescribed != null && summaryRow.prescribed > 0
            ? `${summaryRow.done}/${summaryRow.prescribed} this week`
            : `${summaryRow.done} this week`
        )
      } else if (summaryRow.acceptable != null) {
        progressDetails.push(`${summaryRow.done}/${summaryRow.acceptable} acceptable`)
        if (summaryRow.minimum != null && summaryRow.minimum !== summaryRow.acceptable) {
          progressDetails.push(`${summaryRow.minimum} minimum`)
        }
        if (summaryRow.prescribed != null && summaryRow.prescribed !== summaryRow.acceptable) {
          progressDetails.push(`${summaryRow.prescribed} prescribed`)
        }
      }
    }
    const cls = [
      'injury-adh-th-item',
      isActivity ? 'injury-adh-th-activity' : '',
      isActivity && i === 0 ? 'injury-adh-th-divider' : '',
      met ? 'injury-adh-th--met' : '',
      !accountable ? 'injury-adh-th--future' : ''
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <th key={item.id} className={cls} title={item.name}>
        <span className="injury-adh-th-label">{item.name}</span>
        {(phaseStart || progressDetails.length > 0) && (
          <span className="injury-adh-th-meta">
            {phaseStart && (
              <span className="injury-adh-th-phase tabular-nums">
                Starts {formatDateShort(phaseStart)}
              </span>
            )}
            {phaseStart && progressDetails.length > 0 && <span aria-hidden="true"> · </span>}
            {progressDetails.map((detail, detailIndex) => (
              <span key={detail} className="injury-adh-th-progress tabular-nums">
                {detailIndex > 0 && <span aria-hidden="true"> · </span>}
                {detail}
              </span>
            ))}
          </span>
        )}
      </th>
    )
  }

  const renderCell = (
    item: RecoveryPlanItem,
    ymd: string,
    isActivity: boolean,
    i: number
  ): ReactElement => {
    const on = (checkedByDay.get(ymd) ?? new Set<string>()).has(item.id)
    const met = isMet(item)
    const accountable = isPlanItemAccountable(item, planStartedAt, ymd)
    // A recorded completion always renders at full strength, even in a phase
    // that hasn't started (done ahead of schedule, e.g. via the gym bridge) —
    // future-muting means "not expected yet", never "not done".
    const tdCls = [
      'injury-adh-cell',
      isActivity ? 'injury-adh-cell-activity' : '',
      isActivity && i === 0 ? 'injury-adh-cell-divider' : '',
      met ? 'injury-adh-cell--met' : '',
      !accountable && !on ? 'injury-adh-cell--future' : ''
    ]
      .filter(Boolean)
      .join(' ')
    const btnCls = [
      'injury-adh-check',
      isActivity ? 'injury-adh-check-activity' : '',
      on ? 'injury-adh-check--on' : ''
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <td key={item.id} className={tdCls}>
        <button
          type="button"
          className={btnCls}
          aria-pressed={on}
          aria-label={`${item.name} on ${formatDateShort(ymd)}`}
          disabled={readOnly || checkMutation.isPending}
          onClick={() => toggle(item.id, ymd, !on)}
        >
          {on && <Check size={12} strokeWidth={2.5} />}
        </button>
      </td>
    )
  }

  return (
    <>
      <div className="injury-current-week-summary">
        <span className="injury-current-week-summary-label">Week-to-date adherence</span>
        {summary.pct != null ? (
          <span
            className={`injury-rate-chip injury-rate--${adherenceRating(summary.pct, 100)} tabular-nums`}
          >
            {summary.pct}%
          </span>
        ) : (
          <span className="injury-current-week-summary-empty">Not yet scored</span>
        )}
      </div>
      <div className="injury-adh-wrap">
        <table className="injury-adh-table">
        <thead>
          <tr>
            <th className="injury-adh-th-date">Date</th>
            <th className="injury-adh-th-score">Score</th>
            {exercises.map((item) => renderHeader(item, false, -1))}
            {activities.map((item, i) => renderHeader(item, true, i))}
          </tr>
        </thead>
        <tbody>
          {rows.map((ymd) => {
            const score = dayScore(plan, checks, ymd, planStartedAt)
            const pain = painByDay.get(ymd)
            const intensity = score.total > 0 ? score.done / score.total : 0
            return (
              <tr key={ymd} className="injury-adh-row">
                <td className="injury-adh-date tabular-nums">
                  <span>{formatDateShort(ymd)}</span>
                  {pain != null && pain >= 1 && (
                    <span className={`injury-adh-pain tabular-nums ${painClass(pain)}`}>{pain}/10</span>
                  )}
                </td>
                <td className="injury-adh-score">
                  {score.total > 0 ? (
                    <span
                      className="injury-adh-score-pill tabular-nums"
                      style={{ opacity: 0.4 + intensity * 0.6 }}
                    >
                      {score.done}/{score.total}
                    </span>
                  ) : (
                    <span className="injury-adh-score-empty">—</span>
                  )}
                </td>
                {exercises.map((item) => renderCell(item, ymd, false, -1))}
                {activities.map((item, i) => renderCell(item, ymd, true, i))}
              </tr>
            )
          })}
        </tbody>
        </table>
      </div>
    </>
  )
}

// ── past-weeks history table ──────────────────────────────────────────────────

function RatingChip({ done, item }: { done: number; item: RecoveryPlanItem }): ReactElement {
  const rating = itemAdherenceRating(done, item)
  const target = item.weekly_target
  return (
    <span className={`injury-rate-chip injury-rate--${rating} tabular-nums`}>
      {target != null && target > 0 ? `${done}/${target}` : `${done}`}
    </span>
  )
}

function PastWeeksTable({
  plan,
  checks,
  todayYMD,
  planStartedAt
}: {
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  todayYMD: string
  planStartedAt: string | null
}): ReactElement | null {
  const [weeksShown, setWeeksShown] = useState(8)

  const { exercises, activities } = checkableColumns(plan)
  const columns = [...exercises, ...activities]

  // Bound paging to the plan's lifetime: there is nothing to show before the
  // week the plan started. Without a plan-start date (legacy plans), there is
  // no floor — keep the unbounded page-by-8 behavior.
  const maxWeeks = maxWeeksAvailable(todayYMD, planStartedAt)
  const clampedWeeksShown = maxWeeks != null ? Math.min(weeksShown, maxWeeks) : weeksShown
  const canShowMore = maxWeeks == null || clampedWeeksShown < maxWeeks

  const rows = useMemo(
    () => weeklyMatrix(columns, checks, todayYMD, clampedWeeksShown, planStartedAt),
    // columns derives from plan; the memo key is the source data
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, checks, todayYMD, clampedWeeksShown, planStartedAt]
  )

  if (columns.length === 0) return null

  // Weeks fully before an item existed render an em-dash, not a red zero.
  // "Existed" dates from the EARLIEST evidence: a backfilled check proves the
  // item was being done before its row was created (plans imported later).
  const earliestCheck = new Map<string, string>()
  for (const c of checks) {
    const d = c.done_date.slice(0, 10)
    const prev = earliestCheck.get(c.item_id)
    if (prev === undefined || d < prev) earliestCheck.set(c.item_id, d)
  }
  const existedIn = (item: RecoveryPlanItem, weekEnd: string): boolean => {
    const created = item.created_at?.slice(0, 10) ?? null
    const first = earliestCheck.get(item.id) ?? null
    const since = first !== null && (created === null || first < created) ? first : created
    return since == null || since <= weekEnd
  }

  return (
    <div className="injury-adh-wrap">
      <table className="injury-adh-table injury-wk-table">
        <thead>
          <tr>
            <th className="injury-adh-th-date">Week</th>
            <th className="injury-adh-th-score">Adherence</th>
            {exercises.map((item) => (
              <th key={item.id} className="injury-adh-th-item" title={item.name}>
                <span className="injury-adh-th-label">{item.name}</span>
              </th>
            ))}
            {activities.map((item, i) => (
              <th
                key={item.id}
                className={`injury-adh-th-item injury-adh-th-activity${i === 0 ? ' injury-adh-th-divider' : ''}`}
                title={item.name}
              >
                <span className="injury-adh-th-label">{item.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const anyExisted = columns.some((item) => existedIn(item, row.weekEnd))
            return (
              <tr key={row.weekStart} className="injury-adh-row">
                <td className="injury-wk-label tabular-nums">{row.label}</td>
                <td className="injury-adh-score">
                  {row.overallPct != null && anyExisted ? (
                    <span
                      className={`injury-rate-chip injury-rate--${adherenceRating(row.overallPct, 100)} tabular-nums`}
                    >
                      {row.overallPct}%
                    </span>
                  ) : (
                    <span className="injury-adh-score-empty">—</span>
                  )}
                </td>
                {columns.map((item, idx) => {
                  const cell = row.perItem[idx]
                  const isActivity = item.kind === 'activity'
                  const divider = isActivity && item.id === activities[0]?.id
                  const tdCls = [
                    'injury-adh-cell',
                    isActivity ? 'injury-adh-cell-activity' : '',
                    divider ? 'injury-adh-cell-divider' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <td key={item.id} className={tdCls}>
                      {existedIn(item, row.weekEnd) && cell.accountable ? (
                        <RatingChip done={cell.done} item={item} />
                      ) : (
                        <span className="injury-adh-score-empty">—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      {canShowMore && (
        <button type="button" className="injury-showall" onClick={() => setWeeksShown((w) => w + 8)}>
          Show more
        </button>
      )}
    </div>
  )
}

// ── logs feed ─────────────────────────────────────────────────────────────────

/** Per-entry delete (x): hover-revealed, two-step inline confirm before commit. */
function LogRowDelete({ entryId }: { entryId: number }): ReactElement {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const mutation = useMutation({
    mutationFn: () => window.api.deleteInjuryLog(entryId),
    // Scoped per-entry (not a single shared string): mutations sharing a
    // scope run serially, one at a time. A shared 'injury-log-deletes' scope
    // meant deleting one entry silently queued behind any other still-in-
    // flight delete anywhere in the app — its onMutate would still fire
    // (so the row visibly vanished) but the actual IPC call, and thus the
    // eventual settle, waited for the earlier mutation, reading as "stuck"
    // until something else (e.g. leaving and reopening the card) forced a
    // fresh fetch that incidentally matched the now-completed server state.
    scope: { id: `injury-log-delete:${entryId}` },
    meta: { errorMessage: 'Couldn’t delete the injury note. It has been put back.' },
    onMutate: async () => {
      const prefix = ['injuries', 'log'] as const
      await queryClient.cancelQueries({ queryKey: prefix })
      const previous = queryClient.getQueriesData<InjuryLogEntry[]>({ queryKey: prefix }) as InjuryQuerySnapshot[]
      for (const [queryKey, rows] of previous as Array<[QueryKey, InjuryLogEntry[] | undefined]>) {
        queryClient.setQueryData(queryKey, (rows ?? []).filter((entry) => entry.id !== entryId))
      }
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      setConfirming(false)
      return { previous }
    },
    // No further action needed on success: the optimistic removal in
    // onMutate already reflects the end state, and a deleted id can't be
    // "restored" from a result the way add/update mutations reconcile a
    // temporary id with server data. onError is what undoes onMutate if the
    // delete didn't actually happen.
    onError: (_error, _variables, context) =>
      restoreInjurySnapshots(queryClient, context?.previous)
  })

  const handleClick = (): void => {
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 4000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    mutation.mutate()
  }

  return (
    <button
      type="button"
      className={`injury-log-remove${confirming ? ' injury-log-remove--confirm' : ''}`}
      disabled={mutation.isPending}
      title={confirming ? 'Click again to delete' : 'Delete entry'}
      aria-label={confirming ? 'Click again to delete this log entry' : 'Delete this log entry'}
      onClick={handleClick}
    >
      <X size={12} strokeWidth={2} />
    </button>
  )
}

function NotesFeed({ log }: { log: InjuryLogEntry[] }): ReactElement | null {
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const sorted = useMemo(
    () =>
      [...log].sort((a, b) => {
        const ak = a.noted_at ?? a.entry_date
        const bk = b.noted_at ?? b.entry_date
        return ak < bk ? 1 : ak > bk ? -1 : 0
      }),
    [log]
  )
  if (sorted.length === 0) return null
  const previewCount = 3
  const visible = showAll ? sorted : sorted.slice(0, previewCount)
  const hasOlder = sorted.length > previewCount

  return (
    <div className="injury-notes-feed">
      <ol id={listId} className="injury-notes">
        {visible.map((n) => (
          <li key={n.id} className="injury-note-row">
            <div className="injury-note-meta">
              <span className="injury-log-source">{sourceLabel(n.source)}</span>
              <span
                className={`injury-note-date tabular-nums${n.entry_end_date ? ' injury-note-date--span' : ''}`}
              >
                {formatLogPeriod(n)}
              </span>
              {n.pain_level != null && n.pain_level >= 1 && (
                <span className={`injury-log-pain tabular-nums ${painClass(n.pain_level)}`}>
                  {n.pain_level}/10
                </span>
              )}
              {n.context?.map((c) => (
                <span key={c} className="injury-tag">
                  {CONTEXT_LABEL[c as InjuryNoteContext] ?? c}
                </span>
              ))}
              <LogRowDelete entryId={n.id} />
            </div>
            {n.note && <p className="injury-log-note">{n.note}</p>}
          </li>
        ))}
      </ol>
      {hasOlder && (
        <button
          type="button"
          className="injury-notes-toggle"
          aria-expanded={showAll}
          aria-controls={listId}
          onClick={() => setShowAll((open) => !open)}
        >
          {showAll ? 'Show recent only' : `Show ${sorted.length - previewCount} older logs`}
        </button>
      )}
    </div>
  )
}

// ── injury header (name, badges, body area, since) ────────────────────────────

function InjuryHeader({
  injury,
  showSince = true
}: {
  injury: Injury
  showSince?: boolean
}): ReactElement {
  return (
    <div className="injury-card-header">
      <h3 className="injury-name">{injury.name}</h3>
      <div className="injury-badges">
        <BadgeDomain domain={STATUS_DOMAIN[injury.status]} label={STATUS_LABEL[injury.status]} />
        {injury.severity && (
          <span className={`badge injury-badge-severity ${severityClass(injury.severity)}`}>
            {injury.severity}
          </span>
        )}
        {injury.body_area && <span className="injury-body-area">{injury.body_area}</span>}
      </div>
      {showSince && <span className="injury-since">since {formatDate(injury.started_at)}</span>}
    </div>
  )
}

// ── reorder handle (drag + keyboard-accessible up/down fallback) ──────────────

/**
 * Card reordering affordance shared by the active injury list here and the
 * templates grid (GymTemplatesTab): a small grip that's an HTML5 drag source,
 * plus up/down buttons so reordering never depends on drag-and-drop actually
 * working (trackpad, screen reader, keyboard-only use). All three controls
 * stop click/drag propagation so they never trigger the card's own onOpen.
 */
function ReorderHandle({
  dragging,
  onDragStart,
  onDragEnd,
  onMoveUp,
  onMoveDown,
  disableUp,
  disableDown
}: {
  dragging: boolean
  onDragStart: (e: DragEvent<HTMLSpanElement>) => void
  onDragEnd: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  disableUp: boolean
  disableDown: boolean
}): ReactElement {
  return (
    <span className={`reorder-handle${dragging ? ' reorder-handle--dragging' : ''}`}>
      <span
        className="reorder-grip"
        draggable
        role="button"
        tabIndex={-1}
        aria-hidden="true"
        title="Drag to reorder"
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={14} strokeWidth={1.75} />
      </span>
      <button
        type="button"
        className="reorder-step"
        aria-label="Move up"
        disabled={disableUp}
        onClick={(e) => {
          e.stopPropagation()
          onMoveUp()
        }}
      >
        <ChevronUp size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="reorder-step"
        aria-label="Move down"
        disabled={disableDown}
        onClick={(e) => {
          e.stopPropagation()
          onMoveDown()
        }}
      >
        <ChevronDown size={13} strokeWidth={2} />
      </button>
    </span>
  )
}

// ── active injury card (glance + actions, navigates to full view) ─────────────

function ActiveInjuryCard({
  injury,
  todayYMD,
  onOpen,
  reorder
}: {
  injury: Injury
  todayYMD: string
  onOpen: () => void
  reorder: {
    dragging: boolean
    isFirst: boolean
    isLast: boolean
    onDragStart: (e: DragEvent<HTMLSpanElement>) => void
    onDragEnd: () => void
    onDragOver: (e: DragEvent<HTMLDivElement>) => void
    onDrop: (e: DragEvent<HTMLDivElement>) => void
    onMoveUp: () => void
    onMoveDown: () => void
  }
}): ReactElement {
  const { log, plan, checks } = useInjuryData(injury.id, true, todayYMD)
  const now = useMemo(() => new Date(`${todayYMD}T12:00:00Z`), [todayYMD])

  const stats = useMemo(() => flareStats(log, now), [log, now])
  const adherence = adherencePct(plan, checks, todayYMD, 7, injury.plan_started_at)

  const [flareOpen, setFlareOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)

  const flareCaption =
    stats.lastFlare == null
      ? 'No flares in the last 90 days'
      : `Last flare: ${stats.lastFlare.daysAgo} days ago · ${stats.lastFlare.pain}/10`

  return (
    <>
      <div
        className={`injury-card injury-card--active injury-card--clickable${reorder.dragging ? ' injury-card--dragging' : ''}`}
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
        onDragOver={reorder.onDragOver}
        onDrop={reorder.onDrop}
      >
        <ReorderHandle
          dragging={reorder.dragging}
          onDragStart={reorder.onDragStart}
          onDragEnd={reorder.onDragEnd}
          onMoveUp={reorder.onMoveUp}
          onMoveDown={reorder.onMoveDown}
          disableUp={reorder.isFirst}
          disableDown={reorder.isLast}
        />

        <InjuryHeader injury={injury} />

        <StatRow stats={stats} adherence={adherence} />

        <p className="injury-flare-caption">{flareCaption}</p>

        <ActionRow
          injury={injury}
          todayYMD={todayYMD}
          log={log}
          flareOpen={flareOpen}
          onToggleFlare={() => setFlareOpen((v) => !v)}
          onOpenPlan={() => setPlanOpen(true)}
        />

        {flareOpen && (
          <div onClick={(e) => e.stopPropagation()}>
            <FlareForm
              injuryId={injury.id}
              todayYMD={todayYMD}
              onDone={() => setFlareOpen(false)}
              onCancel={() => setFlareOpen(false)}
            />
          </div>
        )}
      </div>

      {planOpen && (
        <RecoveryPlanModal
          injury={injury}
          plan={plan}
          checks={checks}
          todayYMD={todayYMD}
          onClose={() => setPlanOpen(false)}
        />
      )}
    </>
  )
}

// ── full injury view (replaces the list) ──────────────────────────────────────

function InjuryFullView({
  injury,
  todayYMD,
  readOnly,
  onBack
}: {
  injury: Injury
  todayYMD: string
  readOnly: boolean
  onBack: () => void
}): ReactElement {
  const { log, plan, checks } = useInjuryData(injury.id, true, todayYMD)
  const now = useMemo(() => new Date(`${todayYMD}T12:00:00Z`), [todayYMD])
  const stats = useMemo(() => flareStats(log, now), [log, now])
  const adherence = adherencePct(plan, checks, todayYMD, 7, injury.plan_started_at)
  const series = usePainSeries(log, plan, checks, todayYMD, injury.plan_started_at)

  const [flareOpen, setFlareOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)

  // The list and this view share the same scroll container; entering an
  // injury must not inherit the list's scroll offset.
  useEffect(() => {
    document.querySelector('.content-area')?.scrollTo(0, 0)
  }, [injury.id])

  return (
    <div className="injury-full">
      <button type="button" className="injury-back" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.75} />
        Injuries
      </button>

      <InjuryHeader injury={injury} showSince={false} />

      <StartedAtControl injury={injury} todayYMD={todayYMD} readOnly={readOnly} />

      <div className="injury-plan-access-row">
        {plan.some((item) => item.active) && (
          <PlanStartControl injury={injury} todayYMD={todayYMD} readOnly={readOnly} />
        )}
        <button
          type="button"
          className="injury-btn injury-plan-access-button"
          onClick={() => setPlanOpen(true)}
        >
          View recovery plan
        </button>
      </div>

      {!readOnly && (
        <>
          <ActionRow
            injury={injury}
            todayYMD={todayYMD}
            log={log}
            flareOpen={flareOpen}
            onToggleFlare={() => setFlareOpen((v) => !v)}
            onOpenPlan={() => setPlanOpen(true)}
            showPlanAction={false}
          />
          {flareOpen && (
            <FlareForm
              injuryId={injury.id}
              todayYMD={todayYMD}
              onDone={() => setFlareOpen(false)}
              onCancel={() => setFlareOpen(false)}
            />
          )}
        </>
      )}
      <StatRow stats={stats} adherence={adherence} />

      {series.length > 0 && (
        <section className="injury-section">
          <SectionTitle eyebrow="Trend" title="Pain & adherence" />
          <PainChart data={series} tall />
        </section>
      )}

      {plan.some((i) => i.active && (i.kind === 'exercise' || i.kind === 'activity')) && (
        <>
          <section className="injury-section">
            <SectionTitle eyebrow="Current" title="This week" />
            <ThisWeekTable
              injuryId={injury.id}
              plan={plan}
              checks={checks}
              todayYMD={todayYMD}
              log={log}
              readOnly={readOnly}
              planStartedAt={injury.plan_started_at}
            />
          </section>

          <section className="injury-section">
            <SectionTitle eyebrow="History" title="Past weeks" />
            <PastWeeksTable
              plan={plan}
              checks={checks}
              todayYMD={todayYMD}
              planStartedAt={injury.plan_started_at}
            />
          </section>
        </>
      )}

      {log.length > 0 && (
        <section className="injury-section">
          <SectionTitle eyebrow="Record" title="Logs" />
          <NotesFeed log={log} />
        </section>
      )}

      {injury.summary && <p className="injury-summary injury-summary--footer">{injury.summary}</p>}

      <div className="injury-lifecycle-footer">
        <StatusControl injury={injury} />
        <InjuryDeleteControl injuryId={injury.id} onDeleted={onBack} />
      </div>

      {planOpen && (
        <RecoveryPlanModal
          injury={injury}
          plan={plan}
          checks={checks}
          todayYMD={todayYMD}
          onClose={() => setPlanOpen(false)}
        />
      )}
    </div>
  )
}

// ── history row (opens the same full view) ────────────────────────────────────

function HistoryRow({ injury, onOpen }: { injury: Injury; onOpen: () => void }): ReactElement {
  return (
    <tr className="injury-hist-row" onClick={onOpen}>
      <td>{injury.name}</td>
      <td>{injury.body_area ?? '—'}</td>
      <td className="injury-hist-cap">{injury.severity ?? '—'}</td>
      <td className="tabular-nums">{humanizeDuration(injury.started_at, injury.resolved_at)}</td>
      <td className="tabular-nums">{formatDate(injury.resolved_at)}</td>
    </tr>
  )
}

// ── view ───────────────────────────────────────────────────────────────────────

export function InjuriesView(): ReactElement {
  const [tab, setTab] = useState<TabKey>('active')
  const [selectedInjuryId, setSelectedInjuryId] = useState<string | null>(null)

  const injuriesQuery = useQuery({
    queryKey: ['injuries', 'list'],
    queryFn: () => window.api.getInjuries(),
    staleTime: 60_000
  })
  const configQuery = useQuery({
    queryKey: ['userConfig'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })

  const timezone = configQuery.data?.timezone ?? null
  const todayYMD = useMemo(() => ymdKey(toZonedYMD(new Date().toISOString(), timezone)), [timezone])

  const injuries = injuriesQuery.data ?? []
  const active = injuries.filter((i) => i.status === 'active' || i.status === 'recovering')
  const history = injuries.filter((i) => i.status === 'resolved')

  // Card order is frontend-only (no backend write) and scoped to the active
  // section only — history stays in its natural (resolved-date) order.
  const activeIds = useMemo(() => active.map((i) => i.id), [active])
  const cardOrder = useCardOrder('injuries:active:order', activeIds)
  const activeById = useMemo(() => new Map(active.map((i) => [i.id, i])), [active])
  const orderedActive = cardOrder.orderedIds
    .map((id) => activeById.get(id))
    .filter((i): i is Injury => i != null)

  const [draggedId, setDraggedId] = useState<string | null>(null)

  const selected = selectedInjuryId ? injuries.find((i) => i.id === selectedInjuryId) ?? null : null

  // Full view replaces the entire list surface.
  if (selected) {
    return (
      <div className="view">
        <InjuryFullView
          injury={selected}
          todayYMD={todayYMD}
          readOnly={selected.status === 'resolved'}
          onBack={() => setSelectedInjuryId(null)}
        />
      </div>
    )
  }

  return (
    <div className="view">
      <TabHeader eyebrow="Compiled by the analysis agent" title="Injuries" />
      <p className="injury-intro">
        Track flares and recovery here. The analysis chat maintains the summaries and plans; your
        quick-logs feed the same record.
      </p>

      <div className="injury-switcher" role="tablist" aria-label="Injury view">
        <button
          role="tab"
          aria-selected={tab === 'active'}
          className={tab === 'active' ? 'chip chip--active' : 'chip'}
          onClick={() => setTab('active')}
        >
          Active
        </button>
        <button
          role="tab"
          aria-selected={tab === 'history'}
          className={tab === 'history' ? 'chip chip--active' : 'chip'}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>

      {injuriesQuery.isLoading ? (
        <p className="injury-log-empty">Loading…</p>
      ) : tab === 'active' ? (
        active.length === 0 ? (
          <EmptyState message="No active injuries. Tell the analysis chat about a flare-up or setback and it will start tracking it here." />
        ) : (
          <div className="injury-list">
            {orderedActive.map((injury) => (
              <ActiveInjuryCard
                key={injury.id}
                injury={injury}
                todayYMD={todayYMD}
                onOpen={() => setSelectedInjuryId(injury.id)}
                reorder={{
                  dragging: draggedId === injury.id,
                  isFirst: cardOrder.isFirst(injury.id),
                  isLast: cardOrder.isLast(injury.id),
                  onDragStart: (e) => {
                    setDraggedId(injury.id)
                    e.dataTransfer.effectAllowed = 'move'
                  },
                  onDragEnd: () => setDraggedId(null),
                  onDragOver: (e) => {
                    if (draggedId == null || draggedId === injury.id) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  },
                  onDrop: (e) => {
                    e.preventDefault()
                    if (draggedId == null || draggedId === injury.id) return
                    cardOrder.moveBefore(draggedId, injury.id)
                    setDraggedId(null)
                  },
                  onMoveUp: () => cardOrder.moveUp(injury.id),
                  onMoveDown: () => cardOrder.moveDown(injury.id)
                }}
              />
            ))}
          </div>
        )
      ) : history.length === 0 ? (
        <EmptyState message="No resolved injuries yet." />
      ) : (
        <div className="injury-hist-wrap">
          <table className="injury-hist-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Body area</th>
                <th>Severity</th>
                <th>Duration</th>
                <th>Resolved</th>
              </tr>
            </thead>
            <tbody>
              {history.map((injury) => (
                <HistoryRow
                  key={injury.id}
                  injury={injury}
                  onOpen={() => setSelectedInjuryId(injury.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
