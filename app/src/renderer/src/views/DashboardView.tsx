import { useMemo, useState, type ReactElement } from 'react'
import { ArrowRight } from 'lucide-react'
import { scaleLinear } from 'd3-scale'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { ComputedDaily, DailyMetric, Workout } from '@shared/types'
import { TabHeader } from './TabHeader'
import {
  ChartCard,
  EmptyState,
  HeroMetric,
  MetricDetailModal,
  type MetricDetailConfig,
  type MetricDetailPoint
} from '../components'
import { CalendarHeatmap } from '../components/CalendarHeatmap'
import { DayDetailDrawer } from '../components/DayDetailDrawer'
import { SummaryCard } from '../components/SummaryCard'
import { ModalityIcon } from '../components/ModalityIcon'
import { ActivityBadge } from '../components/ActivityBadge'
import { activityEnvironmentAccent, modalityLabel } from '../components/modalityAccent'
import type { StatTableRow } from '../components'
import {
  isoDateNDaysAgo,
  useComputedDaily,
  useDailyMetrics,
  useRecentWorkouts,
  useUserConfig,
  useWorkoutsInRange
} from '../hooks/useDashboardData'
import { useAllWorkouts } from '../hooks/useSessionsData'
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { useMonthCalendar } from '../hooks/useMonthCalendar'
import { addDays, isoWeekStart, localDateKey, todayYMD, ymdKey } from '../hooks/sessionsDate'
import { formatDurationHM, formatPerMonth, formatTrendPct } from '../lib/format'
import { monthSummary, yearSummary, type SummaryItem } from '../lib/periodSummary'
import {
  countSessionsForGoal,
  daysBetweenDates,
  fmtDelta,
  fmtDistance,
  fmtDuration,
  fmtNum,
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
}

/** The five clickable dashboard metric cards (Task 1), keyed for modal lookup. */
export type DashboardMetricKey = 'ctl' | 'ctlAtl' | 'atlTsb' | 'trimp' | 'rhr' | 'weight'

/** Plain-language, non-medical explanations shown in each metric's popup. */
const METRIC_EXPLANATIONS: Record<DashboardMetricKey, string> = {
  ctl: 'CTL (Chronic Training Load, sometimes called "Fitness") is a rolling ~42-day exponentially-weighted average of your daily training load (TRIMP). It rises slowly as you train consistently and represents your accumulated aerobic fitness — a single hard day barely moves it, but weeks of steady training do.',
  ctlAtl:
    'CTL is your slower-moving long-term training load, while ATL reacts quickly to recent work. Reading them together shows whether your short-term fatigue is running above or below the fitness base you have built.',
  atlTsb:
    'ATL (Acute Training Load, "Fatigue") is a fast-reacting ~7-day exponentially-weighted average of daily load — it spikes after hard days and fades quickly with rest. TSB (Training Stress Balance, "Form") is CTL minus ATL: positive means you\'re fresh or tapered, negative means you\'re carrying fatigue from recent training.',
  trimp:
    'TRIMP (Training Impulse) is a single-number load score for a session or day, derived from heart rate and duration. Higher means more physiological stress from that training — it is the raw input CTL and ATL are both built from.',
  rhr: 'Resting heart rate is your lowest heart rate at rest, usually measured on waking. A lower or stable RHR generally tracks good recovery; a noticeable jump above your usual baseline can signal accumulated fatigue, poor sleep, or the early signs of illness. This is informational self-tracking, not a medical diagnosis.',
  weight:
    'Body weight tracked over time from your logged readings. Day-to-day swings are mostly water and food timing — the trend over weeks matters far more than any single reading.'
}

const METRIC_TITLES: Record<DashboardMetricKey, string> = {
  ctl: 'CTL · Training load (Fitness)',
  ctlAtl: 'CTL / ATL · Training load',
  atlTsb: 'ATL & TSB · Fatigue & Form',
  trimp: 'TRIMP · Training load score',
  rhr: 'Resting heart rate',
  weight: 'Body weight'
}

/** Builds a MetricDetailPoint[] from computedDaily/dailyMetrics rows, formatting the x-axis label from the "YYYY-MM-DD" date. */
function toDetailSeries<T>(
  rows: T[],
  pick: (row: T) => { date: string; value: number | null }
): MetricDetailPoint[] {
  return rows.map((row) => {
    const { date, value } = pick(row)
    return { date, label: fmtShortDate(date), value }
  })
}

