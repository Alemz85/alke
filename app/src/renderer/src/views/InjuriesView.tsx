import { useEffect, useMemo, useState, type MouseEvent, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight, ArrowDownRight, Check, Minus, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
  type InjuryLogEntry,
  type InjuryNoteContext,
  type PlanItemCheck,
  type RecoveryPlanItem
} from '@shared/types'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'
import { toZonedYMD, ymdKey } from '../hooks/sessionsDate'
import {
  adherencePct,
  adherenceRating,
  doseTarget,
  itemAdherenceRating,
  dailyPainSeries,
  dayScore,
  flareStats,
  humanizeDuration,
  isoWeekStart,
  shiftYMD,
  weeklyAdherence,
  weeklyMatrix,
  weeklyProgress,
  type FlareStats
} from '../lib/injuryStats'
import './InjuriesView.css'

const STATUS_LABEL: Record<Injury['status'], string> = {
  active: 'Active',
  recovering: 'Recovering',
  resolved: 'Resolved'
}

const CONTEXT_LABEL: Record<InjuryNoteContext, string> = {
  during_workout: 'During workout',
  post_workout: 'Post-workout',
  at_rest: 'At rest',
  on_waking: 'On waking'
}

// Plan-item kind → modal group label. Order below drives section order.
const KIND_GROUPS: Array<{ kind: RecoveryPlanItem['kind']; label: string }> = [
  { kind: 'exercise', label: 'Rehab work' },
  { kind: 'activity', label: 'Allowed activity' },
  { kind: 'habit', label: 'Habits' },
  { kind: 'constraint', label: 'Constraints' }
]

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

