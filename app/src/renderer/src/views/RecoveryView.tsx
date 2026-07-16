import { useMemo, useState, type ReactElement } from 'react'
import { scaleLinear } from 'd3-scale'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis
} from 'recharts'
import { quantile } from 'd3-array'
import { TabHeader } from './TabHeader'
import {
  ChartCard,
  ChipFilter,
  EmptyState,
  FlagBanner,
  HeroMetric,
  MetricCard,
  MetricDetailModal,
  type MetricDetailConfig,
  type MetricDetailPoint
} from '../components'
import type { ChipRange } from '../components'
import { HeroNumber } from '../components/HeroNumber'
import {
  RANGE_DAYS,
  useRecoveryComputedDaily,
  useRecoveryDailyMetrics,
  useRecoveryTodayFlags,
  useRecoveryUserConfig
} from '../hooks/useRecoveryData'
import { todayYMD, ymdKey } from '../hooks/sessionsDate'
import {
  buildLoadChartData,
  buildWeightSeries,
  bucketAggregate,
  chartAxis,
  clockGoalMinutesOnSleepAxis,
  clockMinutesOnSleepAxis,
  computeTrainingLoadSummary,
  daysAgo,
  fmtBucketLabel,
  fmtClockTime,
  fmtDelta,
  fmtHoursAsHm,
  fmtHoursMinutes,
  fmtLocalDate,
  fmtNum,
  fmtSleepAxisTime,
  granularityForDays,
  mean,
  median,
  readStageHours,
  rollingAverage,
  sliceLastNDays,
  sortByDate,
  weeklyMedianByDate,
  EM_DASH
} from './recoveryUtils'
import './RecoveryView.css'

type RecoveryTab = 'load' | 'sleep'

/** Short "Jun 28" label for load-chart axes / detail popups (UTC-anchored date key). */
function fmtLoadDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short'
  }).format(new Date(`${dateStr}T00:00:00Z`))
}

/** Builds a MetricDetailPoint[] from a computed_daily series for the load popups. */
function toLoadDetailSeries(
  rows: Array<{ date: string; value: number | null }>
): MetricDetailPoint[] {
  return rows.map(({ date, value }) => ({ date, label: fmtLoadDate(date), value }))
}

const LOAD_EXPLANATIONS = {
  ctl: 'CTL (Chronic Training Load, sometimes called "Fitness") is a rolling ~42-day exponentially-weighted average of your daily training load (TRIMP). It rises slowly as you train consistently and represents your accumulated aerobic fitness — a single hard day barely moves it, but weeks of steady training do.',
  ctlAtl:
    'CTL is your slower-moving long-term training load, while ATL reacts quickly to recent work. Reading them together shows whether your short-term fatigue is running above or below the fitness base you have built.',
  atlTsb:
    'ATL (Acute Training Load, "Fatigue") is a fast-reacting ~7-day exponentially-weighted average of daily load — it spikes after hard days and fades quickly with rest. TSB (Training Stress Balance, "Form") is CTL minus ATL: positive means you\'re fresh or tapered, negative means you\'re carrying fatigue from recent training.',
  trimp:
    'TRIMP (Training Impulse) is a single-number load score for a session or day, derived from heart rate and duration. Higher means more physiological stress from that training — it is the raw input CTL and ATL are both built from.'
} as const

/** The clickable load stat tiles (ATL, TSB, TRIMP) that open their metric popup. */
type LoadMetricKey = 'ctlAtl' | 'atlTsb' | 'trimp'

interface LoadStatProps {
  label: string
  name: string
  value: string
  sub?: string
  onClick: () => void
}

