import { useMemo, useState, type ReactElement } from 'react'
import { ArrowRight } from 'lucide-react'
import type { DailyMetric, GymTemplate, Workout } from '@shared/types'
import { TabHeader } from './TabHeader'
import {
  EmptyState,
  HeroMetric,
  MetricDetailModal,
  Sparkline,
  type MetricDetailConfig,
  type MetricDetailPoint,
  type SparklinePoint
} from '../components'
import { ActiveEnergyPill } from '../components/ActiveEnergyPill'
import { BodyWeightPill } from '../components/BodyWeightPill'
import { ProteinPill } from '../components/ProteinPill'
import { CalendarHeatmap } from '../components/CalendarHeatmap'
import { DayDetailDrawer } from '../components/DayDetailDrawer'
import { SummaryCard } from '../components/SummaryCard'
import { GoalStrip } from '../components/GoalStrip'
import { ModalityIcon } from '../components/ModalityIcon'
import { ActivityBadge } from '../components/ActivityBadge'
import { activityEnvironmentAccent, modalityLabel } from '../components/modalityAccent'
import type { StatTableRow } from '../components'
import {
  useDailyMetrics,
  useRecentWorkouts,
  useUserConfig,
  useWorkoutsInRange
} from '../hooks/useDashboardData'
import { useAllWorkouts } from '../hooks/useSessionsData'
import { GYM_HISTORY_START_ISO, useGymSessions, useGymTemplates } from '../hooks/useGymData'
import { useCardOrder } from '../hooks/useCardOrder'
import { TemplateViewModal } from './gym/TemplateViewModal'
import {
  estimateTemplateDurationSeconds,
  formatEstimatedDuration
} from './gym/gymFormat'
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { useMonthCalendar } from '../hooks/useMonthCalendar'
import { localDateKey, todayYMD, ymdKey } from '../hooks/sessionsDate'
import { formatDurationHM, formatPerMonth, formatTrendPct } from '../lib/format'
import { monthSummary, yearSummary, type SummaryItem } from '../lib/periodSummary'
import {
  computeActiveEnergySummary,
  computeBodyWeightSummary,
  countSessionsForGoal,
  fmtDistance,
  fmtDuration,
  fmtShortDate,
  humanizeWorkoutType,
  isoWeekWindowFor,
  parseWeeklyMinSessions
} from './dashboardUtils'
import './DashboardView.css'

const EM_DASH = '—'

export interface DashboardViewProps {
  /** Navigate to the full Sessions view (calendar box header + recent-sessions box). */
  onOpenSessions: () => void
  /** Navigate to the Profile tab (Goals strip card click-through). */
  onOpenProfile: () => void
  /** Navigate to the Gym tab's Templates sub-tab ("All templates" link). */
  onOpenGymTemplates: () => void
}

/** The remaining clickable dashboard metric (RHR) — load metrics moved to Recovery › Load. */
type DashboardMetricKey = 'rhr'

const METRIC_EXPLANATIONS: Record<DashboardMetricKey, string> = {
  rhr: 'Resting heart rate is your lowest heart rate at rest, usually measured on waking. A lower or stable RHR generally tracks good recovery; a noticeable jump above your usual baseline can signal accumulated fatigue, poor sleep, or the early signs of illness. This is informational self-tracking, not a medical diagnosis.'
}

/** Builds a MetricDetailPoint[] from daily-metric rows, formatting the x-axis label from the "YYYY-MM-DD" date. */
function toDetailSeries<T>(
  rows: T[],
  pick: (row: T) => { date: string; value: number | null }
): MetricDetailPoint[] {
  return rows.map((row) => {
    const { date, value } = pick(row)
    return { date, label: fmtShortDate(date), value }
  })
}

/** Days since the epoch for a "YYYY-MM-DD" key — the sparklines' time axis. */
function dayIndex(ymd: string): number {
  return Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000)
}

/**
 * Builds sparkline points from daily-metric rows, dropping days the metric
 * never synced and positioning each reading on a real day axis rather than by
 * index — a sparse metric (weigh-ins land weeks apart) must not be drawn as an
 * evenly-spaced series.
 */
function trendPoints(
  rowsAsc: DailyMetric[],
  pick: (row: DailyMetric) => number | null,
  windowDays: number,
  todayKey: string
): SparklinePoint[] {
  const cutoff = dayIndex(todayKey) - windowDays
  const out: SparklinePoint[] = []
  for (const row of rowsAsc) {
    const value = pick(row)
    if (value === null) continue
    const x = dayIndex(row.date)
    if (x < cutoff) continue
    out.push({ x, y: value })
  }
  return out
}

