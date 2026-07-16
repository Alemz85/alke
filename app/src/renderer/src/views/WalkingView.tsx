import { useMemo, type ReactElement } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { DailyMetric, Workout } from '@shared/types'
import { ChartCard, EmptyState, MetricCard, RecentSessionsCard } from '../components'
import { HeroNumber } from '../components/HeroNumber'
import { CHART, chartTooltipStyle } from '../lib/chartTheme'
import { buildNumericAxis } from '../lib/cardioChartScales'
import { EM_DASH, fmtDelta, formatDurationHM } from '../lib/format'
import {
  averageDailySteps,
  dailyStepsSeries,
  explicitWalkStats,
  flightsThisWeek,
  periodDistanceTotals,
  periodStepsTotals,
  todayVsAvgSteps,
  weeklyStepsTotals,
  type DailyStepsPoint
} from '../lib/walkingStats'
import { hasZones, tizRows, weeklyZ2, TimeInZonesStacks, WeeklyZ2Bars } from './Zone2View'
import './WalkingView.css'

interface WalkingViewProps {
  /** Explicit walk/hike workouts only (already filtered by modality). */
  workouts: Workout[]
  dailyMetrics: DailyMetric[]
  timezone: string | null
  onOpenSessions?: (activity?: string) => void
}

