import { useMemo, type ReactElement } from 'react'
import { extent } from 'd3-array'
import { scaleTime } from 'd3-scale'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { Workout } from '@shared/types'
import { ChartCard, EmptyState, MetricCard, RecentSessionsCard } from '../components'
import { addDays, isoWeekKey, isoWeekStart, localDateKey, toZonedYMD } from '../hooks/sessionsDate'
import { CHART, chartTooltipStyle } from '../lib/chartTheme'
import { buildNumericAxis } from '../lib/cardioChartScales'
import { EM_DASH, formatClock, formatDurationHM } from '../lib/format'
import {
  bestRunAtLeast,
  longestRun,
  monthlyRunningStats,
  monthlyRunningTotals,
  runningLifetime,
  yearlyRunningTotals,
  type PeriodRunningTotals,
  type RunBenchmark
} from '../lib/runningStats'
import './RunningView.css'

interface RunningViewProps {
  workouts: Workout[]
  timezone: string | null
  /** Jump to the Sessions tab, optionally pre-filtered to an activity group. */
  onOpenSessions?: (activity?: string) => void
}

interface ZoneBar {
  date: string
  z1: number
  z2: number
  z3: number
  z4: number
  z5: number
}

const ZONE_FILLS = [
  'var(--color-zone1)',
  'var(--color-zone2)',
  'var(--color-zone3)',
  'var(--color-zone4)',
  'var(--color-zone5)'
]

function z2Seconds(workout: Workout): number {
  const zones = workout.computed?.time_in_zones as Record<string, number> | null | undefined
  return typeof zones?.z2 === 'number' ? zones.z2 : 0
}

function weeklyRunningZ2(
  workouts: Workout[],
  timezone: string | null,
  count = 12
): { week: string; minutes: number }[] {
  const totals = new Map<string, number>()
  for (const workout of workouts) {
    const key = isoWeekKey(toZonedYMD(workout.start_at, timezone))
    totals.set(key, (totals.get(key) ?? 0) + z2Seconds(workout))
  }
  const monday = isoWeekStart(toZonedYMD(new Date().toISOString(), timezone))
  return Array.from({ length: count }, (_, index) => {
    const key = isoWeekKey(addDays(monday, -7 * (count - 1 - index)))
    return { week: key.slice(6), minutes: Math.round((totals.get(key) ?? 0) / 60) }
  })
}

function runningZoneBars(workouts: Workout[], timezone: string | null): ZoneBar[] {
  return workouts
    .filter((workout) => workout.computed?.time_in_zones != null)
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .slice(-15)
    .map((workout) => {
      const zones = workout.computed!.time_in_zones as Record<string, number>
      return {
        date: localDateKey(workout.start_at, timezone).slice(5),
        z1: Math.round((zones.z1 ?? 0) / 60),
        z2: Math.round((zones.z2 ?? 0) / 60),
        z3: Math.round((zones.z3 ?? 0) / 60),
        z4: Math.round((zones.z4 ?? 0) / 60),
        z5: Math.round((zones.z5 ?? 0) / 60)
      }
    })
}

function formatDate(iso: string, timezone: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timezone || 'UTC'
  }).format(new Date(iso))
}

function formatDistance(km: number): string {
  return km >= 1000 ? `${Math.round(km).toLocaleString('en-US')} km` : `${km.toFixed(1)} km`
}

function Benchmark({
  label,
  result,
  timezone
}: {
  label: string
  result: RunBenchmark | null
  timezone: string | null
}): ReactElement {
  return (
    <MetricCard
      eyebrow={label}
      value={result ? `${formatClock(result.paceSecPerKm)} /km` : EM_DASH}
      domain="aerobic"
      caption={
        result
          ? `${((result.workout.distance_m ?? 0) / 1000).toFixed(1)} km · ${formatDate(result.workout.start_at, timezone)}`
          : undefined
      }
    />
  )
}

function PeriodStats({
  label,
  totals
}: {
  label: string
  totals: PeriodRunningTotals
}): ReactElement {
  return (
    <div className="running-period-summary">
      <span className="running-period-label">{label}</span>
      <div className="running-period-facts">
        <div>
          <span>Distance</span>
          <strong>{formatDistance(totals.distanceKm)}</strong>
        </div>
        <div>
          <span>Runs</span>
          <strong>{totals.runs}</strong>
        </div>
        <div>
          <span>Time</span>
          <strong>{formatDurationHM(totals.durationS)}</strong>
        </div>
        <div>
          <span>Avg pace</span>
          <strong>
            {totals.paceSecPerKm != null ? `${formatClock(totals.paceSecPerKm)} /km` : EM_DASH}
          </strong>
        </div>
      </div>
    </div>
  )
}