interface StatSquareProps {
  label: string
  /** Full name spelled out under the acronym, e.g. "Resting HR". */
  name: string
  value: string
  sub?: string
  domain: 'load' | 'recovery'
  /** Recent history drawn under the value. Optional — the tile stands without it. */
  trend?: SparklinePoint[]
  onClick: () => void
}

/** A small clickable stat tile (RHR) that opens its metric popup. */
function StatSquare({
  label,
  name,
  value,
  sub,
  domain,
  trend = [],
  onClick
}: StatSquareProps): ReactElement {
  return (
    <button
      type="button"
      className={`stat-square stat-square--${domain}`}
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={`${label} (${name}) — open details`}
    >
      <span className="stat-square-head">
        <span className="stat-square-label">{label}</span>
        <span className="stat-square-name">{name}</span>
      </span>
      <span className="stat-square-figure">
        <span className="stat-square-value tabular-nums">{value}</span>
        <Sparkline points={trend} domain={domain} ariaLabel={`${name} over the last month`} />
        {sub && <span className="stat-square-sub">{sub}</span>}
      </span>
    </button>
  )
}

export function DashboardView({
  onOpenSessions,
  onOpenProfile,
  onOpenGymTemplates
}: DashboardViewProps): ReactElement {
  const userConfigQuery = useUserConfig()
  const timezone = userConfigQuery.data?.timezone ?? undefined
  // A year of daily metrics feeds the RHR detail popup and the body-weight
  // pill's ~30-day-ago comparison; the pill/RHR calcs filter by date so the
  // wide pull is safe.
  const dailyMetricsQuery = useDailyMetrics(365, timezone)
  const recentWorkoutsQuery = useRecentWorkouts(timezone)

  // Active gym templates for the quick-access strip. Lifetime session history
  // backs the "done N×" counts — same query key the Gym tab uses, so the two
  // tabs share one cache entry.
  const nowIso = useMemo(() => new Date().toISOString(), [])
  const gymTemplatesQuery = useGymTemplates()
  const gymHistoryQuery = useGymSessions(GYM_HISTORY_START_ISO, nowIso)
  const [templateView, setTemplateView] = useState<GymTemplate | null>(null)

  const weeklyMinSessions = parseWeeklyMinSessions(userConfigQuery.data)

  // The ISO week window anchored to "today" in the USER's configured timezone.
  const todayYmd = todayYMD(timezone)
  const weekWindow = isoWeekWindowFor(todayYmd, timezone)
  const workoutsThisWeekQuery = useWorkoutsInRange(weekWindow.startIso, weekWindow.endIso)

  // --- Month calendar + period summaries ---
  const {
    today,
    viewYear,
    viewMonth,
    handlePrevMonth,
    handleNextMonth,
    selectedDayKey,
    openDay,
    closeDay,
    jumpToMonth
  } = useMonthCalendar(timezone)

  // One all-time pull drives the calendar grid, the month/year summaries, and
  // the day-drawer lookup — no trailing window that would hide older history.
  const allWorkoutsQuery = useAllWorkouts()
  const allWorkouts = useMemo(() => allWorkoutsQuery.data ?? [], [allWorkoutsQuery.data])

  // Buckets over ALL history: drives the calendar grid and resolves the drawer.
  const daysByKey = useMemo(
    () => groupWorkoutsByDay(allWorkouts, timezone),
    [allWorkouts, timezone]
  )

  const monthCellsInMonth = Array.from(daysByKey.values()).filter((bucket) => {
    const [y, m] = bucket.dateKey.split('-').map(Number)
    return y === viewYear && m === viewMonth
  })
  const sessionsCount = monthCellsInMonth.reduce((sum, b) => sum + b.workouts.length, 0)
  const hasAnySessionThisMonth = sessionsCount > 0

  // Month / year pill summaries (lib/periodSummary.ts — counts single-sitting VISITS).
  const summaryItems: SummaryItem[] = useMemo(
    () =>
      allWorkouts.map((w) => {
        const startMs = Date.parse(w.start_at)
        // end_at is sometimes null (HAE didn't report it) — derive from duration_s
        // so back-to-back visit merging still works for those workouts.
        const endMs = w.end_at
          ? Date.parse(w.end_at)
          : w.duration_s !== null
            ? startMs + w.duration_s * 1000
            : undefined
        return {
          dateKey: localDateKey(w.start_at, timezone),
          durationS: w.duration_s ?? 0,
          type: w.type,
          startMs: Number.isNaN(startMs) ? undefined : startMs,
          endMs: endMs !== undefined && Number.isNaN(endMs) ? undefined : endMs
        }
      }),
    [allWorkouts, timezone]
  )

  const todayKey = localDateKey(new Date().toISOString(), timezone)
  const viewedYm = `${viewYear.toString().padStart(4, '0')}-${viewMonth.toString().padStart(2, '0')}`

  const monthSum = useMemo(
    () => monthSummary(summaryItems, viewedYm, todayKey),
    [summaryItems, viewedYm, todayKey]
  )
  const yearSum = useMemo(() => yearSummary(summaryItems, viewYear), [summaryItems, viewYear])

  const monthStatRows: StatTableRow[] = hasAnySessionThisMonth
    ? [
        { label: 'Workouts', value: monthSum.workouts.toString() },
        { label: 'Total time', value: formatDurationHM(monthSum.totalDurationS) },
        { label: 'Gym sessions', value: monthSum.gymSessions.toString() },
        { label: 'Cardio sessions', value: monthSum.cardioSessions.toString() },
        { label: 'Time trend', value: `${formatTrendPct(monthSum.timeTrendPct)} vs last month` }
      ]
    : [{ label: 'Time trend', value: `${formatTrendPct(monthSum.timeTrendPct)} vs last month` }]

  const yearStatRows: StatTableRow[] = [
    { label: 'Workouts/mo', value: formatPerMonth(yearSum.avgWorkoutsPerMonth) },
    { label: 'Time/mo', value: formatDurationHM(yearSum.avgDurationSPerMonth) },
    { label: 'Gym/mo', value: formatPerMonth(yearSum.avgGymPerMonth) },
    { label: 'Cardio/mo', value: formatPerMonth(yearSum.avgCardioPerMonth) }
  ]

  const selectedBucket = selectedDayKey ? daysByKey.get(selectedDayKey) : undefined
  const selectedDateLabel = selectedDayKey
    ? new Date(`${selectedDayKey}T12:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
      })
    : ''

  // --- Daily metrics: body-weight pill + RHR pill ---
  const dailyMetrics = useMemo(() => dailyMetricsQuery.data ?? [], [dailyMetricsQuery.data])
  const sortedMetrics = useMemo(
    () => [...dailyMetrics].sort((a, b) => a.date.localeCompare(b.date)),
    [dailyMetrics]
  )

  // Body-weight pill summary — pure derivation over the sparse weigh-ins.
  const weightSummary = useMemo(
    () => computeBodyWeightSummary(sortedMetrics, ymdKey(todayYmd)),
    [sortedMetrics, todayYmd]
  )

  // Active-energy pill: today so far + prior-7-day average, same metric pull.
  const energySummary = useMemo(
    () => computeActiveEnergySummary(sortedMetrics, ymdKey(todayYmd)),
    [sortedMetrics, todayYmd]
  )

  // Resting HR: latest real value + deviation (computed elsewhere; null for now).
  const latestRhrRow = [...sortedMetrics].reverse().find((m) => m.resting_hr !== null)
  const latestRhr = latestRhrRow?.resting_hr ?? null

  // Trend shapes under each glance figure. The windows differ because the
  // metrics do: weigh-ins are sparse enough to need half a year to show a
  // direction, active energy is daily, and RHR reads against a monthly baseline.
  const todayYmdKey = ymdKey(todayYmd)
  const weightTrend = useMemo(
    () => trendPoints(sortedMetrics, (m) => m.weight_kg, 180, todayYmdKey),
    [sortedMetrics, todayYmdKey]
  )
  const energyTrend = useMemo(
    () => trendPoints(sortedMetrics, (m) => m.active_energy_kcal, 14, todayYmdKey),
    [sortedMetrics, todayYmdKey]
  )
  const rhrTrend = useMemo(
    () => trendPoints(sortedMetrics, (m) => m.resting_hr, 30, todayYmdKey),
    [sortedMetrics, todayYmdKey]
  )

  // --- Sessions this week vs weekly_min_sessions ---
  const workoutsThisWeek = workoutsThisWeekQuery.data ?? []
  const minSessionEntries = Object.entries(weeklyMinSessions)

  // The hero figure. Done/target are the SUMS of the per-modality rows printed
  // directly beneath, so the headline always reconciles with the breakdown a
  // reader can check by eye. With no minimums configured there is nothing to
  // score against, so it falls back to a plain count of this week's sessions.
  const goalRows = minSessionEntries.map(([type, min]) => ({
    type,
    min,
    done: countSessionsForGoal(workoutsThisWeek, type)
  }))
  const hasGoals = goalRows.length > 0
  const sessionsDone = hasGoals
    ? goalRows.reduce((sum, r) => sum + r.done, 0)
    : workoutsThisWeek.length
  const sessionsTarget = goalRows.reduce((sum, r) => sum + r.min, 0)
  const sessionsRemaining = Math.max(0, sessionsTarget - sessionsDone)
  const minimumMet = hasGoals && sessionsRemaining === 0
  const heroDelta = !hasGoals
    ? 'No weekly minimums set yet — add them in Profile'
    : minimumMet
      ? 'Weekly minimum met'
      : `${sessionsRemaining} to go`

  // --- Recent sessions: last 4 workouts as a 2×2 grid ---
  const recentWorkouts = [...(recentWorkoutsQuery.data ?? [])]
    .sort((a, b) => b.start_at.localeCompare(a.start_at))
    .slice(0, 4)

  // A single-workout drawer opened by clicking one recent-session tile.
  const [recentWorkout, setRecentWorkout] = useState<Workout | null>(null)
  const recentDrawerLabel = recentWorkout
    ? new Date(recentWorkout.start_at).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: timezone
      })
    : ''

  // --- RHR metric-detail popup (the one remaining clickable metric here) ---
  const rhrConfig = useMemo<MetricDetailConfig>(() => {
    const rhrSeries = toDetailSeries(sortedMetrics, (r: DailyMetric) => ({
      date: r.date,
      value: r.resting_hr
    }))
    return {
      title: 'Resting heart rate',
      currentValueDisplay: latestRhr === null ? EM_DASH : `${Math.round(latestRhr)} bpm`,
      series: rhrSeries,
      explanation: METRIC_EXPLANATIONS.rhr,
      domain: 'recovery',
      seriesName: 'RHR',
      unit: 'bpm',
      // Daily RHR is noisy — overlay a 7-day trend so the direction is legible.
      showTrend: true
    }
  }, [sortedMetrics, latestRhr])
  const [rhrOpen, setRhrOpen] = useState(false)

  return (
    <div className="view">
      <TabHeader eyebrow="Overview" title="Dashboard" />

      <div className="dashboard-card-stack">
        {/* Lead row: the tab's one hero metric (DESIGN.md allows exactly one) —
            weekly session adherence, the number this overview exists to answer,
            with the per-modality breakdown beside it as supporting evidence —
            and the RHR readiness tile alongside on the 8/4 split. */}
        <div className="dashboard-grid">
          <div className="dashboard-grid--span-8">
            <div className="dashboard-hero-card">
              <HeroMetric
                eyebrow="Sessions · this week"
                value={sessionsDone.toString()}
                unit={hasGoals ? `of ${sessionsTarget}` : 'logged'}
                delta={heroDelta}
                deltaPositive={minimumMet}
                domain="sessions"
              />
              {hasGoals && (
                <div className="dashboard-sessions-list">
                  {goalRows.map(({ type, min, done }) => (
                    <div className="dashboard-sessions-row" key={type}>
                      <div className="dashboard-sessions-row-head">
                        <span
                          className="dashboard-sessions-pill"
                          style={{ color: activityEnvironmentAccent(type) }}
                        >
                          <ModalityIcon type={type} size={14} />
                          <ActivityBadge type={type} label={humanizeWorkoutType(type)} />
                        </span>
                        <span className="dashboard-sessions-row-value tabular-nums">
                          {done} of {min}
                        </span>
                      </div>
                      {/* Capped at 100% so an extra session reads as "done"
                          rather than overflowing the track. */}
                      <div className="dashboard-sessions-bar">
                        <div
                          className="dashboard-sessions-bar-fill"
                          style={{ width: `${min > 0 ? Math.min(100, (done / min) * 100) : 0}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="dashboard-grid--span-4">
            <StatSquare
              label="RHR"
              name="Resting HR"
              value={latestRhr === null ? EM_DASH : Math.round(latestRhr).toString()}
              sub={latestRhr === null ? 'no data' : 'bpm · last night'}
              domain="recovery"
              trend={rhrTrend}
              onClick={() => setRhrOpen(true)}
            />
          </div>
        </div>

        {/* Glance row: the three standing figures, each with its trend shape. */}
        <div className="dashboard-glance-grid">
          <BodyWeightPill summary={weightSummary} trend={weightTrend} />
          <ProteinPill timezone={timezone} />
          <ActiveEnergyPill summary={energySummary} trend={energyTrend} />
        </div>
      </div>

      {/* Forward-looking first: what to train next (active templates), then
          what the month looks like, then what was just done. A tile opens the
          same expanded template view the Gym tab uses (read-only here:
          lifecycle stays, edit/delete remain a Gym-tab affair). */}
      <GymTemplatesBox
        templates={gymTemplatesQuery.data ?? []}
        sessions={gymHistoryQuery.data ?? []}
        onOpenTemplates={onOpenGymTemplates}
        onSelectTemplate={setTemplateView}
      />

      {/* Calendar + period summaries (calendar left, month/year tables right). */}
      <div className="dashboard-calendar-grid">
        <div className="dashboard-calendar-grid-calendar">
          <CalendarHeatmap
            year={viewYear}
            month={viewMonth}
            today={today}
            daysByKey={daysByKey}
            onSelectDay={openDay}
            onPrevMonth={handlePrevMonth}
            onNextMonth={handleNextMonth}
            onJumpToMonth={jumpToMonth}
            showDayLabel
          />
        </div>

        <div className="dashboard-calendar-grid-summary">
          <SummaryCard title="Month summary" rows={monthStatRows} />
          <SummaryCard title={`${viewYear} · monthly average`} rows={yearStatRows} />
        </div>
      </div>

      {/* Its own section (heading on the canvas, tiles carrying the surface) —
          so it sits at the same rhythm as Goals rather than inside the card
          stack's tighter grid gap. */}
      <RecentSessionsBox
        workouts={recentWorkouts}
        timezone={timezone}
        onOpenSessions={onOpenSessions}
        onSelectWorkout={setRecentWorkout}
      />

      <GoalStrip onOpenProfile={onOpenProfile} />

      {selectedDayKey && selectedBucket && (
        <DayDetailDrawer
          dateLabel={selectedDateLabel}
          workouts={selectedBucket.workouts}
          timezone={timezone}
          onClose={closeDay}
        />
      )}

      {recentWorkout && (
        <DayDetailDrawer
          dateLabel={recentDrawerLabel}
          workouts={[recentWorkout]}
          timezone={timezone}
          onClose={() => setRecentWorkout(null)}
        />
      )}

      {rhrOpen && <MetricDetailModal config={rhrConfig} onClose={() => setRhrOpen(false)} />}

      {templateView && (
        <TemplateViewModal
          template={templateView}
          usageCount={(gymHistoryQuery.data ?? []).reduce(
            (n, s) => n + (s.template_ids.includes(templateView.id) ? 1 : 0),
            0
          )}
          onClose={() => setTemplateView(null)}
        />
      )}
    </div>
  )
}