function formatSteps(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function formatWalkDistance(km: number): string {
  return km >= 100 ? `${Math.round(km).toLocaleString('en-US')} km` : `${km.toFixed(1)} km`
}

/** "4.2 km" at one decimal, em dash when there's no distance data for the window at all. */
function formatDailyDistance(km: number | null): string {
  return km == null ? EM_DASH : `${km.toFixed(1)} km`
}

export function WalkingView({
  workouts,
  dailyMetrics,
  timezone,
  onOpenSessions
}: WalkingViewProps): ReactElement {
  const hasStepsData = dailyMetrics.some((m) => m.steps != null)

  const dailySeries = useMemo(
    () => dailyStepsSeries(dailyMetrics, timezone, 90),
    [dailyMetrics, timezone]
  )
  const weeklySeries = useMemo(
    () => weeklyStepsTotals(dailyMetrics, timezone, 26),
    [dailyMetrics, timezone]
  )
  const avg30d = useMemo(
    () => averageDailySteps(dailyMetrics, timezone, 30),
    [dailyMetrics, timezone]
  )
  const todayVsAvg = useMemo(
    () => todayVsAvgSteps(dailyMetrics, timezone, 30),
    [dailyMetrics, timezone]
  )
  const periodTotals = useMemo(
    () => periodStepsTotals(dailyMetrics, timezone),
    [dailyMetrics, timezone]
  )
  const distanceTotals = useMemo(
    () => periodDistanceTotals(dailyMetrics, timezone),
    [dailyMetrics, timezone]
  )
  const flightsWeek = useMemo(() => flightsThisWeek(dailyMetrics, timezone), [dailyMetrics, timezone])

  const lifetimeWalks = useMemo(() => explicitWalkStats(workouts, timezone, 'lifetime'), [workouts, timezone])
  const monthWalks = useMemo(() => explicitWalkStats(workouts, timezone, 'month'), [workouts, timezone])
  const hasExplicitWalks = lifetimeWalks.count > 0

  const zonedWalks = useMemo(() => workouts.filter(hasZones), [workouts])
  const weeklyWalkZ2 = useMemo(() => weeklyZ2(zonedWalks, timezone, 12), [zonedWalks, timezone])
  const walkTizBars = useMemo(() => tizRows(zonedWalks, timezone, 15), [zonedWalks, timezone])

  const dailyAxis = buildNumericAxis(
    dailySeries.map((p) => p.steps),
    { includeZero: true, tickCount: 4 }
  )
  const weeklyAxis = buildNumericAxis(
    weeklySeries.map((p) => p.steps),
    { includeZero: true, tickCount: 4 }
  )

  if (!hasStepsData) {
    return (
      <EmptyState message="No daily step data yet — steps appear here once Health Auto Export syncs daily metrics." />
    )
  }

  return (
    <div className="walking-view" role="tabpanel" aria-label="Walking">
      <section className="walking-overview" aria-label="Daily activity overview">
        <div className="walking-overview-top">
          <div className="walking-hero">
            <span className="walking-section-kicker">Average daily steps · last 30d</span>
            <HeroNumber value={avg30d} format={formatSteps} className="walking-hero-value" />
            <span className="walking-hero-caption">
              Today: {todayVsAvg.today != null ? formatSteps(todayVsAvg.today) : EM_DASH}
              {todayVsAvg.deltaPct != null && (
                <span
                  className={
                    todayVsAvg.deltaPct >= 0 ? 'walking-delta walking-delta--up' : 'walking-delta walking-delta--down'
                  }
                >
                  {' '}
                  ({fmtDelta(todayVsAvg.deltaPct, 0)}% vs baseline)
                </span>
              )}
            </span>
          </div>
          <div className="walking-stat-facts">
            <MetricCard eyebrow="Steps this week" value={formatSteps(periodTotals.thisWeek)} />
            <MetricCard eyebrow="Steps this month" value={formatSteps(periodTotals.thisMonth)} />
            <MetricCard
              eyebrow="vs 30d baseline"
              value={todayVsAvg.deltaPct != null ? `${fmtDelta(todayVsAvg.deltaPct, 0)}%` : EM_DASH}
              caption="today vs trailing average"
            />
          </div>
        </div>
        <div className="walking-stat-facts walking-stat-facts--distance">
          <MetricCard eyebrow="Distance today" value={formatDailyDistance(distanceTotals.todayKm)} />
          <MetricCard
            eyebrow="Distance this week"
            value={formatDailyDistance(distanceTotals.thisWeekKm)}
            caption={flightsWeek != null ? `${flightsWeek} floors this week` : undefined}
          />
          <MetricCard eyebrow="Distance this month" value={formatDailyDistance(distanceTotals.thisMonthKm)} />
        </div>
      </section>

      <div className="zone2-grid walking-grid">
        <ChartCard
          title="Daily steps"
          span={12}
          headerRight={<span className="walking-chart-unit">last 90 days</span>}
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={dailySeries} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis
                dataKey="date"
                interval="preserveStartEnd"
                minTickGap={24}
                tickFormatter={(v: string) => v.slice(5)}
                tick={{ fill: CHART.tertiary, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={dailyAxis.domain}
                ticks={dailyAxis.ticks}
                tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
                tick={{ fill: CHART.tertiary, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={44}
              />
              <Tooltip
                contentStyle={chartTooltipStyle}
                cursor={{ fill: CHART.cursor }}
                formatter={(v, _name, item) =>
                  typeof v === 'number'
                    ? [`${formatSteps(v)} steps · ${formatDailyDistance((item?.payload as DailyStepsPoint)?.distanceKm ?? null)}`, '']
                    : v
                }
              />
              <Bar dataKey="steps" fill={CHART.aerobic} radius={[3, 3, 0, 0]} maxBarSize={10} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <p className="zone2-caption">Zero-filled — a gap means no steps recorded that day, not missing data.</p>
        </ChartCard>

        <ChartCard
          title="Weekly steps"
          span={12}
          headerRight={<span className="walking-chart-unit">last 26 weeks</span>}
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={weeklySeries} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis
                dataKey="week"
                interval="preserveStartEnd"
                minTickGap={16}
                tick={{ fill: CHART.tertiary, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={weeklyAxis.domain}
                ticks={weeklyAxis.ticks}
                tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
                tick={{ fill: CHART.tertiary, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={44}
              />
              <Tooltip
                contentStyle={chartTooltipStyle}
                cursor={{ fill: CHART.cursor }}
                formatter={(v) => (typeof v === 'number' ? [formatSteps(v), 'steps'] : v)}
              />
              <Bar dataKey="steps" fill={CHART.aerobicDim} stroke={CHART.aerobic} strokeOpacity={0.45} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {hasExplicitWalks && (
        <section className="walking-section" aria-labelledby="walking-sessions-title">
          <div className="walking-section-heading">
            <h2 id="walking-sessions-title">Tracked walks</h2>
            <p>
              Sessions with extra detail — explicit walk or hike workouts carry distance and heart
              rate, unlike passive daily steps above.
            </p>
          </div>
          <div className="walking-period-stats">
            <MetricCard
              eyebrow="Lifetime walks"
              value={String(lifetimeWalks.count)}
              caption={`${formatWalkDistance(lifetimeWalks.distanceKm)} · ${formatDurationHM(lifetimeWalks.durationS)}`}
            />
            <MetricCard
              eyebrow="This month"
              value={String(monthWalks.count)}
              caption={`${formatWalkDistance(monthWalks.distanceKm)} · ${formatDurationHM(monthWalks.durationS)}`}
            />
          </div>

          {walkTizBars.length > 0 && (
            <div className="zone2-grid walking-grid">
              <ChartCard
                title="Walking Zone 2"
                span={6}
                headerRight={<span className="walking-chart-unit">12 weeks · minutes</span>}
              >
                <WeeklyZ2Bars data={weeklyWalkZ2} />
              </ChartCard>
              <ChartCard
                title="Session intensity mix"
                span={6}
                headerRight={<span className="walking-chart-unit">last 15 · minutes</span>}
              >
                <TimeInZonesStacks data={walkTizBars} />
              </ChartCard>
            </div>
          )}

          <div className="chart-card--span-12">
            <RecentSessionsCard
              title="Recent walks"
              workouts={workouts}
              timezone={timezone}
              onOpenAll={() => onOpenSessions?.('Walking')}
            />
          </div>
        </section>
      )}
    </div>
  )
}