function RunningChartKey({
  items
}: {
  items: Array<{ label: string; variant?: 'line' | 'bar' | 'dashed' }>
}): ReactElement {
  return (
    <div className="running-chart-key" aria-label="Chart legend">
      {items.map((item) => (
        <span key={item.label}>
          <i
            className={`running-chart-key-swatch running-chart-key-swatch--${item.variant ?? 'line'}`}
          />
          {item.label}
        </span>
      ))}
    </div>
  )
}

export function RunningView({
  workouts,
  timezone,
  onOpenSessions
}: RunningViewProps): ReactElement {
  const lifetime = useMemo(() => runningLifetime(workouts), [workouts])
  const thisMonth = useMemo(() => monthlyRunningTotals(workouts, timezone), [workouts, timezone])
  const thisYear = useMemo(() => yearlyRunningTotals(workouts, timezone), [workouts, timezone])
  const best1k = useMemo(() => bestRunAtLeast(workouts, 1000), [workouts])
  const best5k = useMemo(() => bestRunAtLeast(workouts, 5000), [workouts])
  const best10k = useMemo(() => bestRunAtLeast(workouts, 10_000), [workouts])
  const longest = useMemo(() => longestRun(workouts), [workouts])
  const monthly = useMemo(() => monthlyRunningStats(workouts, timezone), [workouts, timezone])

  const monthlyChart = useMemo(
    () => monthly.map((row) => ({ ...row, monthMs: Date.parse(`${row.month}-01T00:00:00Z`) })),
    [monthly]
  )
  const monthExtent = extent(monthlyChart, (row) => row.monthMs)
  const xDomain: [number, number] =
    monthExtent[0] == null || monthExtent[1] == null
      ? [0, 1]
      : monthExtent[0] === monthExtent[1]
        ? [monthExtent[0] - 15 * 86400_000, monthExtent[1] + 15 * 86400_000]
        : [monthExtent[0], monthExtent[1]]
  const monthTicks = scaleTime()
    .domain(xDomain.map((value) => new Date(value)) as [Date, Date])
    .ticks(Math.min(6, Math.max(2, monthly.length)))
    .map(Number)

  const paceValues = monthlyChart
    .map((row) => row.paceSecPerKm)
    .filter((pace): pace is number => pace != null)
  const distanceAxis = buildNumericAxis(
    monthlyChart.map((row) => row.distanceKm),
    {
      includeZero: true,
      tickCount: 4
    }
  )
  const paceAxis = buildNumericAxis(paceValues, { tickCount: 4 })

  const zoneWorkouts = useMemo(
    () => workouts.filter((workout) => workout.computed?.time_in_zones != null),
    [workouts]
  )
  const weeklyZ2 = useMemo(() => weeklyRunningZ2(zoneWorkouts, timezone), [zoneWorkouts, timezone])
  const zoneBars = useMemo(() => runningZoneBars(zoneWorkouts, timezone), [zoneWorkouts, timezone])
  const weeklyZ2Axis = buildNumericAxis(
    weeklyZ2.map((row) => row.minutes),
    {
      includeZero: true,
      tickCount: 4
    }
  )
  const zoneMinutesAxis = buildNumericAxis(
    zoneBars.map((row) => row.z1 + row.z2 + row.z3 + row.z4 + row.z5),
    { includeZero: true, tickCount: 4 }
  )

  return (
    <div className="running-view" role="tabpanel" aria-label="Running">
      <section className="running-overview" aria-label="Running overview">
        <div className="running-overview-top">
          <div className="running-lifetime-intro">
            <span className="running-section-kicker">Lifetime distance</span>
            <strong className="running-lifetime-distance tabular-nums">
              {formatDistance(lifetime.distanceKm)}
            </strong>
            <span className="running-lifetime-caption">Across every recorded run</span>
          </div>
          <div className="running-lifetime-facts">
            <div className="running-lifetime-fact">
              <span>Runs</span>
              <strong className="tabular-nums">{lifetime.runs}</strong>
            </div>
            <div className="running-lifetime-fact">
              <span>Elapsed time</span>
              <strong className="tabular-nums">{formatDurationHM(lifetime.durationS)}</strong>
            </div>
            <div className="running-lifetime-fact">
              <span>Longest run</span>
              <strong className="tabular-nums">
                {longest ? formatDistance(longest.distanceKm) : EM_DASH}
              </strong>
            </div>
          </div>
        </div>
        <div className="running-period-grid">
          <PeriodStats label="This month" totals={thisMonth} />
          <PeriodStats label="This year" totals={thisYear} />
        </div>
      </section>

      <section className="running-section" aria-labelledby="running-performance-title">
        <div className="running-section-heading">
          <h2 id="running-performance-title">Pace</h2>
          <p>Best whole-run pace at useful distance, followed by volume and pace over time.</p>
        </div>
        <div className="running-period-stats running-period-stats--pace">
          <Benchmark label="1 km+ benchmark" result={best1k} timezone={timezone} />
          <Benchmark label="5 km+ benchmark" result={best5k} timezone={timezone} />
          <Benchmark label="10 km+ benchmark" result={best10k} timezone={timezone} />
        </div>

        <ChartCard
          title="Monthly distance and pace"
          span={12}
          headerRight={
            <RunningChartKey
              items={[{ label: 'Distance', variant: 'bar' }, { label: 'Avg pace' }]}
            />
          }
        >
          {monthlyChart.length === 0 ? (
            <EmptyState message="No runs with distance and duration yet." />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart
                  data={monthlyChart}
                  margin={{ top: 8, right: 8, left: -8, bottom: 0 }}
                >
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis
                    dataKey="monthMs"
                    type="number"
                    scale="time"
                    domain={xDomain}
                    ticks={monthTicks}
                    tickFormatter={(value: number) =>
                      new Date(value).toLocaleDateString('en-US', {
                        month: 'short',
                        year: '2-digit',
                        timeZone: 'UTC'
                      })
                    }
                    tick={{ fill: CHART.tertiary, fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="distance"
                    domain={distanceAxis.domain}
                    ticks={distanceAxis.ticks}
                    tickFormatter={(value: number) => `${value} km`}
                    tick={{ fill: CHART.tertiary, fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <YAxis
                    yAxisId="pace"
                    orientation="right"
                    reversed
                    domain={paceAxis.domain}
                    ticks={paceAxis.ticks}
                    tickFormatter={(value: number) => formatClock(value)}
                    tick={{ fill: CHART.tertiary, fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    labelFormatter={(value) =>
                      new Date(Number(value)).toLocaleDateString('en-US', {
                        month: 'long',
                        year: 'numeric',
                        timeZone: 'UTC'
                      })
                    }
                    formatter={(value, name) => {
                      if (typeof value !== 'number') return value
                      return name === 'paceSecPerKm'
                        ? [`${formatClock(value)} /km`, 'average pace']
                        : [`${value.toFixed(1)} km`, 'distance']
                    }}
                  />
                  <Bar
                    yAxisId="distance"
                    dataKey="distanceKm"
                    fill={CHART.aerobicDim}
                    stroke={CHART.aerobic}
                    strokeOpacity={0.45}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={28}
                  />
                  <Line
                    yAxisId="pace"
                    dataKey="paceSecPerKm"
                    stroke={CHART.aerobic}
                    strokeWidth={2}
                    dot={false}
                    type="monotone"
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="running-caption">
                Pace uses the right axis and is inverted, so higher on the chart means faster.
              </p>
            </>
          )}
        </ChartCard>
      </section>

      <section className="running-section" aria-labelledby="running-training-title">
        <div className="running-section-heading">
          <h2 id="running-training-title">Heart rate</h2>
          <p>How much easy aerobic work you accumulate, and where each tracked run was spent.</p>
        </div>
        {zoneWorkouts.length === 0 ? (
          <div className="running-hr-pending">
            <strong>No heart-rate runs yet</strong>
            <span>
              Future tracked runs will add weekly Zone 2 volume and per-session zone distribution
              here.
            </span>
          </div>
        ) : (
          <div className="running-training-grid">
            <ChartCard
              title="Weekly Zone 2"
              span={6}
              headerRight={<span className="running-chart-unit">minutes</span>}
            >
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={weeklyZ2} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
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
                    domain={weeklyZ2Axis.domain}
                    ticks={weeklyZ2Axis.ticks}
                    tick={{ fill: CHART.tertiary, fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    width={42}
                  />
                  <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: CHART.cursor }} />
                  <Bar
                    dataKey="minutes"
                    fill={CHART.aerobic}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={40}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard
              title="Session intensity mix"
              span={6}
              headerRight={<span className="running-chart-unit">last 15 · minutes</span>}
            >
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={zoneBars} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis
                    dataKey="date"
                    interval="preserveStartEnd"
                    minTickGap={16}
                    tick={{ fill: CHART.tertiary, fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={zoneMinutesAxis.domain}
                    ticks={zoneMinutesAxis.ticks}
                    tick={{ fill: CHART.tertiary, fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    width={42}
                  />
                  <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: CHART.cursor }} />
                  {(['z1', 'z2', 'z3', 'z4', 'z5'] as const).map((zone, index) => (
                    <Bar
                      key={zone}
                      dataKey={zone}
                      stackId="zones"
                      fill={ZONE_FILLS[index]}
                      maxBarSize={32}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        )}

        <RecentSessionsCard
          title="Recent runs"
          workouts={workouts}
          timezone={timezone}
          limit={5}
          onOpenAll={() => onOpenSessions?.('Running')}
        />
      </section>
    </div>
  )
}