interface GymTemplatesBoxProps {
  templates: GymTemplate[]
  sessions: { performed_at: string; template_ids: string[] }[]
  onOpenTemplates: () => void
  onSelectTemplate: (template: GymTemplate) => void
}

/**
 * Quick access to the active (non-archived, current-version) gym templates,
 * in the same section vocabulary as Recent sessions: heading on the canvas,
 * tiles carrying the surface. Tile order follows the Gym tab's user-arranged
 * card order (same localStorage key), so the two surfaces never disagree.
 * Renders nothing when there are no active templates — the Gym tab is where
 * template setup is taught, not the overview.
 */
function GymTemplatesBox({
  templates,
  sessions,
  onOpenTemplates,
  onSelectTemplate
}: GymTemplatesBoxProps): ReactElement | null {
  const active = useMemo(
    () => templates.filter((t) => !t.archived && t.is_current),
    [templates]
  )
  const cardOrder = useCardOrder(
    'gym:templates:active:order',
    active.map((t) => t.id)
  )
  const byId = useMemo(() => new Map(active.map((t) => [t.id, t])), [active])
  const ordered = cardOrder.orderedIds
    .map((id) => byId.get(id))
    .filter((t): t is GymTemplate => t != null)

  const lastDoneById = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of sessions) {
      const day = s.performed_at.slice(0, 10)
      for (const id of s.template_ids) {
        const prev = m.get(id)
        if (prev == null || day > prev) m.set(id, day)
      }
    }
    return m
  }, [sessions])
  const usageById = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of sessions) {
      for (const id of s.template_ids) m.set(id, (m.get(id) ?? 0) + 1)
    }
    return m
  }, [sessions])

  if (ordered.length === 0) return null

  const fmtDay = (ymd: string): string => {
    const [y, m, d] = ymd.split('-').map(Number)
    return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    })
  }

  return (
    <div className="recent-sessions-box">
      <div className="recent-sessions-header">
        <h3 className="recent-sessions-title">Gym templates</h3>
        <button type="button" className="recent-sessions-all" onClick={onOpenTemplates}>
          All templates
          <ArrowRight size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="recent-sessions-grid">
        {ordered.map((template) => {
          const running = template.runs[0] != null && template.runs[0].ended_at === null
          const lastDone = lastDoneById.get(template.id)
          const done = usageById.get(template.id) ?? 0
          const exerciseCount = template.items.length
          const statusLine = running
            ? `Active since ${fmtDay(template.runs[0].started_at.slice(0, 10))}`
            : lastDone
              ? `Last done ${fmtDay(lastDone)}`
              : 'Not started'
          const stats = [
            template.version > 1 ? `v${template.version}` : null,
            `${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}`,
            exerciseCount > 0
              ? formatEstimatedDuration(estimateTemplateDurationSeconds(template))
              : null,
            done > 0 ? `done ${done}×` : null
          ]
            .filter(Boolean)
            .join(' · ')
          return (
            <button
              type="button"
              key={template.id}
              className="recent-session-tile"
              onClick={() => onSelectTemplate(template)}
            >
              <span
                className="recent-session-tile-modality"
                style={{ color: activityEnvironmentAccent('functional_strength_training') }}
              >
                <ModalityIcon type="functional_strength_training" size={16} />
                <span className="recent-session-tile-label">{template.name}</span>
              </span>
              <span className="recent-session-tile-date">{statusLine}</span>
              <span className="recent-session-tile-stats tabular-nums">{stats}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface RecentSessionsBoxProps {
  workouts: Workout[]
  timezone: string | null | undefined
  onOpenSessions: () => void
  onSelectWorkout: (workout: Workout) => void
}

/**
 * Full-width "Recent sessions" section: a heading on the canvas above the last 4
 * workouts as a row of tiles. Each tile is a button that opens that ONE workout
 * in the day drawer, with a clear hover cue; a separate "All sessions →" link in
 * the header navigates to the full Sessions view. Neither the section nor the
 * header is clickable, so a tile's hover reads unambiguously.
 */
function RecentSessionsBox({
  workouts,
  timezone,
  onOpenSessions,
  onSelectWorkout
}: RecentSessionsBoxProps): ReactElement {
  return (
    <div className="recent-sessions-box">
      <div className="recent-sessions-header">
        <h3 className="recent-sessions-title">Recent sessions</h3>
        <button type="button" className="recent-sessions-all" onClick={onOpenSessions}>
          All sessions
          <ArrowRight size={14} strokeWidth={1.75} />
        </button>
      </div>
      {workouts.length === 0 ? (
        <EmptyState message="No workouts yet — they'll appear when the workout automation syncs." />
      ) : (
        <div className="recent-sessions-grid">
          {workouts.map((w) => {
            const distance = fmtDistance(w.distance_m)
            const dateLabel = new Intl.DateTimeFormat('en-US', {
              timeZone: timezone ?? undefined,
              day: 'numeric',
              month: 'short'
            }).format(new Date(w.start_at))
            return (
              <button
                type="button"
                key={w.id}
                className="recent-session-tile"
                onClick={() => onSelectWorkout(w)}
              >
                <span
                  className="recent-session-tile-modality"
                  style={{ color: activityEnvironmentAccent(w.type) }}
                >
                  <ModalityIcon type={w.type} size={16} />
                  <span className="recent-session-tile-label">{modalityLabel(w.type)}</span>
                </span>
                <span className="recent-session-tile-date tabular-nums">{dateLabel}</span>
                <span className="recent-session-tile-stats tabular-nums">
                  {fmtDuration(w.duration_s)}
                  {distance ? ` · ${distance}` : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
