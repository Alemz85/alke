import { useMemo, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Check, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react'
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
  buildTimeline,
  flareStats,
  humanizeDuration,
  shiftYMD,
  weeklyAdherence,
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

type TabKey = 'active' | 'history'

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function sourceLabel(source: string | null): string {
  if (source === 'user') return 'You'
  if (source === 'chat') return 'AI'
  return source ?? ''
}

// ── shared queries (one hook set per injury) ─────────────────────────────────

function useInjuryData(injuryId: string, enabled: boolean, todayYMD: string): {
  log: InjuryLogEntry[]
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  loading: boolean
} {
  const fromDate = shiftYMD(todayYMD, -90)
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

interface PainPoint {
  date: string
  pain: number | null
  adherence: number | null
}

/** Build the chart series: pain points (last 90d) + weekly-adherence underlay. */
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
    const adherenceByWeekStart = new Map(weekly.map((w) => [w.weekStart, w.pct]))

    const points: PainPoint[] = []
    // Pain points from flare/log entries in window (pain_level != null).
    for (const e of log) {
      const d = e.entry_date.slice(0, 10)
      if (d < start || d > todayYMD) continue
      if (e.pain_level == null) continue
      points.push({ date: d, pain: e.pain_level, adherence: null })
    }
    // Adherence underlay: one point per week start carrying its pct.
    for (const [weekStart, pct] of adherenceByWeekStart) {
      if (weekStart < start) continue
      points.push({ date: weekStart, pain: null, adherence: pct })
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

  const toggleContext = (c: InjuryNoteContext): void =>
    setContexts((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

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
            onClick={() => toggleContext(c)}
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

// ── quick-log strip ────────────────────────────────────────────────────────────

function QuickLog({
  injury,
  plan,
  checks,
  todayYMD
}: {
  injury: Injury
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  todayYMD: string
}): ReactElement {
  const queryClient = useQueryClient()
  const [flareOpen, setFlareOpen] = useState(false)
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

  const checkMutation = useMutation({
    mutationFn: ({ itemId, done }: { itemId: string; done: boolean }) =>
      window.api.setPlanItemCheck(itemId, todayYMD, done),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['injuries'] })
  })

  const checkableItems = plan.filter((i) => i.active && (i.kind === 'exercise' || i.kind === 'habit'))
  const checkedTodayIds = new Set(
    checks.filter((c) => c.done_date.slice(0, 10) === todayYMD).map((c) => c.item_id)
  )

  return (
    <div className="injury-quicklog">
      <div className="injury-quicklog-row">
        <button
          type="button"
          className="injury-btn"
          disabled={fineMutation.isPending}
          onClick={() => fineMutation.mutate()}
        >
          {justLogged ? '✓ Logged' : 'Feeling fine'}
        </button>
        <button
          type="button"
          className="injury-btn"
          aria-expanded={flareOpen}
          onClick={() => setFlareOpen((v) => !v)}
        >
          Log flare-up
        </button>
      </div>

      {flareOpen && (
        <FlareForm
          injuryId={injury.id}
          todayYMD={todayYMD}
          onDone={() => setFlareOpen(false)}
          onCancel={() => setFlareOpen(false)}
        />
      )}

      {checkableItems.length > 0 && (
        <div className="injury-checkchips">
          {checkableItems.map((item) => {
            const checked = checkedTodayIds.has(item.id)
            return (
              <button
                key={item.id}
                type="button"
                className={`chip injury-check-chip${checked ? ' chip--active' : ''}`}
                aria-pressed={checked}
                disabled={checkMutation.isPending}
                onClick={() => checkMutation.mutate({ itemId: item.id, done: !checked })}
              >
                {checked && <Check size={13} strokeWidth={2.5} />}
                {item.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── expanded detail ────────────────────────────────────────────────────────────

function InjuryDetail({
  injury,
  log,
  plan,
  checks,
  series,
  todayYMD
}: {
  injury: Injury
  log: InjuryLogEntry[]
  plan: RecoveryPlanItem[]
  checks: PlanItemCheck[]
  series: PainPoint[]
  todayYMD: string
}): ReactElement {
  const [showAll, setShowAll] = useState(false)
  const activeItems = plan.filter((i) => i.active)

  const timeline = useMemo(() => buildTimeline(log, checks, plan), [log, checks, plan])
  const cutoff = shiftYMD(todayYMD, -60)
  const visibleTimeline = showAll ? timeline : timeline.filter((d) => d.date >= cutoff)
  const hasMore = timeline.length > visibleTimeline.length

  return (
    <div className="injury-detail">
      {series.length > 0 && (
        <section className="injury-section">
          <h4 className="injury-section-title">Pain &amp; adherence</h4>
          <PainChart data={series} tall />
        </section>
      )}

      {activeItems.length > 0 && (
        <section className="injury-section">
          <h4 className="injury-section-title">Recovery plan</h4>
          <ul className="injury-plan-list">
            {activeItems.map((item) => {
              const progress = weeklyProgress(item, checks, todayYMD)
              return (
                <li key={item.id} className="injury-plan-item">
                  <div className="injury-plan-item-head">
                    <span className="injury-plan-name">{item.name}</span>
                    <span className="injury-plan-kind">{item.kind}</span>
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
      )}

      {injury.recovery_plan && (
        <section className="injury-section">
          <h5 className="injury-subheading">Approach</h5>
          <div className="injury-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{injury.recovery_plan}</Markdown>
          </div>
        </section>
      )}

      {timeline.length > 0 && (
        <section className="injury-section">
          <h4 className="injury-section-title">Timeline</h4>
          <ol className="injury-timeline">
            {visibleTimeline.map((day) => (
              <li key={day.date} className="injury-timeline-day">
                <div className="injury-timeline-date tabular-nums">{formatDate(day.date)}</div>
                <div className="injury-timeline-events">
                  {day.notes.map((n) => (
                    <div key={n.id} className="injury-timeline-note">
                      <div className="injury-timeline-note-meta">
                        <span className="injury-log-source">{sourceLabel(n.source)}</span>
                        {n.pain_level != null && (
                          <span className="injury-log-pain tabular-nums">{n.pain_level}/10</span>
                        )}
                        {n.context?.map((c) => (
                          <span key={c} className="injury-tag">
                            {CONTEXT_LABEL[c as InjuryNoteContext] ?? c}
                          </span>
                        ))}
                      </div>
                      <p className="injury-log-note">{n.note}</p>
                    </div>
                  ))}
                  {day.checks.map((c, i) => (
                    <div key={`${day.date}-chk-${i}`} className="injury-timeline-check">
                      <Check size={13} strokeWidth={2.5} /> {c.itemName}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          {hasMore && (
            <button type="button" className="injury-showall" onClick={() => setShowAll(true)}>
              Show all
            </button>
          )}
        </section>
      )}

      {injury.summary && <p className="injury-summary injury-summary--footer">{injury.summary}</p>}
    </div>
  )
}

// ── active injury card ─────────────────────────────────────────────────────────

function ActiveInjuryCard({ injury, todayYMD }: { injury: Injury; todayYMD: string }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { log, plan, checks, loading } = useInjuryData(injury.id, true, todayYMD)
  const now = useMemo(() => new Date(`${todayYMD}T12:00:00Z`), [todayYMD])

  const stats = useMemo(() => flareStats(log, now), [log, now])
  const adherence = adherencePct(plan, checks, todayYMD, 7)
  const series = usePainSeries(log, plan, checks, todayYMD)

  const flareCaption =
    stats.lastFlare == null
      ? 'No flares in the last 90 days'
      : `Last flare: ${stats.lastFlare.daysAgo} days ago · ${stats.lastFlare.pain}/10`

  return (
    <div className="injury-card injury-card--active">
      <div className="injury-card-header">
        <h3 className="injury-name">{injury.name}</h3>
        <div className="injury-badges">
          <span className="badge injury-badge-status">{STATUS_LABEL[injury.status]}</span>
          {injury.severity && <span className="badge injury-badge-severity">{injury.severity}</span>}
          {injury.body_area && <span className="injury-body-area">{injury.body_area}</span>}
        </div>
        <span className="injury-since">since {formatDate(injury.started_at)}</span>
      </div>

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

      {series.length > 0 ? (
        <div className="injury-sparkline">
          <PainChart data={series} tall={false} />
        </div>
      ) : (
        !loading && <p className="injury-log-empty injury-sparkline-empty">No pain data yet.</p>
      )}
      <p className="injury-flare-caption">{flareCaption}</p>

      <QuickLog injury={injury} plan={plan} checks={checks} todayYMD={todayYMD} />

      <button
        type="button"
        className="injury-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          size={16}
          strokeWidth={1.5}
          className={`injury-expand-chevron${expanded ? ' injury-expand-chevron--open' : ''}`}
        />
        Details
      </button>

      {expanded && (
        <InjuryDetail
          injury={injury}
          log={log}
          plan={plan}
          checks={checks}
          series={series}
          todayYMD={todayYMD}
        />
      )}
    </div>
  )
}

// ── history row (lazy detail) ──────────────────────────────────────────────────

function HistoryRow({ injury, todayYMD }: { injury: Injury; todayYMD: string }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { log, plan, checks } = useInjuryData(injury.id, expanded, todayYMD)
  const series = usePainSeries(log, plan, checks, todayYMD)

  return (
    <>
      <tr className="injury-hist-row" onClick={() => setExpanded((v) => !v)}>
        <td>
          <ChevronRight
            size={14}
            strokeWidth={1.5}
            className={`injury-card-chevron${expanded ? ' injury-card-chevron--open' : ''}`}
          />
          {injury.name}
        </td>
        <td>{injury.body_area ?? '—'}</td>
        <td className="injury-hist-cap">{injury.severity ?? '—'}</td>
        <td className="tabular-nums">{humanizeDuration(injury.started_at, injury.resolved_at)}</td>
        <td className="tabular-nums">{formatDate(injury.resolved_at)}</td>
      </tr>
      {expanded && (
        <tr className="injury-hist-detail-row">
          <td colSpan={5}>
            <InjuryDetail
              injury={injury}
              log={log}
              plan={plan}
              checks={checks}
              series={series}
              todayYMD={todayYMD}
            />
          </td>
        </tr>
      )}
    </>
  )
}

// ── view ───────────────────────────────────────────────────────────────────────

export function InjuriesView(): ReactElement {
  const [tab, setTab] = useState<TabKey>('active')

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
              <ActiveInjuryCard key={injury.id} injury={injury} todayYMD={todayYMD} />
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
                <HistoryRow key={injury.id} injury={injury} todayYMD={todayYMD} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