/** A small clickable load stat tile mirroring the Dashboard's old StatSquare. */
function LoadStat({ label, name, value, sub, onClick }: LoadStatProps): ReactElement {
  return (
    <button
      type="button"
      className="recovery-load-stat"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={`${label} (${name}) — open details`}
    >
      <span className="recovery-load-stat-head">
        <span className="recovery-load-stat-label">{label}</span>
        <span className="recovery-load-stat-name">{name}</span>
      </span>
      <span className="recovery-load-stat-figure">
        <span className="recovery-load-stat-value tabular-nums">{value}</span>
        {sub && <span className="recovery-load-stat-sub">{sub}</span>}
      </span>
    </button>
  )
}

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

// A ScatterChart runs the default Tooltip formatter over *every* payload item,
// including the category X value — here a date string. The old
// `formatter={(v) => v.toFixed(1)}` threw "toFixed is not a function" on that
// string, crashing the renderer to black on hover. This custom content reads
// the datum directly and only ever formats the numeric reading.
function Vo2Tooltip({
  active,
  payload,
  timezone
}: {
  active?: boolean
  payload?: Array<{ payload?: { date: string; vo2max: number } }>
  timezone: string | null | undefined
}): ReactElement | null {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0]?.payload
  if (!point) return null
  return (
    <div className="recovery-scatter-tooltip">
      <div className="recovery-scatter-tooltip-label">{fmtLocalDate(point.date, timezone)}</div>
      <div className="recovery-scatter-tooltip-value tabular-nums">
        {point.vo2max.toFixed(1)} mL/kg/min
      </div>
    </div>
  )
}

