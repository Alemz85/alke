// Cardio-fitness index trajectory: the nightly model's last 150 days as index
// line + honest confidence band. Fetches with the same query key/window as
// Zone2FitnessHeader, so the two share one cached response.
import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { scaleLinear, scaleTime } from 'd3-scale'
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useZone2FitnessRange } from '../hooks/useSessionsData'
import { addDays, todayYMD } from '../hooks/sessionsDate'
import { CHART, chartAxisTickSm, chartTooltipStyle } from '../lib/chartTheme'
import { zone2IndexValue, zone2TrajectorySnapshot } from '../lib/zone2Fitness'
import './Zone2Trajectory.css'

interface Props {
  timezone: string | null
  /**
   * Smaller footprint for the fitness-header slot (index card's neighbor):
   * shorter plot, fewer axis ticks. Same data + tooltip either way.
   */
  compact?: boolean
}

export function Zone2Trajectory({ timezone, compact = false }: Props): ReactElement {
  const today = useMemo(() => todayYMD(timezone), [timezone])
  const { fromDate, toDate } = useMemo(() => {
    const from = addDays(today, -150)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return {
      fromDate: `${from.year}-${pad(from.month)}-${pad(from.day)}`,
      toDate: `${today.year}-${pad(today.month)}-${pad(today.day)}`
    }
  }, [today])

  const fitnessQuery = useZone2FitnessRange(fromDate, toDate)

  const rows = useMemo(() => fitnessQuery.data ?? [], [fitnessQuery.data])
  const snapshot = useMemo(() => zone2TrajectorySnapshot(rows), [rows])
  const data = useMemo(
    () =>
      rows
        .map((r) => ({
          date: Date.parse(`${r.date}T00:00:00Z`),
          index: zone2IndexValue(r),
          band:
            r.durable_band_lo != null && r.durable_band_hi != null
              ? [
                  Math.min(r.durable_band_lo, r.durable_band_hi),
                  Math.max(r.durable_band_lo, r.durable_band_hi)
                ]
              : null
        }))
        .filter(
          (point): point is { date: number; index: number; band: [number, number] | null } =>
            Number.isFinite(point.date) && point.index != null && Number.isFinite(point.index)
        )
        .sort((a, b) => a.date - b.date),
    [rows]
  )

  if (data.length < 2 || snapshot == null) {
    return (
      <p className="z2traj-empty">
        The trajectory draws here once the nightly model has a few days of history.
      </p>
    )
  }

  const dateDomain = [new Date(data[0].date), new Date(data[data.length - 1].date)] as [Date, Date]
  const dateTicks = scaleTime()
    .domain(dateDomain)
    .ticks(compact ? 3 : 5)
    .map(Number)
  const visibleValues = data.flatMap((point) =>
    point.band == null ? [point.index] : [point.index, point.band[0], point.band[1]]
  )
  const yMin = Math.min(...visibleValues)
  const yMax = Math.max(...visibleValues)
  const yPadding = Math.max(3, (yMax - yMin) * 0.12)
  const yScale = scaleLinear()
    .domain([Math.max(0, yMin - yPadding), yMax + yPadding])
    .nice(compact ? 3 : 5)
  const yDomain = yScale.domain() as [number, number]
  const yTicks = yScale.ticks(compact ? 3 : 5)
  const roundedStart = Math.round(snapshot.start.value)
  const roundedNow = Math.round(snapshot.now.value)
  const roundedChange = Math.round(snapshot.change)
  const changeLabel = `${roundedChange > 0 ? '+' : ''}${roundedChange} since ${snapshot.sinceLabel}`
  const bandLabel = snapshot.currentBand
    ? `${Math.round(snapshot.currentBand.lo)}–${Math.round(snapshot.currentBand.hi)}`
    : 'Unavailable'

  const formatAxisDate = (timestamp: number): string =>
    new Date(timestamp).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
  const formatExactDate = (timestamp: number): string =>
    new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    })

  return (
    <div className={compact ? 'z2traj z2traj--compact' : 'z2traj'}>
      <div className="z2traj-snapshot">
        <span
          className="z2traj-current tabular-nums"
          aria-label={`Current cardio fitness index ${roundedNow}`}
        >
          {roundedNow}
        </span>
        <span
          className={
            roundedChange < 0
              ? 'z2traj-change z2traj-change--down tabular-nums'
              : 'z2traj-change tabular-nums'
          }
        >
          {changeLabel}
        </span>
      </div>

      <div className="z2traj-plot">
        <ResponsiveContainer width="100%" height="100%" minHeight={compact ? 132 : undefined}>
          <ComposedChart data={data} margin={{ top: 8, right: 5, bottom: 0, left: -22 }}>
            <XAxis
              dataKey="date"
              type="number"
              scale="time"
              domain={[data[0].date, data[data.length - 1].date]}
              ticks={dateTicks}
              tickFormatter={formatAxisDate}
              tick={chartAxisTickSm}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={yDomain}
              ticks={yTicks}
              tick={chartAxisTickSm}
              axisLine={false}
              tickLine={false}
              width={compact ? 24 : undefined}
              tickCount={compact ? 3 : undefined}
            />
            <Tooltip
              contentStyle={chartTooltipStyle}
              labelFormatter={(label) => formatExactDate(Number(label))}
              formatter={(v, name) =>
                name === 'band'
                  ? [
                      Array.isArray(v)
                        ? `${Math.round(Number(v[0]))}–${Math.round(Number(v[1]))}`
                        : v,
                      'band'
                    ]
                  : [typeof v === 'number' ? Math.round(v) : v, 'index']
              }
            />
            <Area dataKey="band" stroke="none" fill={CHART.aerobicDim} isAnimationActive={false} />
            <Line
              dataKey="index"
              stroke={CHART.aerobic}
              strokeWidth={1.5}
              dot={false}
              type="monotone"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <dl className="z2traj-anchors">
        <div className="z2traj-anchor">
          <dt>Start</dt>
          <dd className="tabular-nums">{roundedStart}</dd>
        </div>
        <div className="z2traj-anchor z2traj-anchor--now">
          <dt>Now</dt>
          <dd className="tabular-nums">{roundedNow}</dd>
        </div>
        <div className="z2traj-anchor z2traj-anchor--band">
          <dt>Current band</dt>
          <dd className="tabular-nums">{bandLabel}</dd>
        </div>
      </dl>
      {!compact && (
        <p className="z2traj-caption">
          Line is the index; the shaded band is its honest uncertainty. Direction matters more than
          the number.
        </p>
      )}
    </div>
  )
}
