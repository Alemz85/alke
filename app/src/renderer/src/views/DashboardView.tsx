import type { ReactElement } from 'react'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { TabHeader } from './TabHeader'
import {
  BadgeDomain,
  ChartCard,
  EmptyState,
  FlagBanner,
  HeroMetric,
  MetricCard
} from '../components'
import {
  useComputedDaily,
  useDailyMetrics,
  useRecentWorkouts,
  useTodayFlags,
  useUserConfig,
  useWorkoutsInRange
} from '../hooks/useDashboardData'
import {
  countSessionsForGoal,
  endOfIsoWeek,
  fmtDelta,
  fmtDistance,
  fmtDuration,
  fmtLocalDateTime,
  fmtNum,
  humanizeWorkoutType,
  parseWeeklyMinSessions,
  startOfIsoWeek
} from './dashboardUtils'
import './DashboardView.css'

const EM_DASH = '—'

export function DashboardView(): ReactElement {
  const userConfigQuery = useUserConfig()
  const flagsQuery = useTodayFlags()
  const computedDailyQuery = useComputedDaily(90)
  const dailyMetricsQuery = useDailyMetrics(90)
  const recentWorkoutsQuery = useRecentWorkouts()

  const now = new Date()
  const weekStart = startOfIsoWeek(now)
  const weekEnd = endOfIsoWeek(now)
  const fourWeeksAgo = new Date(weekStart)
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28)
  const workoutsThisWeekQuery = useWorkoutsInRange(weekStart.toISOString(), weekEnd.toISOString())

  const timezone = userConfigQuery.data?.timezone ?? undefined
  const weeklyMinSessions = parseWeeklyMinSessions(userConfigQuery.data)

  // --- Hero: CTL + 7d delta ---
  const computedDaily = computedDailyQuery.data ?? []
  const sortedComputed = [...computedDaily].sort((a, b) => a.date.localeCompare(b.date))
  const latestComputed = sortedComputed.length > 0 ? sortedComputed[sortedComputed.length - 1] : undefined
  const latestCtl = latestComputed?.ctl ?? null

  let ctlDelta: number | null = null
  if (latestComputed) {
    const latestDate = new Date(latestComputed.date)
    const sevenDaysAgo = new Date(latestDate)
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10)
    const priorRow = sortedComputed.find((r) => r.date === sevenDaysAgoStr)
    if (priorRow && priorRow.ctl !== null && latestCtl !== null) {
      ctlDelta = latestCtl - priorRow.ctl
    }
  }

  // --- ATL & TSB ---
  const latestAtl = latestComputed?.atl ?? null
  const latestTsb = latestComputed?.tsb ?? null

  // --- TRIMP this week vs 4-week average ---
  const weekStartStr = weekStart.toISOString().slice(0, 10)
  const weekEndStr = weekEnd.toISOString().slice(0, 10)
  const trimpThisWeekRows = sortedComputed.filter((r) => r.date >= weekStartStr && r.date < weekEndStr)
  const trimpThisWeekTotal = trimpThisWeekRows.some((r) => r.trimp_total !== null)
    ? trimpThisWeekRows.reduce((sum, r) => sum + (r.trimp_total ?? 0), 0)
    : null

  const fourWeeksAgoStr = fourWeeksAgo.toISOString().slice(0, 10)
  const trimp4wRows = sortedComputed.filter((r) => r.date >= fourWeeksAgoStr && r.date < weekEndStr)
  const trimp4wAvg = trimp4wRows.some((r) => r.trimp_total !== null)
    ? trimp4wRows.reduce((sum, r) => sum + (r.trimp_total ?? 0), 0) / 4
    : null

  // --- Sessions this week vs weekly_min_sessions ---
  const workoutsThisWeek = workoutsThisWeekQuery.data ?? []
  const minSessionEntries = Object.entries(weeklyMinSessions)

  // --- Resting HR: latest real value + deviation (computed, null for now) ---
  const dailyMetrics = dailyMetricsQuery.data ?? []
  const sortedMetrics = [...dailyMetrics].sort((a, b) => a.date.localeCompare(b.date))
  const latestRhrRow = [...sortedMetrics].reverse().find((m) => m.resting_hr !== null)
  const latestRhr = latestRhrRow?.resting_hr ?? null
  const rhrDev = latestComputed?.rhr_dev ?? null

  // --- CTL/ATL mini chart data (90d) ---
  const chartData = sortedComputed.map((r) => ({
    date: r.date,
    ctl: r.ctl,
    atl: r.atl
  }))
  const hasChartData = chartData.some((d) => d.ctl !== null || d.atl !== null)

  // --- Last 3 workouts ---
  const recentWorkouts = [...(recentWorkoutsQuery.data ?? [])]
    .sort((a, b) => b.start_at.localeCompare(a.start_at))
    .slice(0, 3)

  const flags = flagsQuery.data ?? []

  return (
    <div className="view">
      <TabHeader eyebrow="Overview" title="Dashboard" />

      {flags.length > 0 && (
        <div className="dashboard-flags">
          {flags.map((flag, i) => (
            <FlagBanner key={`${flag.type}-${i}`} message={flag.message} />
          ))}
        </div>
      )}

      <HeroMetric
        eyebrow="TRAINING LOAD · CTL"
        value={fmtNum(latestCtl, 1)}
        delta={ctlDelta === null ? undefined : `${fmtDelta(ctlDelta, 1)} vs 7 days ago`}
        deltaPositive={ctlDelta !== null && ctlDelta > 0}
        domain="load"
      />

      <div className="dashboard-grid">
        <div className="dashboard-grid--span-4">
          <div className="metric-card">
            <div className="metric-card-eyebrow">Atl &amp; Tsb</div>
            <div className="dashboard-dual-stat">
              <div className="dashboard-dual-stat-item">
                <span className="dashboard-dual-stat-label">ATL</span>
                <span className="dashboard-dual-stat-value tabular-nums">{fmtNum(latestAtl, 1)}</span>
              </div>
              <div className="dashboard-dual-stat-item">
                <span className="dashboard-dual-stat-label">TSB</span>
                <span className="dashboard-dual-stat-value tabular-nums">{fmtNum(latestTsb, 1)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-grid--span-4">
          <MetricCard
            eyebrow="TRIMP this week"
            value={trimpThisWeekTotal === null ? EM_DASH : Math.round(trimpThisWeekTotal).toString()}
            caption={
              trimp4wAvg === null
                ? '4-week average —'
                : `4-week average ${Math.round(trimp4wAvg)}`
            }
            domain="load"
          />
        </div>

        <div className="dashboard-grid--span-4">
          <div className="metric-card">
            <div className="metric-card-eyebrow">Sessions this week</div>
            {minSessionEntries.length === 0 ? (
              <div className="metric-card-value metric-card-value--sessions tabular-nums">{EM_DASH}</div>
            ) : (
              <div className="dashboard-sessions-list">
                {minSessionEntries.map(([type, min]) => (
                  <div className="dashboard-sessions-row" key={type}>
                    <span className="dashboard-sessions-row-label">{humanizeWorkoutType(type)}</span>
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
          <MetricCard
            eyebrow="Resting heart rate"
            value={latestRhr === null ? EM_DASH : Math.round(latestRhr).toString()}
            caption={
              latestRhr === null
                ? 'bpm · no data yet'
                : `bpm · deviation ${rhrDev === null ? EM_DASH : fmtDelta(rhrDev, 1)}`
            }
            domain="recovery"
          />
        </div>

        <div className="dashboard-grid--span-8">
          <ChartCard title="CTL / ATL — 90 days" span={8}>
            {hasChartData ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12, fill: 'var(--color-text-tertiary)' }}
                    axisLine={{ stroke: 'var(--color-divider-soft)' }}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: 'var(--color-text-tertiary)' }}
                    axisLine={false}
                    tickLine={false}
                    width={32}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--color-surface-hover)',
                      border: 'none',
                      borderRadius: 'var(--radius-md)',
                      fontSize: 13
                    }}
                    labelStyle={{ color: 'var(--color-text-secondary)' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="ctl"
                    name="CTL"
                    stroke="var(--color-load)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="atl"
                    name="ATL"
                    stroke="var(--color-text-tertiary)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message="No training-load history yet — CTL and ATL will chart here once the nightly metrics job has run." />
            )}
          </ChartCard>
        </div>
      </div>

      <div className="dashboard-workouts-card">
        <h3 className="dashboard-workouts-title">Last 3 workouts</h3>
        {recentWorkouts.length === 0 ? (
          <EmptyState message="No workouts yet — they'll appear when the workout automation syncs." />
        ) : (
          <div className="dashboard-workouts-list">
            {recentWorkouts.map((w) => {
              const distance = fmtDistance(w.distance_m)
              return (
                <div className="dashboard-workout-row" key={w.id}>
                  <BadgeDomain domain="sessions" label={humanizeWorkoutType(w.type)} />
                  <div>
                    <div className="dashboard-workout-name">{humanizeWorkoutType(w.type)}</div>
                    <div className="dashboard-workout-meta">{fmtLocalDateTime(w.start_at, timezone)}</div>
                  </div>
                  <div className="dashboard-workout-stats">
                    <div className="dashboard-workout-stat">
                      <span className="dashboard-workout-stat-value tabular-nums">
                        {fmtDuration(w.duration_s)}
                      </span>
                      <span className="dashboard-workout-stat-label">Duration</span>
                    </div>
                    {distance && (
                      <div className="dashboard-workout-stat">
                        <span className="dashboard-workout-stat-value tabular-nums">{distance}</span>
                        <span className="dashboard-workout-stat-label">Distance</span>
                      </div>
                    )}
                    <div className="dashboard-workout-stat">
                      <span className="dashboard-workout-stat-value tabular-nums">
                        {fmtNum(w.computed?.trimp ?? null, 0)}
                      </span>
                      <span className="dashboard-workout-stat-label">TRIMP</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
