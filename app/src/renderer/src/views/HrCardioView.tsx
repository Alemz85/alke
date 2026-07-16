import { useMemo, type ReactElement } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { Workout } from '@shared/types'
import { ChartCard, EmptyState, RecentSessionsCard } from '../components'
import { HeroNumber } from '../components/HeroNumber'
import { CHART, chartTooltipStyle } from '../lib/chartTheme'
import { buildNumericAxis } from '../lib/cardioChartScales'
import { EM_DASH, formatDurationHM } from '../lib/format'
import {
  avgHrByMonth,
  lifetimeCardioStats,
  monthlyCardioTotals,
  yearlyCardioTotals,
  type PeriodCardioTotals
} from '../lib/hrCardioStats'
import { hasZones, tizRows, weeklyZ2, TimeInZonesStacks, WeeklyZ2Bars } from './Zone2View'
import './HrCardioView.css'

interface HrCardioViewProps {
  modalityKey: 'cycling' | 'rowing'
  label: string
  workouts: Workout[]
  timezone: string | null
  onOpenSessions?: (activity?: string) => void
}

const MONTH_SHORT_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

function monthTick(ym: string): string {
  const [, m] = ym.split('-').map(Number)
  return MONTH_SHORT_NAMES[m - 1]
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTH_SHORT_NAMES[m - 1]} ${y}`
}

function PeriodStats({ label, totals }: { label: string; totals: PeriodCardioTotals }): ReactElement {
  return (
    <div className="hr-cardio-period-summary">
      <span className="hr-cardio-period-label">{label}</span>
      <div className="hr-cardio-period-facts">
        <div>
          <span>Sessions</span>
          <strong>{totals.sessions}</strong>
        </div>
        <div>
          <span>Time</span>
          <strong>{formatDurationHM(totals.durationS)}</strong>
        </div>
        <div>
          <span>Avg HR</span>
          <strong>{totals.avgHr != null ? `${Math.round(totals.avgHr)} bpm` : EM_DASH}</strong>
        </div>
        <div>
          <span>Energy</span>
          <strong>{totals.energyKcal > 0 ? `${Math.round(totals.energyKcal)} kcal` : EM_DASH}</strong>
        </div>
      </div>
    </div>
  )
}

export function HrCardioView({
  modalityKey,
  label,
  workouts,
  timezone,
  onOpenSessions
}: HrCardioViewProps): ReactElement {
  const lifetime = useMemo(() => lifetimeCardioStats(workouts), [workouts])
  const thisMonth = useMemo(() => monthlyCardioTotals(workouts, timezone), [workouts, timezone])
  const thisYear = useMemo(() => yearlyCardioTotals(workouts, timezone), [workouts, timezone])
  const monthlyHr = useMemo(() => avgHrByMonth(workouts, timezone), [workouts, timezone])

  const hrAxis = buildNumericAxis(
    monthlyHr.map((row) => row.avgHr),
    { tickCount: 4 }
  )

  const zonedWorkouts = useMemo(() => workouts.filter(hasZones), [workouts])
  const weeklyMinutes = useMemo(() => weeklyZ2(zonedWorkouts, timezone, 12), [zonedWorkouts, timezone])
  const tizBars = useMemo(() => tizRows(zonedWorkouts, timezone, 15), [zonedWorkouts, timezone])

  if (lifetime.sessions === 0) {
    return <EmptyState message={`No ${label.toLowerCase()} sessions recorded yet.`} />
  }

  return (
    <div className="hr-cardio-view" data-modality={modalityKey} role="tabpanel" aria-label={label}>
      <section className="hr-cardio-overview" aria-label={`${label} overview`}>
        <div className="hr-cardio-overview-top">
          <div className="hr-cardio-lifetime-intro">
            <span className="hr-cardio-section-kicker">Lifetime {label.toLowerCase()}</span>
            <HeroNumber
              value={lifetime.durationS}
              format={formatDurationHM}
              className="hr-cardio-lifetime-value"
            />
            <span className="hr-cardio-lifetime-caption">
              Across {lifetime.sessions} recorded session{lifetime.sessions === 1 ? '' : 's'}
            </span>
          </div>
          <div className="hr-cardio-lifetime-facts">
            <div className="hr-cardio-lifetime-fact">
              <span>Sessions</span>
              <strong className="tabular-nums">{lifetime.sessions}</strong>
            </div>
            <div className="hr-cardio-lifetime-fact">
              <span>Energy</span>
              <strong className="tabular-nums">
                {lifetime.energyKcal > 0 ? `${Math.round(lifetime.energyKcal)} kcal` : EM_DASH}
              </strong>
            </div>
          </div>
        </div>
        <div className="hr-cardio-period-grid">
          <PeriodStats label="This month" totals={thisMonth} />
          <PeriodStats label="This year" totals={thisYear} />
        </div>
      </section>

      <div className="zone2-grid">
        <ChartCard
          title="Average HR by month"
          span={12}
          headerRight={<span className="hr-cardio-chart-unit">bpm</span>}
        >
          {monthlyHr.filter((row) => row.avgHr != null).length === 0 ? (
            <EmptyState message={`No heart-rate data for ${label.toLowerCase()} yet.`} />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={monthlyHr} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis
                    dataKey="month"
                    interval="preserveStartEnd"
                    minTickGap={24}
                    tickFormatter={monthTick}
                    tick={{ fill: CHART.tertiary, fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={hrAxis.domain}
                    ticks={hrAxis.ticks}
                    tick={{ fill: CHART.tertiary, fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    labelFormatter={(value) => monthLabel(String(value))}
                    formatter={(v) => (typeof v === 'number' ? [`${Math.round(v)} bpm`, 'avg HR'] : v)}
                  />
                  <Line
                    dataKey="avgHr"
                    stroke={CHART.aerobic}
                    strokeWidth={2.25}
                    dot={{ r: 3 }}
                    type="monotone"
                    connectNulls
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
              <p className="zone2-caption">
                Duration-weighted average heart rate per calendar month. Months with sessions but
                no HR data are left blank rather than plotted as zero.
              </p>
            </>
          )}
        </ChartCard>

        <ChartCard title="Efficiency factor" span={12}>
          <p className="zone2-ef-explainer">
            EF needs a reliable output signal (distance). {label} sessions don&apos;t carry one —
            zones and duration still count toward your aerobic base. If distance starts being
            logged for {label.toLowerCase()}, pace and EF switch on here.
          </p>
        </ChartCard>

        <ChartCard
          title="Weekly Zone 2"
          span={6}
          headerRight={<span className="hr-cardio-chart-unit">12 weeks · minutes</span>}
        >
          {weeklyMinutes.every((w) => w.minutes === 0) ? (
            <EmptyState message={`No ${label.toLowerCase()} Zone 2 minutes in the last 12 weeks yet.`} />
          ) : (
            <WeeklyZ2Bars data={weeklyMinutes} />
          )}
        </ChartCard>

        <ChartCard
          title="Session intensity mix"
          span={6}
          headerRight={<span className="hr-cardio-chart-unit">last 15 · minutes</span>}
        >
          {tizBars.length === 0 ? (
            <EmptyState message={`No ${label.toLowerCase()} sessions with zone data yet.`} />
          ) : (
            <TimeInZonesStacks data={tizBars} />
          )}
        </ChartCard>

        <div className="chart-card--span-12">
          <RecentSessionsCard
            title={`Recent ${label.toLowerCase()} sessions`}
            workouts={workouts}
            timezone={timezone}
            onOpenAll={() => onOpenSessions?.(label)}
          />
        </div>
      </div>
    </div>
  )
}