export function RecoveryView(): ReactElement {
  const [sleepRange, setSleepRange] = useState<ChipRange>('30d')
  const [bedtimeRange, setBedtimeRange] = useState<ChipRange>('30d')
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
  const sleepGoalMinutes = userConfigQuery.data?.sleep_goal_min ?? 480
  const sleepGoalHours = sleepGoalMinutes / 60
  const sleepGoalLabel = sleepGoalMinutes % 60 === 0
    ? `${sleepGoalMinutes / 60}h`
    : fmtHoursMinutes(sleepGoalMinutes)
  const bedtimeGoalMinutes = userConfigQuery.data?.bedtime_goal_min ?? 0
  const bedtimeGoalAxisMinutes = clockGoalMinutesOnSleepAxis(bedtimeGoalMinutes)
  const flags = flagsQuery.data ?? []

  const allMetrics = useMemo(() => sortByDate(dailyMetricsQuery.data ?? []), [dailyMetricsQuery.data])
  const allComputed = useMemo(
    () => [...(computedDailyQuery.data ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [computedDailyQuery.data]
  )

  // --- Sub-tabs: Load (default) + Sleep. Load carries the training-load metrics
  //     that used to live on the Dashboard; Sleep keeps everything else. ---
  const [activeTab, setActiveTab] = useState<RecoveryTab>('load')

  // --- Training LOAD tab data (CTL/ATL/TSB/TRIMP) ---
  // computed_daily.date is keyed in the user's timezone (the nightly job's
  // convention), so the ISO-week window this summary uses must be anchored to
  // the same user-tz "today", not the machine's day.
  const todayKey = ymdKey(todayYMD(timezone))
  const loadSummary = useMemo(
    () => computeTrainingLoadSummary(allComputed, todayKey),
    [allComputed, todayKey]
  )
  const loadChartData = useMemo(
    () => buildLoadChartData(allComputed, todayKey, 90),
    [allComputed, todayKey]
  )
  const hasLoadChart = loadChartData.some((d) => d.ctl !== null || d.atl !== null)
  const loadChartVals = loadChartData
    .flatMap((d) => [d.ctl, d.atl])
    .filter((v): v is number => v !== null)
  const loadScale = scaleLinear()
  if (loadChartVals.length > 0) {
    const lo = Math.min(...loadChartVals)
    const hi = Math.max(...loadChartVals)
    const pad = Math.max(2, (hi - lo) * 0.1)
    loadScale.domain([Math.max(0, lo - pad), hi + pad]).nice(4)
  } else {
    loadScale.domain([0, 1])
  }
  const loadAxisDomain = loadScale.domain() as [number, number]
  const loadAxisTicks = loadScale.ticks(4)

  // Load metric-detail popups (year-wide series feed the expanded charts).
  const [openLoadMetric, setOpenLoadMetric] = useState<LoadMetricKey | null>(null)
  const loadMetricConfigs = useMemo<Record<LoadMetricKey, MetricDetailConfig>>(() => {
    const ctlSeries = toLoadDetailSeries(allComputed.map((r) => ({ date: r.date, value: r.ctl })))
    const atlSeries = toLoadDetailSeries(allComputed.map((r) => ({ date: r.date, value: r.atl })))
    const trimpSeries = toLoadDetailSeries(
      allComputed.map((r) => ({ date: r.date, value: r.trimp_total }))
    )
    return {
      ctlAtl: {
        title: 'CTL / ATL · Training load',
        currentValueDisplay: fmtNum(loadSummary.latestCtl, 1),
        currentValueCaption: `CTL · ATL ${fmtNum(loadSummary.latestAtl, 1)}`,
        series: ctlSeries,
        secondarySeries: atlSeries,
        explanation: LOAD_EXPLANATIONS.ctlAtl,
        domain: 'load',
        seriesName: 'CTL',
        secondarySeriesName: 'ATL',
        secondarySeriesColor: 'var(--color-sessions)'
      },
      atlTsb: {
        title: 'ATL & TSB · Fatigue & Form',
        currentValueDisplay: fmtNum(loadSummary.latestAtl, 1),
        currentValueCaption:
          loadSummary.latestTsb === null
            ? undefined
            : `ATL shown · TSB ${fmtDelta(loadSummary.latestTsb, 1)}`,
        series: atlSeries,
        explanation: LOAD_EXPLANATIONS.atlTsb,
        domain: 'load',
        seriesName: 'ATL'
      },
      trimp: {
        title: 'TRIMP · Training load score',
        currentValueDisplay:
          loadSummary.trimpThisWeek === null
            ? EM_DASH
            : Math.round(loadSummary.trimpThisWeek).toString(),
        currentValueCaption:
          loadSummary.trimp4wAvg === null
            ? 'this week'
            : `this week · 4-wk avg ${Math.round(loadSummary.trimp4wAvg)}`,
        series: trimpSeries,
        explanation: LOAD_EXPLANATIONS.trimp,
        domain: 'load',
        seriesName: 'TRIMP'
      }
    }
  }, [allComputed, loadSummary])
  const openLoadConfig = openLoadMetric ? loadMetricConfigs[openLoadMetric] : null

  // --- Hero: last night's sleep ---
  const latestSleepRow = [...allMetrics].reverse().find((m) => m.sleep_duration_min !== null)
  const latestSleepMinutes = latestSleepRow?.sleep_duration_min ?? null
  const latestSleepAge = latestSleepRow ? daysAgo(latestSleepRow.date, timezone) : null

  const last7dSleepRows = latestSleepRow
    ? sliceLastNDays(
        allMetrics.filter((m) => m.date <= latestSleepRow.date),
        7,
        timezone
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
  const sleepDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[sleepRange], timezone)
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
  const sleepValues = sleepChartData
    .map((d) => d.hours)
    .filter((value): value is number => value !== null)
  const sleepSorted = [...sleepValues].sort((a, b) => a - b)
  const sleepAxis = chartAxis([...sleepValues, sleepGoalHours], { padding: 0.35, tickCount: 4 })
  const sleepMedian = median(sleepValues)
  const sleepQ1 = quantile(sleepSorted, 0.25) ?? null
  const sleepQ3 = quantile(sleepSorted, 0.75) ?? null
  const sleepWindowAverage = mean(sleepValues)
  const sleepBarLabel =
    sleepGran === 'weekly' ? 'Weekly avg' : sleepGran === 'monthly' ? 'Monthly avg' : 'Sleep'

  // Bedtime / wake for the most recent night with a recorded sleep window.
  const latestBedtime = fmtClockTime(latestSleepRow?.sleep_start, timezone)
  const latestWake = fmtClockTime(latestSleepRow?.sleep_end, timezone)
  // Shift post-midnight times beyond 24:00 so the overnight clock remains
  // continuous instead of drawing a false jump at midnight.
  const bedtimeDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[bedtimeRange], timezone)
  const bedtimeChartData = bedtimeDaysWindow.map((row, index, rows) => {
    const rawBedtime = clockMinutesOnSleepAxis(row.sleep_start, timezone)
    const bedtime = rawBedtime !== null && rawBedtime >= 16 * 60 && rawBedtime <= 36 * 60
      ? rawBedtime
      : null
    const trailing = rows
      .slice(Math.max(0, index - 6), index + 1)
      .map((candidate) => clockMinutesOnSleepAxis(candidate.sleep_start, timezone))
      .filter((value): value is number => value !== null && value >= 16 * 60 && value <= 36 * 60)
    return { date: row.date, bedtime, avgBedtime: mean(trailing) }
  })
  const bedtimeValues = bedtimeChartData
    .map((row) => row.bedtime)
    .filter((value): value is number => value !== null)
  const bedtimeSorted = [...bedtimeValues].sort((a, b) => a - b)
  const bedtimeAxis = chartAxis([...bedtimeValues, bedtimeGoalAxisMinutes], { padding: 45, tickCount: 5 })
  const bedtimeMedian = median(bedtimeValues)
  const bedtimeQ1 = quantile(bedtimeSorted, 0.25) ?? null
  const bedtimeQ3 = quantile(bedtimeSorted, 0.75) ?? null
  const hasBedtimeTrend = bedtimeValues.length > 0

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
  const rhrDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[rhrRange], timezone)
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
  const hrvDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[hrvRange], timezone)
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
  const respDaysWindow = sliceLastNDays(allMetrics, RANGE_DAYS[respRange], timezone)
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
  const vo2Window = sliceLastNDays(allMetrics, RANGE_DAYS['1y'], timezone)
  const vo2ChartData = vo2Window
    .filter((r) => r.vo2max !== null)
    .map((r) => ({ date: r.date, vo2max: r.vo2max as number }))
  const hasVo2Data = vo2ChartData.length > 0

  // --- Wrist temperature: only render the card if any non-null values exist ---
  const hasWristTempData = allMetrics.some((r) => r.wrist_temp_deviation_c !== null)
  const wristTempWindow = sliceLastNDays(allMetrics, RANGE_DAYS['30d'], timezone)
  const wristTempChartData = wristTempWindow.map((r) => ({
    date: r.date,
    dev: r.wrist_temp_deviation_c
  }))

  // --- Body weight: sparse scatter + 7-day-bridged trend line ---
  const weightWindow = sliceLastNDays(allMetrics, RANGE_DAYS[weightRange], timezone)
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

      {/* Section-tab bar — Load first + default (mirrors Zone2View's idiom). */}
      <div className="recovery-tabs" role="tablist" aria-label="Recovery section">
        <button
          role="tab"
          aria-selected={activeTab === 'load'}
          className={activeTab === 'load' ? 'recovery-tab recovery-tab--active' : 'recovery-tab'}
          onClick={() => setActiveTab('load')}
        >
          Load
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'sleep'}
          className={activeTab === 'sleep' ? 'recovery-tab recovery-tab--active' : 'recovery-tab'}
          onClick={() => setActiveTab('sleep')}
        >
          Sleep
        </button>
      </div>

      {activeTab === 'load' && (
        <>
          <button
            type="button"
            className="hero-metric-button"
            onClick={() => setOpenLoadMetric('ctlAtl')}
            aria-haspopup="dialog"
            aria-label="Training load · CTL — open details"
          >
            <HeroMetric
              eyebrow="TRAINING LOAD · CTL"
              value={fmtNum(loadSummary.latestCtl, 1)}
              delta={
                loadSummary.ctlDelta7d === null
                  ? undefined
                  : `${fmtDelta(loadSummary.ctlDelta7d, 1)} vs 7 days ago`
              }
              deltaPositive={loadSummary.ctlDelta7d !== null && loadSummary.ctlDelta7d > 0}
              domain="load"
            />
          </button>

          <div className="recovery-load-stats">
            <LoadStat
              label="ATL"
              name="Acute load"
              value={fmtNum(loadSummary.latestAtl, 1)}
              sub="Fatigue"
              onClick={() => setOpenLoadMetric('atlTsb')}
            />
            <LoadStat
              label="TSB"
              name="Stress balance"
              value={fmtNum(loadSummary.latestTsb, 1)}
              sub="Form"
              onClick={() => setOpenLoadMetric('atlTsb')}
            />
            <LoadStat
              label="TRIMP"
              name="Training impulse"
              value={
                loadSummary.trimpThisWeek === null
                  ? EM_DASH
                  : Math.round(loadSummary.trimpThisWeek).toString()
              }
              sub={
                loadSummary.trimp4wAvg === null
                  ? 'this week'
                  : `4wk avg ${Math.round(loadSummary.trimp4wAvg)}`
              }
              onClick={() => setOpenLoadMetric('trimp')}
            />
          </div>

          <button
            type="button"
            className="recovery-load-chart-button"
            onClick={() => setOpenLoadMetric('ctlAtl')}
            aria-haspopup="dialog"
            aria-label="CTL and ATL training load — open expanded chart"
          >
            <ChartCard
              title="Training load · 90 days"
              span={12}
              headerRight={
                <div className="recovery-load-chart-key" aria-hidden="true">
                  <span>
                    <i className="recovery-load-chart-swatch recovery-load-chart-swatch--ctl" />
                    CTL
                  </span>
                  <span>
                    <i className="recovery-load-chart-swatch recovery-load-chart-swatch--atl" />
                    ATL
                  </span>
                </div>
              }
            >
              {hasLoadChart ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={loadChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid
                      vertical={false}
                      stroke="var(--color-divider-soft)"
                      strokeOpacity={0.55}
                    />
                    <XAxis
                      dataKey="date"
                      tickFormatter={fmtLoadDate}
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={false}
                      minTickGap={32}
                    />
                    <YAxis
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={32}
                      domain={loadAxisDomain}
                      ticks={loadAxisTicks}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      itemStyle={TOOLTIP_ITEM_STYLE}
                      labelFormatter={(label) => fmtLoadDate(String(label))}
                      formatter={(value: number, name: string) => [Number(value).toFixed(1), name]}
                    />
                    <Line
                      type="monotone"
                      dataKey="ctl"
                      name="CTL"
                      stroke="var(--color-load)"
                      strokeWidth={2.25}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="atl"
                      name="ATL"
                      stroke="var(--color-sessions)"
                      strokeWidth={1.75}
                      strokeDasharray="5 4"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState message="No training-load history yet — CTL and ATL will chart here once the nightly metrics job has run." />
              )}
            </ChartCard>
          </button>
        </>
      )}

      {activeTab === 'sleep' && (
        <>
      <section className="recovery-hero" aria-label="Last night recovery summary">
        <div className="hero-metric">
          <div className="hero-metric-eyebrow hero-metric-eyebrow--recovery">
            RECOVERY · LAST NIGHT
          </div>
          <div className="hero-metric-row">
            <HeroNumber
              value={latestSleepMinutes}
              format={(n) => fmtHoursMinutes(n)}
              className="hero-metric-value"
            />
          </div>
          {heroCaption && (
            <div
              className={
                sleepDeltaMin !== null && sleepDeltaMin >= 0
                  ? 'hero-metric-delta hero-metric-delta--recovery'
                  : 'hero-metric-delta hero-metric-delta--neutral'
              }
            >
              {heroCaption}
            </div>
          )}
        </div>

        <div className="recovery-hero-details">
          <div className="recovery-hero-window">
            <span className="recovery-hero-detail-label">Sleep window</span>
            <div className="recovery-hero-times">
              <span>
                <small>Asleep</small>
                <strong className="tabular-nums">{latestBedtime}</strong>
              </span>
              <span className="recovery-hero-time-rule" aria-hidden="true" />
              <span>
                <small>Awake</small>
                <strong className="tabular-nums">{latestWake}</strong>
              </span>
            </div>
          </div>

          {hasStageLegend && (
            <div className="recovery-hero-stages" aria-label="Last night sleep stages">
              <span><small>Deep</small><strong className="tabular-nums">{fmtHoursAsHm(deepH)}</strong></span>
              <span><small>Core</small><strong className="tabular-nums">{fmtHoursAsHm(coreH)}</strong></span>
              <span><small>REM</small><strong className="tabular-nums">{fmtHoursAsHm(remH)}</strong></span>
              <span><small>Awake</small><strong className="tabular-nums">{fmtHoursAsHm(awakeH)}</strong></span>
            </div>
          )}
        </div>
      </section>

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
                      domain={sleepAxis.domain}
                      ticks={sleepAxis.ticks}
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
                        fmtHoursMinutes(value * 60),
                        name === 'avgHours' ? '7d avg' : sleepBarLabel
                      ]}
                    />
                    {sleepQ1 !== null && sleepQ3 !== null && (
                      <ReferenceArea
                        y1={sleepQ1}
                        y2={sleepQ3}
                        fill="var(--color-recovery-dim)"
                        fillOpacity={0.7}
                        strokeOpacity={0}
                      />
                    )}
                    <ReferenceLine
                      y={sleepGoalHours}
                      stroke="var(--color-recovery)"
                      strokeWidth={2}
                      label={{
                        value: `Goal ${sleepGoalLabel}`,
                        position: 'insideTopRight',
                        fill: 'var(--color-recovery-text)',
                        fontSize: 12,
                        fontWeight: 600
                      }}
                    />
                    {sleepMedian !== null && (
                      <ReferenceLine
                        y={sleepMedian}
                        stroke="var(--color-text-tertiary)"
                        strokeDasharray="3 4"
                      />
                    )}
                    <Bar
                      dataKey="hours"
                      name="hours"
                      fill="var(--color-recovery)"
                      fillOpacity={0.48}
                      radius={[3, 3, 0, 0]}
                      maxBarSize={22}
                    />
                    {sleepGran === 'daily' && (
                      <Line
                        type="monotone"
                        dataKey="avgHours"
                        name="avgHours"
                        stroke="var(--color-recovery)"
                        strokeWidth={2.25}
                        dot={false}
                        connectNulls={false}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
                <div className="recovery-sleep-summary" aria-label="Sleep range summary">
                  <span>
                    <small>Average</small>
                    <strong className="tabular-nums">{fmtHoursMinutes(sleepWindowAverage === null ? null : sleepWindowAverage * 60)}</strong>
                  </span>
                  <span>
                    <small>Typical range</small>
                    <strong className="tabular-nums">{sleepQ1 === null || sleepQ3 === null ? EM_DASH : `${fmtHoursMinutes(sleepQ1 * 60)}–${fmtHoursMinutes(sleepQ3 * 60)}`}</strong>
                  </span>
                  <span>
                    <small>Nights recorded</small>
                    <strong className="tabular-nums">{sleepValues.length}</strong>
                  </span>
                </div>
              </>
            ) : (
              <EmptyState message="No sleep data in this range yet — nightly sleep duration will chart here once Apple Health exports sleep sessions." />
            )}
          </ChartCard>
        </div>

        <div className="recovery-grid--span-12">
          <ChartCard
            title="Bedtime"
            span={12}
            headerRight={<ChipFilter value={bedtimeRange} onChange={setBedtimeRange} options={['7d', '30d', '90d']} />}
          >
            {hasBedtimeTrend ? (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={bedtimeChartData} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke="var(--color-divider-soft)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={AXIS_TICK}
                      axisLine={AXIS_LINE}
                      tickLine={false}
                      minTickGap={32}
                      tickFormatter={(date: string) => fmtBucketLabel(date, 'daily', timezone)}
                    />
                    <YAxis
                      domain={bedtimeAxis.domain}
                      ticks={bedtimeAxis.ticks}
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                      reversed
                      tickFormatter={fmtSleepAxisTime}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      itemStyle={TOOLTIP_ITEM_STYLE}
                      labelFormatter={(date: string) => fmtLocalDate(date, timezone)}
                      formatter={(value: number, name: string) => [
                        fmtSleepAxisTime(value),
                        name === 'avgBedtime' ? '7d avg' : 'Bedtime'
                      ]}
                    />
                    {bedtimeQ1 !== null && bedtimeQ3 !== null && (
                      <ReferenceArea
                        y1={bedtimeQ1}
                        y2={bedtimeQ3}
                        fill="var(--color-recovery-dim)"
                        fillOpacity={0.65}
                        strokeOpacity={0}
                      />
                    )}
                    <ReferenceLine
                      y={bedtimeGoalAxisMinutes}
                      stroke="var(--color-recovery)"
                      strokeWidth={2}
                      label={{
                        value: `Goal ${fmtSleepAxisTime(bedtimeGoalAxisMinutes)}`,
                        position: 'insideTopRight',
                        fill: 'var(--color-recovery-text)',
                        fontSize: 12,
                        fontWeight: 600
                      }}
                    />
                    {bedtimeMedian !== null && (
                      <ReferenceLine
                        y={bedtimeMedian}
                        stroke="var(--color-text-tertiary)"
                        strokeDasharray="3 4"
                      />
                    )}
                    <Line
                      type="linear"
                      dataKey="bedtime"
                      name="bedtime"
                      stroke="var(--color-text-tertiary)"
                      strokeWidth={1}
                      dot={{ r: 2.5, fill: 'var(--color-recovery)', strokeWidth: 0 }}
                      connectNulls={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="avgBedtime"
                      name="avgBedtime"
                      stroke="var(--color-recovery)"
                      strokeWidth={2.25}
                      dot={false}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                <div className="recovery-sleep-summary" aria-label="Bedtime range summary">
                  <span>
                    <small>Typical bedtime</small>
                    <strong className="tabular-nums">{bedtimeMedian === null ? EM_DASH : fmtSleepAxisTime(bedtimeMedian)}</strong>
                  </span>
                  <span>
                    <small>Typical window</small>
                    <strong className="tabular-nums">{bedtimeQ1 === null || bedtimeQ3 === null ? EM_DASH : `${fmtSleepAxisTime(bedtimeQ1)}–${fmtSleepAxisTime(bedtimeQ3)}`}</strong>
                  </span>
                  <span>
                    <small>Nights recorded</small>
                    <strong className="tabular-nums">{bedtimeValues.length}</strong>
                  </span>
                </div>
                <p className="recovery-chart-caption">Times after midnight continue across the overnight axis, so small schedule shifts stay small.</p>
              </>
            ) : (
              <EmptyState message="No bedtime data in this range yet. Sleep start times will chart here once Apple Health exports them." />
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
                      cursor={{ stroke: 'var(--color-divider-soft)', strokeWidth: 1 }}
                      content={<Vo2Tooltip timezone={timezone} />}
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
        </>
      )}

      {openLoadConfig && (
        <MetricDetailModal config={openLoadConfig} onClose={() => setOpenLoadMetric(null)} />
      )}
    </div>
  )
}