interface DashboardMetricConfigsArgs {
  sortedComputed: ComputedDaily[]
  sortedMetrics: DailyMetric[]
  latestCtl: number | null
  latestAtl: number | null
  latestTsb: number | null
  trimpThisWeekTotal: number | null
  trimp4wAvg: number | null
  latestRhr: number | null
  rhrDev: number | null
  latestWeight: number | null
  weightDeltaLabel: string | null
  weightDateLabel: string
}

/** Builds the {title, currentValueDisplay, series, explanation} config for each clickable dashboard metric card (Task 1). */
function useDashboardMetricConfigs(
  args: DashboardMetricConfigsArgs
): Record<DashboardMetricKey, MetricDetailConfig> {
  const {
    sortedComputed,
    sortedMetrics,
    latestCtl,
    latestAtl,
    latestTsb,
    trimpThisWeekTotal,
    trimp4wAvg,
    latestRhr,
    rhrDev,
    latestWeight,
    weightDeltaLabel,
    weightDateLabel
  } = args

  return useMemo(() => {
    const ctlSeries = toDetailSeries(sortedComputed, (r) => ({ date: r.date, value: r.ctl }))
    const atlSeries = toDetailSeries(sortedComputed, (r) => ({ date: r.date, value: r.atl }))
    const trimpSeries = toDetailSeries(sortedComputed, (r) => ({
      date: r.date,
      value: r.trimp_total
    }))
    const rhrSeries = toDetailSeries(sortedMetrics, (r) => ({ date: r.date, value: r.resting_hr }))
    const weightSeries = toDetailSeries(sortedMetrics, (r) => ({
      date: r.date,
      value: r.weight_kg
    }))

    const configs: Record<DashboardMetricKey, MetricDetailConfig> = {
      ctl: {
        title: METRIC_TITLES.ctl,
        currentValueDisplay: fmtNum(latestCtl, 1),
        series: ctlSeries,
        explanation: METRIC_EXPLANATIONS.ctl,
        domain: 'load',
        seriesName: 'CTL'
      },
      ctlAtl: {
        title: METRIC_TITLES.ctlAtl,
        currentValueDisplay: fmtNum(latestCtl, 1),
        currentValueCaption: `CTL · ATL ${fmtNum(latestAtl, 1)}`,
        series: ctlSeries,
        secondarySeries: atlSeries,
        explanation: METRIC_EXPLANATIONS.ctlAtl,
        domain: 'load',
        seriesName: 'CTL',
        secondarySeriesName: 'ATL',
        secondarySeriesColor: 'var(--color-sessions)'
      },
      atlTsb: {
        title: METRIC_TITLES.atlTsb,
        currentValueDisplay: fmtNum(latestAtl, 1),
        currentValueCaption:
          latestTsb === null ? undefined : `ATL shown · TSB ${fmtDelta(latestTsb, 1)}`,
        series: atlSeries,
        explanation: METRIC_EXPLANATIONS.atlTsb,
        domain: 'load',
        seriesName: 'ATL'
      },
      trimp: {
        title: METRIC_TITLES.trimp,
        currentValueDisplay:
          trimpThisWeekTotal === null ? EM_DASH : Math.round(trimpThisWeekTotal).toString(),
        currentValueCaption:
          trimp4wAvg === null ? 'this week' : `this week · 4-wk avg ${Math.round(trimp4wAvg)}`,
        series: trimpSeries,
        explanation: METRIC_EXPLANATIONS.trimp,
        domain: 'load',
        seriesName: 'TRIMP'
      },
      rhr: {
        title: METRIC_TITLES.rhr,
        currentValueDisplay: latestRhr === null ? EM_DASH : `${Math.round(latestRhr)} bpm`,
        currentValueCaption:
          rhrDev === null ? undefined : `deviation ${fmtDelta(rhrDev, 1)} bpm vs baseline`,
        series: rhrSeries,
        explanation: METRIC_EXPLANATIONS.rhr,
        domain: 'recovery',
        seriesName: 'RHR',
        unit: 'bpm',
        // Daily RHR is noisy — overlay a 7-day trend so the direction is legible.
        showTrend: true
      },
      weight: {
        title: METRIC_TITLES.weight,
        currentValueDisplay: latestWeight === null ? EM_DASH : `${latestWeight.toFixed(1)} kg`,
        currentValueCaption: weightDeltaLabel
          ? `${weightDeltaLabel} · ${weightDateLabel}`
          : weightDateLabel,
        series: weightSeries,
        // No explanation for weight (per the owner's ask) — the trend chart speaks for itself.
        domain: 'recovery',
        seriesName: 'Weight',
        unit: 'kg',
        // Dots at each logged reading along the curve.
        showDots: true
      }
    }
    return configs
  }, [
    sortedComputed,
    sortedMetrics,
    latestCtl,
    latestAtl,
    latestTsb,
    trimpThisWeekTotal,
    trimp4wAvg,
    latestRhr,
    rhrDev,
    latestWeight,
    weightDeltaLabel,
    weightDateLabel
  ])
}

