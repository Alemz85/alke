import { useMemo, useState, type ReactElement } from 'react'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis
} from 'recharts'
import { TabHeader } from './TabHeader'
import { ChartCard, ChipFilter, EmptyState, FlagBanner, HeroMetric, MetricCard } from '../components'
import type { ChipRange } from '../components'
import {
  RANGE_DAYS,
  useRecoveryComputedDaily,
  useRecoveryDailyMetrics,
  useRecoveryTodayFlags,
  useRecoveryUserConfig
} from '../hooks/useRecoveryData'
import {
  buildWeightSeries,
  bucketAggregate,
  daysAgo,
  fmtBucketLabel,
  fmtClockTime,
  fmtHoursAsHm,
  fmtHoursMinutes,
  fmtLocalDate,
  granularityForDays,
  mean,
  readStageHours,
  rollingAverage,
  sliceLastNDays,
  sortByDate,
  weeklyMedianByDate,
  EM_DASH
} from './recoveryUtils'
import './RecoveryView.css'

const AXIS_TICK = { fontSize: 12, fill: 'var(--color-text-tertiary)' }
const AXIS_LINE = { stroke: 'var(--color-divider-soft)' }
const TOOLTIP_STYLE = {
  background: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 'var(--radius-md)',
  fontSize: 13
}
const TOOLTIP_LABEL_STYLE = { color: 'var(--color-text-secondary)' }
const TOOLTIP_ITEM_STYLE = { fontVariantNumeric: 'tabular-nums' as const }

