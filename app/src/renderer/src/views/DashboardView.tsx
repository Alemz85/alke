import { useMemo, useState, type ReactElement } from 'react'
import { ArrowRight } from 'lucide-react'
import type { DailyMetric, Workout } from '@shared/types'
import { TabHeader } from './TabHeader'
import {
  EmptyState,
  MetricDetailModal,
  type MetricDetailConfig,
  type MetricDetailPoint
} from '../components'
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
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { useMonthCalendar } from '../hooks/useMonthCalendar'
import { localDateKey, todayYMD, ymdKey } from '../hooks/sessionsDate'
import { formatDurationHM, formatPerMonth, formatTrendPct } from '../lib/format'
import { monthSummary, yearSummary, type SummaryItem } from '../lib/periodSummary'
import {
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

interface StatSquareProps {
  label: string
  /** Full name spelled out under the acronym, e.g. "Resting HR". */
  name: string
  value: string
  sub?: string
  domain: 'load' | 'recovery'
  onClick: () => void
}

/** A small clickable stat tile (RHR) that opens its metric popup. */
function StatSquare({ label, name, value, sub, domain, onClick }: StatSquareProps): ReactElement {
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
        {sub && <span className="stat-square-sub">{sub}</span>}
      </span>
    </button>
  )
}

export function DashboardView({ onOpenSessions, onOpenProfile }: DashboardViewProps): ReactElement {
  const userConfigQuery = useUserConfig()
  // A year of daily metrics feeds the RHR detail popup and the body-weight
  // pill's ~30-day-ago comparison; the pill/RHR calcs filter by date so the
  // wide pull is safe.
  const dailyMetricsQuery = useDailyMetrics(365)
  const recentWorkoutsQuery = useRecentWorkouts()

  const timezone = userConfigQuery.data?.timezone ?? undefined
  const weeklyMinSessions = parseWeeklyMinSessions(userConfigQuery.data)

  // The ISO week window anchored to "today" in the USER's configured timezone.
  const todayYmd = todayYMD(timezone)
  const weekWindow = isoWeekWindowFor(todayYmd)
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
  const dailyMetrics = dailyMetricsQuery.data ?? []
  const sortedMetrics = useMemo(
    () => [...dailyMetrics].sort((a, b) => a.date.localeCompare(b.date)),
    [dailyMetrics]
  )

  // Body-weight pill summary — pure derivation over the sparse weigh-ins.
  const weightSummary = useMemo(
    () => computeBodyWeightSummary(sortedMetrics, ymdKey(todayYmd)),
    [sortedMetrics, todayYmd]
  )

  // Resting HR: latest real value + deviation (computed elsewhere; null for now).
  const latestRhrRow = [...sortedMetrics].reverse().find((m) => m.resting_hr !== null)
  const latestRhr = latestRhrRow?.resting_hr ?? null

  // --- Sessions this week vs weekly_min_sessions ---
  const workoutsThisWeek = workoutsThisWeekQuery.data ?? []
  const minSessionEntries = Object.entries(weeklyMinSessions)

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

      {/* Top glance row: body weight + protein (compact pills). */}
      <div className="dashboard-glance-grid">
        <BodyWeightPill summary={weightSummary} />
        <ProteinPill timezone={timezone} />
      </div>

      {/* Sessions this week + a compact RHR readiness tile, then recent sessions. */}
      <div className="dashboard-grid">
        <div className="dashboard-grid--span-8">
          <div className="metric-card dashboard-sessions-card">
            <div className="metric-card-eyebrow">Sessions this week</div>
            {minSessionEntries.length === 0 ? (
              <div className="metric-card-value metric-card-value--sessions tabular-nums">
                {EM_DASH}
              </div>
            ) : (
              <div className="dashboard-sessions-list">
                {minSessionEntries.map(([type, min]) => (
                  <div className="dashboard-sessions-row" key={type}>
                    <span
                      className="dashboard-sessions-pill"
                      style={{ color: activityEnvironmentAccent(type) }}
                    >
                      <ModalityIcon type={type} size={14} />
                      <ActivityBadge type={type} label={humanizeWorkoutType(type)} />
                    </span>
                    <span className="dashboard-sessions-row-value tabular-nums">
                      {countSessionsForGoal(workoutsThisWeek, type)} of {min}
                    </span>
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
            onClick={() => setRhrOpen(true)}
          />
        </div>

        <div className="dashboard-grid--span-12">
          <RecentSessionsBox
            workouts={recentWorkouts}
            timezone={timezone}
            onOpenSessions={onOpenSessions}
            onSelectWorkout={setRecentWorkout}
          />
        </div>
      </div>

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
 * Full-width "Recent sessions" box: the last 4 workouts as a row of mini-tiles.
 * Each tile is a button that opens that ONE workout in the day drawer, with a
 * clear hover cue; a separate "All sessions →" link in the header navigates to
 * the full Sessions view. The box itself is no longer a giant button — that had
 * made per-tile hover indistinguishable from the box.
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