interface StatSquareProps {
  label: string
  /** Full name spelled out under the acronym, e.g. "Acute load". */
  name: string
  value: string
  sub?: string
  domain: 'load' | 'recovery'
  onClick: () => void
}

/** A small clickable stat tile (ATL, TSB, TRIMP, RHR) that opens its metric popup. */
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

export function DashboardView({ onOpenSessions }: DashboardViewProps): ReactElement {
  const userConfigQuery = useUserConfig()
  // Widened from 90d so the CTL/ATL chart and the metric-detail popups (Task 1)
  // have a full year of history to chart; existing calcs below filter by date
  // so this is safe.
  const computedDailyQuery = useComputedDaily(365)
  const dailyMetricsQuery = useDailyMetrics(365)
  const recentWorkoutsQuery = useRecentWorkouts()

  const timezone = userConfigQuery.data?.timezone ?? undefined
  const weeklyMinSessions = parseWeeklyMinSessions(userConfigQuery.data)

  // The ISO week window anchored to "today" in the USER's configured
  // timezone (not the machine's) — computed_daily rows are keyed by the
  // user-tz calendar date, so filtering them against a machine-local week
  // boundary silently misaligned near timezone edges / DST transitions.
  const todayYmd = todayYMD(timezone)
  const weekWindow = isoWeekWindowFor(todayYmd)
  const fourWeeksAgoKey = ymdKey(addDays(isoWeekStart(todayYmd), -28))
  const workoutsThisWeekQuery = useWorkoutsInRange(weekWindow.startIso, weekWindow.endIso)

  // --- Month calendar + period summaries (moved here from the Sessions view) ---
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

  // --- Hero: CTL + 7d delta ---
  const computedDaily = computedDailyQuery.data ?? []
  const sortedComputed = [...computedDaily].sort((a, b) => a.date.localeCompare(b.date))
  const latestComputed =
    sortedComputed.length > 0 ? sortedComputed[sortedComputed.length - 1] : undefined
  const latestCtl = latestComputed?.ctl ?? null
  // Shared 90d cutoff — the CTL/ATL card and the weight sparkline both plot a
  // 90d slice out of the (now year-wide) query windows.
  const ninetyDaysAgoStr = isoDateNDaysAgo(90)

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
  // computed_daily.date is keyed in the user's timezone (the nightly job's
  // convention), so this window must match — see weekWindow/fourWeeksAgoKey above.
  const trimpThisWeekRows = sortedComputed.filter(
    (r) => r.date >= weekWindow.startKey && r.date < weekWindow.endKey
  )
  const trimpThisWeekTotal = trimpThisWeekRows.some((r) => r.trimp_total !== null)
    ? trimpThisWeekRows.reduce((sum, r) => sum + (r.trimp_total ?? 0), 0)
    : null

  const trimp4wRows = sortedComputed.filter(
    (r) => r.date >= fourWeeksAgoKey && r.date < weekWindow.endKey
  )
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

  // --- Body weight: latest reading + terse delta vs ~1 month ago ---
  // Task 2 spec: date only (no "as of"), delta vs the reading closest to but
  // at least ~30 days older than the latest; falls back to the oldest
  // available reading if none is that old. Terse label, e.g. "−0.8 kg · 1 mo".
  const weightRows = sortedMetrics.filter((m) => m.weight_kg !== null)
  const latestWeightRow = weightRows.length > 0 ? weightRows[weightRows.length - 1] : undefined
  const latestWeight = latestWeightRow?.weight_kg ?? null

  // Candidates strictly older than the latest reading by >=30 days, closest first.
  const monthAgoCandidates =
    latestWeightRow === undefined
      ? []
      : weightRows
          .filter((m) => daysBetweenDates(m.date, latestWeightRow.date) >= 30)
          .sort(
            (a, b) =>
              daysBetweenDates(a.date, latestWeightRow.date) -
              daysBetweenDates(b.date, latestWeightRow.date)
          )
  const monthAgoRow =
    monthAgoCandidates.length > 0
      ? monthAgoCandidates[0]
      : weightRows.length > 1
        ? weightRows[0] // oldest available reading (fallback when nothing is ~1mo+ old)
        : undefined

  let weightDeltaLabel: string | null = null
  if (
    latestWeightRow !== undefined &&
    latestWeight !== null &&
    monthAgoRow !== undefined &&
    monthAgoRow.date !== latestWeightRow.date &&
    monthAgoRow.weight_kg !== null
  ) {
    const delta = latestWeight - monthAgoRow.weight_kg
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
    const daysAgo = daysBetweenDates(monthAgoRow.date, latestWeightRow.date)
    const monthsAgo = Math.max(1, Math.round(daysAgo / 30))
    weightDeltaLabel = `${sign}${Math.abs(delta).toFixed(1)} kg · ${monthsAgo} mo`
  }
  const weightDateLabel = latestWeightRow ? fmtShortDate(latestWeightRow.date) : EM_DASH

  // Sparkline data — last ~90d of weight readings, giving the card a data
  // preview and enough height to stop reading as too-wide/too-short.
  const weightSparklineData = weightRows
    .filter((m) => m.date >= ninetyDaysAgoStr)
    .map((m) => ({ date: m.date, weight: m.weight_kg }))
  // Low/high over the sparkline window — concrete numbers so the "nice curve"
  // actually conveys its range at a glance.
  const weightSparkVals = weightSparklineData
    .map((d) => d.weight)
    .filter((v): v is number => v !== null)
  const weightRangeLabel =
    weightSparkVals.length > 0
      ? `90d · ${Math.min(...weightSparkVals).toFixed(1)}–${Math.max(...weightSparkVals).toFixed(1)} kg`
      : null

  // --- CTL/ATL mini chart data — kept at 90d for this card even though the
  // underlying query now pulls a full year (the year of history feeds the
  // metric-detail popups below instead; this card's label says "90 days").
  const chartData = sortedComputed
    .filter((r) => r.date >= ninetyDaysAgoStr)
    .map((r) => ({
      date: r.date,
      ctl: r.ctl,
      atl: r.atl
    }))
  const hasChartData = chartData.some((d) => d.ctl !== null || d.atl !== null)
  const loadValues = chartData.flatMap((d) => [d.ctl, d.atl]).filter((v): v is number => v !== null)
  const loadScale = scaleLinear()
  if (loadValues.length > 0) {
    const minimum = Math.min(...loadValues)
    const maximum = Math.max(...loadValues)
    const padding = Math.max(2, (maximum - minimum) * 0.1)
    loadScale.domain([Math.max(0, minimum - padding), maximum + padding]).nice(4)
  } else {
    loadScale.domain([0, 1])
  }
  const loadAxisDomain = loadScale.domain() as [number, number]
  const loadAxisTicks = loadScale.ticks(4)

  // --- Recent sessions: last 4 workouts as a 2×2 grid ---
  const recentWorkouts = [...(recentWorkoutsQuery.data ?? [])]
    .sort((a, b) => b.start_at.localeCompare(a.start_at))
    .slice(0, 4)

  // A single-workout drawer opened by clicking one recent-session tile. Kept
  // separate from the calendar's day-level `selectedDayKey` so a tile opens ONLY
  // that workout, not every session sharing its day.
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

  // --- Task 1: clickable metric cards -> MetricDetailModal ---
  // Each entry builds its own {title, currentValueDisplay, series, explanation}
  // from the full-year computedDaily/dailyMetrics pulls above (not the 90d
  // slice the CTL/ATL card uses), so the popup graph shows a longer trend.
  const metricConfigs = useDashboardMetricConfigs({
    sortedComputed,
    sortedMetrics,
    latestCtl,
    latestAtl,
    latestTsb,
    trimpThisWeekTotal,
    trimp4wAvg,
    latestRhr,
    rhrDev,
    latestWeight,
    weightDeltaLabel,
    weightDateLabel
  })
  const [openMetricKey, setOpenMetricKey] = useState<DashboardMetricKey | null>(null)
  const openMetricConfig = openMetricKey ? metricConfigs[openMetricKey] : null

  return (
    <div className="view">
      <TabHeader eyebrow="Overview" title="Dashboard" />

      <button
        type="button"
        className="hero-metric-button"
        onClick={() => setOpenMetricKey('ctl')}
        aria-haspopup="dialog"
        aria-label="Training load · CTL — open details"
      >
        <HeroMetric
          eyebrow="TRAINING LOAD · CTL"
          value={fmtNum(latestCtl, 1)}
          delta={ctlDelta === null ? undefined : `${fmtDelta(ctlDelta, 1)} vs 7 days ago`}
          deltaPositive={ctlDelta !== null && ctlDelta > 0}
          domain="load"
        />
      </button>

      <div className="dashboard-grid">
        <div className="dashboard-grid--span-2">
          <StatSquare
            label="ATL"
            name="Acute load"
            value={fmtNum(latestAtl, 1)}
            sub="Fatigue"
            domain="load"
            onClick={() => setOpenMetricKey('atlTsb')}
          />
        </div>
        <div className="dashboard-grid--span-2">
          <StatSquare
            label="TSB"
            name="Stress balance"
            value={fmtNum(latestTsb, 1)}
            sub="Form"
            domain="load"
            onClick={() => setOpenMetricKey('atlTsb')}
          />
        </div>
        <div className="dashboard-grid--span-2">
          <StatSquare
            label="TRIMP"
            name="Training impulse"
            value={
              trimpThisWeekTotal === null ? EM_DASH : Math.round(trimpThisWeekTotal).toString()
            }
            sub={trimp4wAvg === null ? 'this week' : `4wk avg ${Math.round(trimp4wAvg)}`}
            domain="load"
            onClick={() => setOpenMetricKey('trimp')}
          />
        </div>
        <div className="dashboard-grid--span-2">
          <StatSquare
            label="RHR"
            name="Resting HR"
            value={latestRhr === null ? EM_DASH : Math.round(latestRhr).toString()}
            sub={latestRhr === null ? 'no data' : 'bpm'}
            domain="recovery"
            onClick={() => setOpenMetricKey('rhr')}
          />
        </div>

        <div className="dashboard-grid--span-4">
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
          <button
            type="button"
            className="metric-card metric-card--clickable weight-card"
            onClick={() => setOpenMetricKey('weight')}
            aria-haspopup="dialog"
          >
            <div className="metric-card-eyebrow">Body weight</div>
            <div className="weight-card-value-row">
              <span className="weight-card-value tabular-nums">
                {latestWeight === null ? EM_DASH : `${latestWeight.toFixed(1)} kg`}
              </span>
              {weightDeltaLabel && (
                <span className="weight-card-delta tabular-nums">{weightDeltaLabel}</span>
              )}
            </div>
            <div className="weight-card-date">{weightDateLabel}</div>
            <div className="weight-card-sparkline">
              {weightSparklineData.length > 1 ? (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={weightSparklineData}
                      margin={{ top: 4, right: 3, bottom: 0, left: 3 }}
                    >
                      <defs>
                        <linearGradient id="weight-sparkline-fill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-recovery)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--color-recovery)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <YAxis hide domain={['dataMin - 0.5', 'dataMax + 0.5']} />
                      <Area
                        type="monotone"
                        dataKey="weight"
                        stroke="var(--color-recovery)"
                        strokeWidth={1.5}
                        fill="url(#weight-sparkline-fill)"
                        dot={{
                          r: 2.8,
                          fill: 'var(--color-recovery)',
                          stroke: 'var(--color-surface-elevated)',
                          strokeWidth: 1
                        }}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                  {weightRangeLabel && (
                    <span className="weight-card-range tabular-nums">{weightRangeLabel}</span>
                  )}
                </>
              ) : (
                <span className="weight-card-sparkline-empty">No history yet</span>
              )}
            </div>
          </button>
        </div>

        <div className="dashboard-grid--span-8 dashboard-load-chart-cell">
          <button
            type="button"
            className="dashboard-load-chart-button"
            onClick={() => setOpenMetricKey('ctlAtl')}
            aria-haspopup="dialog"
            aria-label="CTL and ATL training load — open expanded chart"
          >
            <ChartCard
              title="Training load · 90 days"
              span={12}
              headerRight={
                <div className="dashboard-load-chart-key" aria-hidden="true">
                  <span>
                    <i className="dashboard-load-chart-swatch dashboard-load-chart-swatch--ctl" />
                    CTL
                  </span>
                  <span>
                    <i className="dashboard-load-chart-swatch dashboard-load-chart-swatch--atl" />
                    ATL
                  </span>
                </div>
              }
            >
              {hasChartData ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid
                      vertical={false}
                      stroke="var(--color-divider-soft)"
                      strokeOpacity={0.55}
                    />
                    <XAxis
                      dataKey="date"
                      tickFormatter={fmtShortDate}
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
                      domain={loadAxisDomain}
                      ticks={loadAxisTicks}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--color-surface-hover)',
                        border: 'none',
                        borderRadius: 'var(--radius-md)',
                        fontSize: 13
                      }}
                      labelStyle={{ color: 'var(--color-text-secondary)' }}
                      labelFormatter={(label) => fmtShortDate(String(label))}
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

      {openMetricConfig && (
        <MetricDetailModal config={openMetricConfig} onClose={() => setOpenMetricKey(null)} />
      )}
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