function TrendPill({ trend }: { trend: FlareStats['trend'] }): ReactElement {
  if (trend == null) return <span className="injury-stat-value">—</span>
  const Icon = trend === 'improving' ? ArrowDownRight : trend === 'worsening' ? ArrowUpRight : Minus
  return (
    <span className="injury-stat-value injury-trend">
      <Icon size={14} strokeWidth={2} />
      {trend}
    </span>
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
        {stats.avgIntensity30d == null ? '—' : `${stats.avgIntensity30d.toFixed(1)}/10`}
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
  todayYMD: string
): PainPoint[] {
  return useMemo(() => {
    const start = shiftYMD(todayYMD, -90)
    // 13 ISO weeks ≈ 90 days of underlay bars.
    const weekly = weeklyAdherence(plan, checks, todayYMD, 13)

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
  }, [log, plan, checks, todayYMD])
}

const CHART_TERTIARY = 'var(--color-text-tertiary)'
const CHART_GRID = 'var(--color-divider-soft)'
const CHART_LINE = 'var(--color-text-secondary)'
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['injuries'] })
      onDone()
    }
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
          onClick={() => mutation.mutate()}
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
  flareOpen,
  onToggleFlare,
  onOpenPlan
}: {
  injury: Injury
  flareOpen: boolean
  onToggleFlare: () => void
  onOpenPlan: () => void
}): ReactElement {
  const queryClient = useQueryClient()
  const [justLogged, setJustLogged] = useState(false)

  const fineMutation = useMutation({
    mutationFn: () =>
      window.api.addInjuryLog({ injury_id: injury.id, note: 'Feeling fine', pain_level: 0, context: [] }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['injuries'] })
      setJustLogged(true)
      window.setTimeout(() => setJustLogged(false), 2000)
    }
  })

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
        disabled={fineMutation.isPending}
        onClick={stop(() => fineMutation.mutate())}
      >
        {justLogged ? '✓ Logged' : 'Feeling fine'}
      </button>
      <button
        type="button"
        className={`injury-btn injury-action-btn${flareOpen ? ' injury-action-btn--active' : ''}`}
        aria-expanded={flareOpen}
        onClick={stop(onToggleFlare)}
      >
        Log flare-up
      </button>
      <button type="button" className="injury-btn injury-action-btn" onClick={stop(onOpenPlan)}>
        Recovery plan
      </button>
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

  const activeItems = plan.filter((i) => i.active)

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
          <h3 className="injury-modal-title">Recovery plan</h3>
          <button type="button" className="injury-modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className="injury-modal-body">
          {injury.recovery_plan && (
            <div className="injury-markdown injury-modal-approach">
              <Markdown remarkPlugins={[remarkGfm]}>{injury.recovery_plan}</Markdown>
            </div>
          )}

          {activeItems.length === 0 ? (
            <p className="injury-log-empty">No plan items yet.</p>
          ) : (
            KIND_GROUPS.map(({ kind, label }) => {
              const items = activeItems.filter((i) => i.kind === kind)
              if (items.length === 0) return null
              return (
                <section key={kind} className="injury-modal-group">
                  <h4 className="injury-modal-group-title">{label}</h4>
                  <ul className="injury-plan-list">
                    {items.map((item) => {
                      const progress = weeklyProgress(item, checks, todayYMD)
                      return (
                        <li key={item.id} className="injury-plan-item">
                          <div className="injury-plan-item-head">
                            <span className="injury-plan-name">{item.name}</span>
                            {progress && (
                              <span className="injury-plan-progress tabular-nums">
                                {progress.done}/{progress.target} this wk
                              </span>
                            )}
                          </div>
                          {item.note && <p className="injury-plan-note">{item.note}</p>}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })
          )}
        </div>
      </div>
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
  plan,
  checks,
  todayYMD,
  log,
  readOnly
}: {
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  todayYMD: string
  log: InjuryLogEntry[]
  readOnly: boolean
}): ReactElement | null {
  const queryClient = useQueryClient()

  const checkMutation = useMutation({
    mutationFn: ({ itemId, dateYMD, done }: { itemId: string; dateYMD: string; done: boolean }) =>
      window.api.setPlanItemCheck(itemId, dateYMD, done),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['injuries'] })
  })

  const { exercises, activities } = checkableColumns(plan)
  const columns = [...exercises, ...activities]

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

  // "Done for the week": a targeted item whose weekly count met its target —
  // its whole column mutes for the rest of the week (still clickable).
  const progressFor = (item: RecoveryPlanItem): { done: number; target: number } | null =>
    weeklyProgress(item, checks, todayYMD)
  const isMet = (item: RecoveryPlanItem): boolean => {
    const p = progressFor(item)
    const dose = doseTarget(item)
    return p != null && dose != null && p.done >= dose
  }

  const toggle = (itemId: string, dateYMD: string, done: boolean): void => {
    if (readOnly) return
    checkMutation.mutate({ itemId, dateYMD, done })
  }

  const renderHeader = (item: RecoveryPlanItem, isActivity: boolean, i: number): ReactElement => {
    const p = progressFor(item)
    const met = isMet(item)
    const cls = [
      'injury-adh-th-item',
      isActivity ? 'injury-adh-th-activity' : '',
      isActivity && i === 0 ? 'injury-adh-th-divider' : '',
      met ? 'injury-adh-th--met' : ''
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <th key={item.id} className={cls} title={item.name}>
        <span className="injury-adh-th-label">{item.name}</span>
        {p && (
          <span className="injury-adh-th-progress tabular-nums">
            {' · '}
            {p.done}/{p.target}
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
    const tdCls = [
      'injury-adh-cell',
      isActivity ? 'injury-adh-cell-activity' : '',
      isActivity && i === 0 ? 'injury-adh-cell-divider' : '',
      met ? 'injury-adh-cell--met' : ''
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
            const score = dayScore(plan, checks, ymd)
            const pain = painByDay.get(ymd)
            const intensity = score.total > 0 ? score.done / score.total : 0
            return (
              <tr key={ymd} className="injury-adh-row">
                <td className="injury-adh-date tabular-nums">
                  <span>{formatDateShort(ymd)}</span>
                  {pain != null && pain >= 1 && (
                    <span className="injury-adh-pain tabular-nums">{pain}/10</span>
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
  todayYMD
}: {
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  todayYMD: string
}): ReactElement | null {
  const [weeksShown, setWeeksShown] = useState(8)

  const { exercises, activities } = checkableColumns(plan)
  const columns = [...exercises, ...activities]

  const rows = useMemo(
    () => weeklyMatrix(columns, checks, todayYMD, weeksShown),
    // columns derives from plan; the memo key is the source data
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, checks, todayYMD, weeksShown]
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
                      {existedIn(item, row.weekEnd) ? (
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
      <button type="button" className="injury-showall" onClick={() => setWeeksShown((w) => w + 8)}>
        Show more
      </button>
    </div>
  )
}

// ── notes feed ────────────────────────────────────────────────────────────────

function NotesFeed({ log }: { log: InjuryLogEntry[] }): ReactElement | null {
  const [showAll, setShowAll] = useState(false)
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
  const visible = showAll ? sorted : sorted.slice(0, 30)
  const hasMore = sorted.length > visible.length

  return (
    <ol className="injury-notes">
      {visible.map((n) => (
        <li key={n.id} className="injury-note-row">
          <div className="injury-note-meta">
            <span className="injury-log-source">{sourceLabel(n.source)}</span>
            <span className="injury-note-date tabular-nums">{formatDateShort(n.entry_date)}</span>
            {n.pain_level != null && n.pain_level >= 1 && (
              <span className="injury-log-pain tabular-nums">{n.pain_level}/10</span>
            )}
            {n.context?.map((c) => (
              <span key={c} className="injury-tag">
                {CONTEXT_LABEL[c as InjuryNoteContext] ?? c}
              </span>
            ))}
          </div>
          {n.note && <p className="injury-log-note">{n.note}</p>}
        </li>
      ))}
      {hasMore && (
        <button type="button" className="injury-showall" onClick={() => setShowAll(true)}>
          Show all
        </button>
      )}
    </ol>
  )
}

// ── injury header (name, badges, body area, since) ────────────────────────────

function InjuryHeader({ injury }: { injury: Injury }): ReactElement {
  return (
    <div className="injury-card-header">
      <h3 className="injury-name">{injury.name}</h3>
      <div className="injury-badges">
        <span className="badge injury-badge-status">{STATUS_LABEL[injury.status]}</span>
        {injury.severity && <span className="badge injury-badge-severity">{injury.severity}</span>}
        {injury.body_area && <span className="injury-body-area">{injury.body_area}</span>}
      </div>
      <span className="injury-since">since {formatDate(injury.started_at)}</span>
    </div>
  )
}

// ── active injury card (glance + actions, navigates to full view) ─────────────

function ActiveInjuryCard({
  injury,
  todayYMD,
  onOpen
}: {
  injury: Injury
  todayYMD: string
  onOpen: () => void
}): ReactElement {
  const { log, plan, checks, loading } = useInjuryData(injury.id, true, todayYMD)
  const now = useMemo(() => new Date(`${todayYMD}T12:00:00Z`), [todayYMD])

  const stats = useMemo(() => flareStats(log, now), [log, now])
  const adherence = adherencePct(plan, checks, todayYMD, 7)
  const series = usePainSeries(log, plan, checks, todayYMD)

  const [flareOpen, setFlareOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)

  const flareCaption =
    stats.lastFlare == null
      ? 'No flares in the last 90 days'
      : `Last flare: ${stats.lastFlare.daysAgo} days ago · ${stats.lastFlare.pain}/10`

  return (
    <>
      <div
        className="injury-card injury-card--active injury-card--clickable"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
      >
        <InjuryHeader injury={injury} />

        <StatRow stats={stats} adherence={adherence} />

        {series.length > 0 ? (
          <div className="injury-sparkline">
            <PainChart data={series} tall={false} />
          </div>
        ) : (
          !loading && <p className="injury-log-empty injury-sparkline-empty">No pain data yet.</p>
        )}
        <p className="injury-flare-caption">{flareCaption}</p>

        <ActionRow
          injury={injury}
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
  const adherence = adherencePct(plan, checks, todayYMD, 7)
  const series = usePainSeries(log, plan, checks, todayYMD)

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

      <InjuryHeader injury={injury} />

      {!readOnly && (
        <>
          <ActionRow
            injury={injury}
            flareOpen={flareOpen}
            onToggleFlare={() => setFlareOpen((v) => !v)}
            onOpenPlan={() => setPlanOpen(true)}
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
      {readOnly && (
        <div className="injury-actions">
          <button type="button" className="injury-btn injury-action-btn" onClick={() => setPlanOpen(true)}>
            Recovery plan
          </button>
        </div>
      )}

      <StatRow stats={stats} adherence={adherence} />

      {series.length > 0 && (
        <section className="injury-section">
          <h4 className="injury-section-title">Pain &amp; adherence</h4>
          <PainChart data={series} tall />
        </section>
      )}

      {plan.some((i) => i.active && (i.kind === 'exercise' || i.kind === 'activity')) && (
        <>
          <section className="injury-section">
            <h4 className="injury-section-title">This week</h4>
            <ThisWeekTable
              plan={plan}
              checks={checks}
              todayYMD={todayYMD}
              log={log}
              readOnly={readOnly}
            />
          </section>

          <section className="injury-section">
            <h4 className="injury-section-title">Past weeks</h4>
            <PastWeeksTable plan={plan} checks={checks} todayYMD={todayYMD} />
          </section>
        </>
      )}

      {log.length > 0 && (
        <section className="injury-section">
          <h4 className="injury-section-title">Notes</h4>
          <NotesFeed log={log} />
        </section>
      )}

      {injury.summary && <p className="injury-summary injury-summary--footer">{injury.summary}</p>}

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
            {active.map((injury) => (
              <ActiveInjuryCard
                key={injury.id}
                injury={injury}
                todayYMD={todayYMD}
                onOpen={() => setSelectedInjuryId(injury.id)}
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