export function RecoveryView(): ReactElement {
  const [sleepRange, setSleepRange] = useState<ChipRange>('30d')
  const [rhrRange, setRhrRange] = useState<ChipRange>('90d')
  const [hrvRange, setHrvRange] = useState<ChipRange>('90d')
  const [respRange, setRespRange] = useState<ChipRange>('90d')
  // Weight is sparse — short ranges are useless, so only 90d/1y, default 1y.
  const [weightRange, setWeightRange] = useState<ChipRange>('1y')

  const userConfigQuery = useRecoveryUserConfig()
  const flagsQuery = useRecoveryTodayFlags()

  // Fetch the widest window any chart on this tab needs (1y for VO2max), then
  // slice client-side per chart's active range — avoids duplicate queries.
  const dailyMetricsQuery = useRecoveryDailyMetrics(RANGE_DAYS['1y'])
  const computedDailyQuery = useRecoveryComputedDaily(RANGE_DAYS['1y'])

  const timezone = userConfigQuery.data?.timezone ?? undefined
  const flags = flagsQuery.data ?? []

  const allMetrics = useMemo(() => sortByDate(dailyMetricsQuery.data ?? []), [dailyMetricsQuery.data])
  const allComputed = useMemo(
    () => [...(computedDailyQuery.data ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [computedDailyQuery.data]
  )

  // --- Hero: last night's sleep ---
  const latestSleepRow = [...allMetrics].reverse().find((m) => m.sleep_duration_min !== null)
  const latestSleepMinutes = latestSleepRow?.sleep_duration_min ?? null
  const latestSleepAge = latestSleepRow ? daysAgo(latestSleepRow.date) : null

  const last7dSleepRows = latestSleepRow
    ? sliceLastNDays(
        allMetrics.filter((m) => m.date <= latestSleepRow.date),
        7
      )
    : []
  const avg7dSleep = mean(last7dSleepRows.map((m) => m.sleep_duration_min))
  const sleepDeltaMin =
    latestSleepMinutes !== null && avg7dSleep !== null ? latestSleepMinutes - avg7dSleep : null

  let heroCaption: string | undefined
  if (latestSleepMinutes === null || !latestSleepRow) {
    heroCaption = undefined
  } else {
    const deltaPart =
      sleepDeltaMin === null
        ? '7-day average —'
        : `${sleepDeltaMin >= 0 ? '+' : ''}${Math.round(sleepDeltaMin)}m vs 7-day average`
    const agePart =
      latestSleepAge !== null && latestSleepAge > 1
        ? ` · from ${fmtLocalDate(latestSleepRow.date, timezone)}`
        : ''
    heroCaption = `${deltaPart}${agePart}`
  }

  // --- Sleep chart data ---
  // Short windows plot daily bars + a 7d rolling-avg line; long windows (90d/1y)
  // collapse into weekly/monthly average bars so the trend isn't lost in noise.
  const sleepDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[sleepRange])
  const sleepGran = granularityForDays(RANGE_DAYS[sleepRange])
  const sleepRollingAvg = rollingAverage(allMetrics, 'sleep_duration_min')
  const sleepChartData =
    sleepGran === 'daily'
      ? sleepDaysWindow.map((r) => ({
          date: r.date,
          hours: r.sleep_duration_min === null ? null : r.sleep_duration_min / 60,
          avgHours: sleepRollingAvg.has(r.date) ? (sleepRollingAvg.get(r.date) as number) / 60 : null
        }))
      : bucketAggregate(sleepDaysWindow, 'sleep_duration_min', sleepGran, 'mean').map((b) => ({
          date: b.date,
          hours: b.value === null ? null : b.value / 60,
          avgHours: null as number | null
        }))
  const hasSleepData = sleepChartData.some((d) => d.hours !== null)
  const sleepBarLabel =
    sleepGran === 'weekly' ? 'Weekly avg' : sleepGran === 'monthly' ? 'Monthly avg' : 'Sleep'

  // Bedtime / wake for the most recent night with a recorded sleep window.
  const latestBedtime = fmtClockTime(latestSleepRow?.sleep_start, timezone)
  const latestWake = fmtClockTime(latestSleepRow?.sleep_end, timezone)
  const hasBedtime = Boolean(latestSleepRow?.sleep_start || latestSleepRow?.sleep_end)

  const latestStages =
    latestSleepRow?.sleep_stages && typeof latestSleepRow.sleep_stages === 'object'
      ? (latestSleepRow.sleep_stages as Record<string, unknown>)
      : null
  const deepH = readStageHours(latestStages, 'deep')
  const coreH = readStageHours(latestStages, 'core')
  const remH = readStageHours(latestStages, 'rem')
  const awakeH = readStageHours(latestStages, 'awake')
  const hasStageLegend = latestStages !== null && [deepH, coreH, remH, awakeH].some((v) => v !== null)

  // --- RHR chart data ---
  const rhrDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[rhrRange])
  const rhrGran = granularityForDays(RANGE_DAYS[rhrRange])
  const computedByDate = new Map(allComputed.map((c) => [c.date, c]))
  // Baseline band: a +/-3bpm corridor around the 60d baseline. Renders as a
  // shaded Area once computed_daily.rhr_baseline_60d is populated by the
  // nightly job; while that column is empty (current phase) baseline is null
  // for every row and the Area contributes nothing to the chart. The band is a
  // daily-only overlay — at weekly/monthly granularity we plot bucket means.
  const BASELINE_BAND_BPM = 3
  const rhrChartData =
    rhrGran === 'daily'
      ? rhrDaysWindow.map((r) => {
          const computed = computedByDate.get(r.date)
          const baseline = computed?.rhr_baseline_60d ?? null
          return {
            date: r.date,
            rhr: r.resting_hr,
            baselineLow: baseline === null ? null : baseline - BASELINE_BAND_BPM,
            baselineBand: baseline === null ? null : BASELINE_BAND_BPM * 2
          }
        })
      : bucketAggregate(rhrDaysWindow, 'resting_hr', rhrGran, 'mean').map((b) => ({
          date: b.date,
          rhr: b.value,
          baselineLow: null as number | null,
          baselineBand: null as number | null
        }))
  const hasRhrData = rhrChartData.some((d) => d.rhr !== null)
  const hasRhrBaseline = rhrChartData.some((d) => d.baselineLow !== null)
  const rhrLineLabel =
    rhrGran === 'weekly' ? 'Weekly avg' : rhrGran === 'monthly' ? 'Monthly avg' : 'RHR'

  // --- HRV chart data (dots + median line; HRV is noisy so we lead with median) ---
  const hrvDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[hrvRange])
  const hrvGran = granularityForDays(RANGE_DAYS[hrvRange])
  const hrvWeeklyMedian = weeklyMedianByDate(hrvDaysWindow, 'hrv_sdnn_ms')
  const hrvChartData =
    hrvGran === 'daily'
      ? hrvDaysWindow.map((r) => ({
          date: r.date,
          hrv: r.hrv_sdnn_ms,
          weeklyMedian: hrvWeeklyMedian.get(r.date) ?? null
        }))
      : bucketAggregate(hrvDaysWindow, 'hrv_sdnn_ms', hrvGran, 'median').map((b) => ({
          date: b.date,
          hrv: null as number | null,
          weeklyMedian: b.value
        }))
  const hasHrvData = hrvChartData.some((d) => d.hrv !== null || d.weeklyMedian !== null)
  const hrvMedianLabel =
    hrvGran === 'weekly'
      ? 'Weekly median'
      : hrvGran === 'monthly'
        ? 'Monthly median'
        : 'Weekly median'

  // --- Respiratory rate chart data (dots + 7d rolling avg line) ---
  const respDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[respRange])
  const respGran = granularityForDays(RANGE_DAYS[respRange])
  const respRollingAvg = rollingAverage(allMetrics, 'respiratory_rate')
  const respChartData =
    respGran === 'daily'
      ? respDaysWindow.map((r) => ({
          date: r.date,
          resp: r.respiratory_rate,
          avgResp: respRollingAvg.has(r.date) ? (respRollingAvg.get(r.date) as number) : null
        }))
      : bucketAggregate(respDaysWindow, 'respiratory_rate', respGran, 'mean').map((b) => ({
          date: b.date,
          resp: null as number | null,
          avgResp: b.value
        }))
  const hasRespData = respChartData.some((d) => d.resp !== null || d.avgResp !== null)
  const respLineLabel =
    respGran === 'weekly' ? 'Weekly avg' : respGran === 'monthly' ? 'Monthly avg' : '7d avg'

  // --- VO2max sparse scatter (1y) ---
  const vo2Window = sliceLastNDays(allMetrics, RANGE_DAYS['1y'])
  const vo2ChartData = vo2Window
    .filter((r) => r.vo2max !== null)
    .map((r) => ({ date: r.date, vo2max: r.vo2max as number }))
  const hasVo2Data = vo2ChartData.length > 0

  // --- Wrist temperature: only render the card if any non-null values exist ---
  const hasWristTempData = allMetrics.some((r) => r.wrist_temp_deviation_c !== null)
  const wristTempWindow = sliceLastNDays(allMetrics, RANGE_DAYS['30d'])
  const wristTempChartData = wristTempWindow.map((r) => ({
    date: r.date,
    dev: r.wrist_temp_deviation_c
  }))

  // --- Body weight: sparse scatter + 7-day-bridged trend line ---
  const weightWindow = sliceLastNDays(allMetrics, RANGE_DAYS[weightRange])
  const weightChartData = buildWeightSeries(weightWindow)
  const hasWeightData = weightChartData.length > 0

  return (
    <div className="view">
      <TabHeader eyebrow="Sleep & readiness" title="Recovery" />

      {flags.length > 0 && (
        <div className="recovery-flags">
          {flags.map((flag, i) => (
            <FlagBanner key={`${flag.type}-${i}`} message={flag.message} severity={flag.severity === 'info' ? 'info' : 'warn'} />
          ))}
        </div>
      )}

      <HeroMetric
        eyebrow="RECOVERY · LAST NIGHT"
        value={latestSleepMinutes === null ? EM_DASH : fmtHoursMinutes(latestSleepMinutes)}
        delta={heroCaption}
        deltaPositive={sleepDeltaMin !== null && sleepDeltaMin >= 0}
        domain="recovery"
      />

      <div className="recovery-grid">
        <div className="recovery-grid--span-12">
          <ChartCard
            title="Sleep duration"
            span={12}
            headerRight={<ChipFilter value={sleepRange} onChange={setSleepRange} options={['7d', '30d', '90d', '1y']} />}
          >
            {hasSleepData ? (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={sleepChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-divider-soft)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={false}
                      minTickGap={32}
                      tickFormatter={(d: string) => fmtBucketLabel(d, sleepGran, timezone)}
                    />
                    <YAxis
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={32}
                      label={{ value: 'h', position: 'insideTopLeft', fill: 'var(--color-text-tertiary)', fontSize: 12 }}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      itemStyle={TOOLTIP_ITEM_STYLE}
                      labelFormatter={(d: string) => fmtBucketLabel(d, sleepGran, timezone)}
                      formatter={(value: number, name: string) => [
                        `${value.toFixed(1)}h`,
                        name === 'avgHours' ? '7d avg' : sleepBarLabel
                      ]}
                    />
                    <Bar
                      dataKey="hours"
                      name="hours"
                      fill="var(--color-recovery-dim)"
                      stroke="var(--color-recovery)"
                      strokeWidth={1}
                      radius={[2, 2, 0, 0]}
                    />
                    {sleepGran === 'daily' && (
                      <Line
                        type="monotone"
                        dataKey="avgHours"
                        name="avgHours"
                        stroke="var(--color-recovery)"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
                {hasBedtime && (
                  <p className="recovery-chart-caption">
                    Last night · asleep {latestBedtime} → awake {latestWake}
                  </p>
                )}
                {hasStageLegend && (
                  <div className="recovery-stage-legend">
                    <span className="recovery-stage-legend-item">
                      Deep <span className="tabular-nums">{fmtHoursAsHm(deepH)}</span>
                    </span>
                    <span className="recovery-stage-legend-item">
                      Core <span className="tabular-nums">{fmtHoursAsHm(coreH)}</span>
                    </span>
                    <span className="recovery-stage-legend-item">
                      REM <span className="tabular-nums">{fmtHoursAsHm(remH)}</span>
                    </span>
                    <span className="recovery-stage-legend-item">
                      Awake <span className="tabular-nums">{fmtHoursAsHm(awakeH)}</span>
                    </span>
                  </div>
                )}
              </>
            ) : (
              <EmptyState message="No sleep data in this range yet — nightly sleep duration will chart here once Apple Health exports sleep sessions." />
            )}
          </ChartCard>
        </div>

        <div className="recovery-grid--span-6">
          <ChartCard
            title="Resting heart rate"
            span={6}
            headerRight={<ChipFilter value={rhrRange} onChange={setRhrRange} options={['30d', '90d', '1y']} />}
          >
            {hasRhrData ? (
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={rhrChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--color-divider-soft)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={false}
                    minTickGap={32}
                    tickFormatter={(d: string) => fmtBucketLabel(d, rhrGran, timezone)}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    axisLine={false}
                    tickLine={false}
                    width={32}
                    domain={['auto', 'auto']}
                    // Bucket means produce fractional ticks ("65.55") that clip at
                    // this width — whole bpm is all the precision RHR carries anyway.
                    tickFormatter={(v: number) => v.toFixed(0)}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    itemStyle={TOOLTIP_ITEM_STYLE}
                    labelFormatter={(d: string) => fmtBucketLabel(d, rhrGran, timezone)}
                    formatter={(value: number, name: string) => [
                      `${value.toFixed(0)} bpm`,
                      name === 'rhr' ? rhrLineLabel : '60d baseline'
                    ]}
                  />
                  {hasRhrBaseline && (
                    <Area
                      type="monotone"
                      dataKey="baselineLow"
                      name="baselineLow"
                      stackId="baseline"
                      stroke="none"
                      fill="transparent"
                      connectNulls={false}
                      isAnimationActive={false}
                      legendType="none"
                      tooltipType="none"
                    />
                  )}
                  {hasRhrBaseline && (
                    <Area
                      type="monotone"
                      dataKey="baselineBand"
                      name="baseline"
                      stackId="baseline"
                      stroke="none"
                      fill="var(--color-recovery-dim)"
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="rhr"
                    name="rhr"
                    stroke="var(--color-recovery)"
                    strokeWidth={1.5}
                    dot={
                      rhrGran === 'daily'
                        ? false
                        : { r: 2.5, fill: 'var(--color-recovery)', strokeWidth: 0 }
                    }
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message="No resting heart rate data in this range yet — RHR will chart here once Apple Health exports it." />
            )}
          </ChartCard>
        </div>

        <div className="recovery-grid--span-6">
          <ChartCard
            title="Heart rate variability"
            span={6}
            headerRight={<ChipFilter value={hrvRange} onChange={setHrvRange} options={['30d', '90d', '1y']} />}
          >
            {hasHrvData ? (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={hrvChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-divider-soft)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={false}
                      minTickGap={32}
                      tickFormatter={(d: string) => fmtBucketLabel(d, hrvGran, timezone)}
                    />
                    <YAxis
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={32}
                      domain={['auto', 'auto']}
                      // Weekly medians can be fractional and clip at this width.
                      tickFormatter={(v: number) => v.toFixed(0)}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      itemStyle={TOOLTIP_ITEM_STYLE}
                      labelFormatter={(d: string) => fmtBucketLabel(d, hrvGran, timezone)}
                      formatter={(value: number, name: string) => [
                        `${value.toFixed(0)} ms`,
                        name === 'weeklyMedian' ? hrvMedianLabel : 'HRV'
                      ]}
                    />
                    {hrvGran === 'daily' && (
                      <Line
                        type="monotone"
                        dataKey="hrv"
                        name="hrv"
                        stroke="var(--color-recovery)"
                        strokeOpacity={0.35}
                        strokeWidth={0}
                        dot={{ r: 2, fill: 'var(--color-recovery)', fillOpacity: 0.35, strokeWidth: 0 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    )}
                    <Line
                      type="monotone"
                      dataKey="weeklyMedian"
                      name="weeklyMedian"
                      stroke="var(--color-recovery)"
                      strokeWidth={1.5}
                      dot={
                        hrvGran === 'daily'
                          ? false
                          : { r: 2.5, fill: 'var(--color-recovery)', strokeWidth: 0 }
                      }
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="recovery-chart-caption">trend, not daily readiness — Apple&apos;s HRV is noisy</p>
              </>
            ) : (
              <EmptyState message="No HRV data in this range yet — heart rate variability will chart here once Apple Health exports it." />
            )}
          </ChartCard>
        </div>

        <div className="recovery-grid--span-6">
          <ChartCard
            title="Respiratory rate"
            span={6}
            headerRight={<ChipFilter value={respRange} onChange={setRespRange} options={['30d', '90d', '1y']} />}
          >
            {hasRespData ? (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={respChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-divider-soft)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={false}
                      minTickGap={32}
                      tickFormatter={(d: string) => fmtBucketLabel(d, respGran, timezone)}
                    />
                    <YAxis
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={32}
                      domain={['auto', 'auto']}
                      label={{ value: 'br/min', position: 'insideTopLeft', fill: 'var(--color-text-tertiary)', fontSize: 12 }}
                      // Bucket means can be long fractions that clip at this width.
                      tickFormatter={(v: number) => v.toFixed(1)}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      itemStyle={TOOLTIP_ITEM_STYLE}
                      labelFormatter={(d: string) => fmtBucketLabel(d, respGran, timezone)}
                      formatter={(value: number, name: string) => [
                        `${value.toFixed(1)} br/min`,
                        name === 'avgResp' ? respLineLabel : 'Respiratory rate'
                      ]}
                    />
                    {respGran === 'daily' && (
                      <Line
                        type="monotone"
                        dataKey="resp"
                        name="resp"
                        stroke="var(--color-recovery)"
                        strokeOpacity={0.35}
                        strokeWidth={0}
                        dot={{ r: 2, fill: 'var(--color-recovery)', fillOpacity: 0.35, strokeWidth: 0 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    )}
                    <Line
                      type="monotone"
                      dataKey="avgResp"
                      name="avgResp"
                      stroke="var(--color-recovery)"
                      strokeWidth={1.5}
                      dot={
                        respGran === 'daily'
                          ? false
                          : { r: 2.5, fill: 'var(--color-recovery)', strokeWidth: 0 }
                      }
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="recovery-chart-caption">
                  Overnight breaths per minute — a steady baseline; spikes can precede illness.
                </p>
              </>
            ) : (
              <EmptyState message="No respiratory rate data in this range yet — overnight breathing rate will chart here once Apple Health exports it." />
            )}
          </ChartCard>
        </div>

        <div className="recovery-grid--span-6">
          <ChartCard title="VO₂max" span={6}>
            {hasVo2Data ? (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-divider-soft)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      type="category"
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={false}
                      minTickGap={32}
                      tickFormatter={(d: string) => fmtLocalDate(d, timezone)}
                      allowDuplicatedCategory={false}
                    />
                    <YAxis
                      dataKey="vo2max"
                      type="number"
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={32}
                      domain={['auto', 'auto']}
                    />
                    <ZAxis range={[36, 36]} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      itemStyle={TOOLTIP_ITEM_STYLE}
                      labelFormatter={(d: string) => fmtLocalDate(d, timezone)}
                      formatter={(value: number) => [`${value.toFixed(1)} mL/kg/min`, 'VO₂max']}
                    />
                    <Scatter data={vo2ChartData} fill="var(--color-recovery)" />
                  </ScatterChart>
                </ResponsiveContainer>
                <p className="recovery-chart-caption">
                  Only updates from outdoor walks or runs, so points are rare.
                </p>
              </>
            ) : (
              <EmptyState message="No VO₂max readings yet — Apple Health only estimates this from outdoor walks or runs." />
            )}
          </ChartCard>
        </div>

        <div className="recovery-grid--span-6">
          {hasWristTempData ? (
            <ChartCard title="Wrist temperature deviation" span={6}>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={wristTempChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--color-divider-soft)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={false}
                    minTickGap={32}
                    tickFormatter={(d: string) => fmtLocalDate(d, timezone)}
                  />
                  <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    itemStyle={TOOLTIP_ITEM_STYLE}
                    labelFormatter={(d: string) => fmtLocalDate(d, timezone)}
                    formatter={(value: number) => [`${value >= 0 ? '+' : ''}${value.toFixed(2)}°C`, 'Deviation']}
                  />
                  <Line
                    type="monotone"
                    dataKey="dev"
                    name="dev"
                    stroke="var(--color-recovery)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          ) : (
            <MetricCard
              eyebrow="Wrist temperature"
              value={EM_DASH}
              caption="Needs a compatible watch and the metric enabled in the export."
              domain="recovery"
            />
          )}
        </div>

        <div className="recovery-grid--span-12">
          <ChartCard
            title="Body weight"
            span={12}
            headerRight={<ChipFilter value={weightRange} onChange={setWeightRange} options={['90d', '1y']} />}
          >
            {hasWeightData ? (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={weightChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-divider-soft)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      type="category"
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={false}
                      minTickGap={32}
                      tickFormatter={(d: string) => fmtLocalDate(d, timezone)}
                      allowDuplicatedCategory={false}
                    />
                    <YAxis
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={40}
                      domain={['dataMin - 1', 'dataMax + 1']}
                      allowDecimals={false}
                      label={{ value: 'kg', position: 'insideTopLeft', fill: 'var(--color-text-tertiary)', fontSize: 12 }}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      itemStyle={TOOLTIP_ITEM_STYLE}
                      labelFormatter={(d: string) => fmtLocalDate(d, timezone)}
                      formatter={(value: number, name: string) => [
                        `${value.toFixed(1)} kg`,
                        name === 'trend' ? '7d trend' : 'Weight'
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="weight"
                      name="weight"
                      stroke="var(--color-recovery)"
                      strokeWidth={0}
                      dot={{ r: 2.5, fill: 'var(--color-recovery)', strokeWidth: 0 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="trend"
                      name="trend"
                      stroke="var(--color-recovery)"
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="recovery-chart-caption">
                  Sparse weigh-ins — the trend line only draws where readings cluster. Weigh in
                  near-daily to activate the weight-trend insight.
                </p>
              </>
            ) : (
              <EmptyState message="No body-weight readings yet — weigh-ins will chart here once Apple Health exports them." />
            )}
          </ChartCard>
        </div>
      </div>
    </div>
  )
}
