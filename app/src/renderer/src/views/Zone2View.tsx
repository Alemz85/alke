import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { SwimSet, Workout } from '@shared/types'
import { TabHeader } from './TabHeader'
import {
  ChartCard,
  EmptyState,
  MetricCard,
  RecentSessionsCard,
  Zone2FitnessHeader
} from '../components'
import { Zone2HrZonesCard } from '../components/Zone2FitnessHeader'
import { addDays, isoWeekKey, isoWeekStart, localDateKey, toZonedYMD } from '../hooks/sessionsDate'
import {
  CARDIO_MODALITIES,
  cardioModalityByKey,
  cardioModalityOf,
  type CardioModalityKey
} from '../lib/cardioModality'
import { CHART, chartTooltipStyle } from '../lib/chartTheme'
import { buildNumericAxis } from '../lib/cardioChartScales'
import { EM_DASH, formatPace100 } from '../lib/format'
import { groupByWorkout, summarizeSession } from '../lib/swimSets'
import { fastest100, fastest25, monthlyAvgPace } from '../lib/swimTrends'
import { weekLabel } from '../lib/weekLabel'
import { RunningView } from './RunningView'
import './Zone2View.css'

const AEROBIC = CHART.aerobic
const AEROBIC_DIM = CHART.aerobicDim
const TERTIARY = CHART.tertiary
const GRID = CHART.grid
// Z2 carries the domain accent; other zones use the qualitative zone tokens.
const ZONE_FILLS = [
  'var(--color-zone1)',
  'var(--color-zone2)',
  'var(--color-zone3)',
  'var(--color-zone4)',
  'var(--color-zone5)'
]
const CHART_CURSOR = CHART.cursor

type ViewKey = 'summary' | CardioModalityKey

function z2Seconds(w: Workout): number {
  const tiz = w.computed?.time_in_zones as Record<string, number> | null | undefined
  return typeof tiz?.z2 === 'number' ? tiz.z2 : 0
}

function isCardio(type: string | null): boolean {
  return !!type && !/strength|core|other/.test(type)
}

function hasZones(w: Workout): boolean {
  return w.computed?.time_in_zones != null
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

/** Formats a 'YYYY-MM' month key as "Jun 2026". */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTH_SHORT_NAMES[m - 1]} ${y}`
}

function formatSwimDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  const kilometers = meters / 1000
  return `${kilometers >= 10 ? kilometers.toFixed(0) : kilometers.toFixed(1)} km`
}

function SwimChartKey({
  items
}: {
  items: Array<{ label: string; tone?: 'aerobic' | 'neutral'; dashed?: boolean }>
}): ReactElement {
  return (
    <div className="zone2-chart-key" aria-label="Chart legend">
      {items.map((item) => (
        <span key={item.label}>
          <i
            className={`zone2-chart-key-swatch zone2-chart-key-swatch--${item.tone ?? 'aerobic'}${item.dashed ? ' zone2-chart-key-swatch--dashed' : ''}`}
          />
          {item.label}
        </span>
      ))}
    </div>
  )
}

// --- shared chart bodies (reused by Summary and modality views) ---

interface WeeklyBarsProps {
  data: { week: string; key: string; minutes: number }[]
  targetMin?: number
}

/** Weekly Z2 minutes bar chart. Target line drawn only when `targetMin` given. */
function WeeklyZ2Bars({ data, targetMin }: WeeklyBarsProps): ReactElement {
  const axis = buildNumericAxis([...data.map((row) => row.minutes), targetMin], {
    includeZero: true,
    tickCount: 4
  })
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="week"
          interval="preserveStartEnd"
          minTickGap={16}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={axis.domain}
          ticks={axis.ticks}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          width={42}
        />
        <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: CHART_CURSOR }} />
        {targetMin != null && (
          <ReferenceLine
            y={targetMin}
            stroke={TERTIARY}
            strokeDasharray="4 4"
            label={{
              value: `${targetMin} min target`,
              fill: TERTIARY,
              fontSize: 11,
              position: 'insideTopRight'
            }}
          />
        )}
        <Bar dataKey="minutes" fill={AEROBIC} radius={[4, 4, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  )
}

interface TizBar {
  date: string
  z1: number
  z2: number
  z3: number
  z4: number
  z5: number
}

/** Stacked time-in-zones bars. */
function TimeInZonesStacks({ data }: { data: TizBar[] }): ReactElement {
  const axis = buildNumericAxis(
    data.map((row) => row.z1 + row.z2 + row.z3 + row.z4 + row.z5),
    { includeZero: true, tickCount: 4 }
  )
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          minTickGap={16}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={axis.domain}
          ticks={axis.ticks}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          width={42}
        />
        <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: CHART_CURSOR }} />
        {(['z1', 'z2', 'z3', 'z4', 'z5'] as const).map((z, i) => (
          <Bar key={z} dataKey={z} stackId="tiz" fill={ZONE_FILLS[i]} maxBarSize={32} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

interface EfPoint {
  t: number
  date: string
  ef: number
  median: number
}

function EfScatter({ data }: { data: EfPoint[] }): ReactElement {
  const axis = buildNumericAxis(
    data.flatMap((row) => [row.ef, row.median]),
    { tickCount: 4 }
  )
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          minTickGap={24}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={axis.domain}
          ticks={axis.ticks}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => v.toFixed(2)}
          width={46}
        />
        <Tooltip
          contentStyle={chartTooltipStyle}
          formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : v)}
        />
        <Scatter dataKey="ef" fill={AEROBIC} />
        <Line dataKey="median" stroke={AEROBIC} strokeWidth={1.5} dot={false} type="monotone" />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/** Dual-axis session trend: DPS (m/cycle, left) and stroke rate (cycles/min, right). */
function StrokeMechanicsChart({
  data
}: {
  data: { date: string; dpsMPerCycle: number | null; strokeRatePerMin: number | null }[]
}): ReactElement {
  const dpsAxis = buildNumericAxis(
    data.map((row) => row.dpsMPerCycle),
    { tickCount: 4 }
  )
  const rateAxis = buildNumericAxis(
    data.map((row) => row.strokeRatePerMin),
    { tickCount: 4 }
  )
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 0, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          minTickGap={24}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="dps"
          domain={dpsAxis.domain}
          ticks={dpsAxis.ticks}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => v.toFixed(1)}
          width={44}
        />
        <YAxis
          yAxisId="rate"
          orientation="right"
          domain={rateAxis.domain}
          ticks={rateAxis.ticks}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => v.toFixed(1)}
          width={44}
        />
        <Tooltip
          contentStyle={chartTooltipStyle}
          formatter={(v, name) =>
            typeof v === 'number'
              ? name === 'dpsMPerCycle'
                ? [`${v.toFixed(2)} m/cycle`, 'DPS']
                : [`${v.toFixed(1)} cycles/min`, 'stroke rate']
              : v
          }
        />
        <Line
          yAxisId="dps"
          dataKey="dpsMPerCycle"
          stroke={AEROBIC}
          strokeWidth={1.5}
          dot
          type="monotone"
        />
        <Line
          yAxisId="rate"
          dataKey="strokeRatePerMin"
          stroke={TERTIARY}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          type="monotone"
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

interface SwimTrendChartProps {
  data: { date: string; [k: string]: unknown }[]
  dataKey: string
  format: (v: number) => string
  /** Friendly series name shown in the tooltip instead of the raw dataKey. */
  label: string
  axisFormat: (v: number) => string
}

function SwimTrendChart({
  data,
  dataKey,
  format,
  label,
  axisFormat
}: SwimTrendChartProps): ReactElement {
  const axis = buildNumericAxis(
    data.map((row) => (typeof row[dataKey] === 'number' ? (row[dataKey] as number) : null)),
    { tickCount: 4 }
  )
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          minTickGap={24}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={axis.domain}
          ticks={axis.ticks}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={axisFormat}
          width={46}
        />
        <Tooltip
          contentStyle={chartTooltipStyle}
          formatter={(v) => (typeof v === 'number' ? [format(v), label] : v)}
        />
        <Line
          dataKey={dataKey}
          name={label}
          stroke={AEROBIC}
          strokeWidth={2.25}
          dot={{ r: 3 }}
          type="monotone"
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

interface DecouplingPoint {
  t: number
  date: string
  pct: number
}

function DecouplingScatter({ data }: { data: DecouplingPoint[] }): ReactElement {
  const axis = buildNumericAxis([...data.map((row) => row.pct), -5, 5], { tickCount: 4 })
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          minTickGap={24}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={axis.domain}
          ticks={axis.ticks}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${v}%`}
          width={42}
        />
        <Tooltip
          contentStyle={chartTooltipStyle}
          formatter={(v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : v)}
        />
        <ReferenceArea y1={-5} y2={5} fill={AEROBIC_DIM} strokeOpacity={0} />
        <Scatter dataKey="pct" fill={AEROBIC} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// --- data helpers ---

/**
 * Weekly Z2 minutes over the CONTINUOUS last `count` ISO weeks ending at the
 * current week — zero-filled for weeks with no Z2, not just weeks that
 * happen to have data. Monday-anchored, per isoWeekKey.
 */
function weeklyZ2(
  workouts: Workout[],
  timezone: string | null,
  count: number
): { week: string; key: string; minutes: number }[] {
  const byWeek = new Map<string, number>()
  for (const w of workouts) {
    const key = isoWeekKey(toZonedYMD(w.start_at, timezone))
    byWeek.set(key, (byWeek.get(key) ?? 0) + z2Seconds(w))
  }
  const thisWeekYmd = toZonedYMD(new Date().toISOString(), timezone)
  const thisMonday = isoWeekStart(thisWeekYmd)
  const keys: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const monday = addDays(thisMonday, -7 * i)
    keys.push(isoWeekKey(monday))
  }
  return keys.map((k) => ({
    week: weekLabel(k),
    key: k,
    minutes: Math.round((byWeek.get(k) ?? 0) / 60)
  }))
}

/** Time-in-zones stacked-bar rows for the last `count` sessions (already filtered). */
function tizRows(workouts: Workout[], timezone: string | null, count: number): TizBar[] {
  return workouts
    .filter(hasZones)
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .slice(-count)
    .map((w) => {
      const tiz = w.computed!.time_in_zones as Record<string, number>
      return {
        date: localDateKey(w.start_at, timezone).slice(5),
        z1: Math.round((tiz.z1 ?? 0) / 60),
        z2: Math.round((tiz.z2 ?? 0) / 60),
        z3: Math.round((tiz.z3 ?? 0) / 60),
        z4: Math.round((tiz.z4 ?? 0) / 60),
        z5: Math.round((tiz.z5 ?? 0) / 60)
      }
    })
}

interface Zone2ViewProps {
  onOpenSessions: (activity?: string) => void
}

export function Zone2View({ onOpenSessions }: Zone2ViewProps): ReactElement {
  const yearAgo = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 366)
    return d.toISOString()
  }, [])
  const workoutsQuery = useQuery({
    // Versioned because the previous cache entry covered only 366 days.
    queryKey: ['zone2', 'workouts', 'all-history'],
    queryFn: () => window.api.getWorkouts('1970-01-01T00:00:00.000Z', new Date().toISOString()),
    staleTime: 60_000
  })
  const swimSetsQuery = useQuery({
    queryKey: ['zone2', 'swimSets'],
    queryFn: () => window.api.getSwimSets(yearAgo, new Date().toISOString()),
    staleTime: 60_000
  })
  const configQuery = useQuery({
    queryKey: ['zone2', 'config'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })
  const timezone = configQuery.data?.timezone ?? null
  const weeklyTargetMin = configQuery.data?.zone2_weekly_target_min ?? 90
  const workouts = useMemo(() => workoutsQuery.data ?? [], [workoutsQuery.data])

  const [view, setView] = useState<ViewKey>('summary')

  // A modality tab represents recorded history, not HR availability. Imported
  // runs without zone data must remain navigable; each view owns its HR state.
  const presentModalities = useMemo(() => {
    const present = new Set<CardioModalityKey>()
    for (const w of workouts) {
      const key = cardioModalityOf(w.type)
      if (key) present.add(key)
    }
    return CARDIO_MODALITIES.filter((m) => present.has(m.key)).map((m) => m.key)
  }, [workouts])

  // If the selected modality vanishes (data reload), fall back to Summary.
  const activeView: ViewKey =
    view === 'summary' || presentModalities.includes(view) ? view : 'summary'

  // --- weekly Z2 minutes, all cardio (feeds the summary chart) ---
  const weekly = useMemo(() => weeklyZ2(workouts, timezone, 12), [workouts, timezone])

  // --- Summary: EF trend (eligible swims, 90d) ---
  const efPoints = useMemo<EfPoint[]>(() => {
    const cutoff = Date.now() - 90 * 86400_000
    const pts = workouts
      .filter(
        (w) =>
          cardioModalityOf(w.type) === 'swim' &&
          w.computed?.ef != null &&
          new Date(w.start_at).getTime() >= cutoff
      )
      .map((w) => ({
        t: new Date(w.start_at).getTime(),
        date: localDateKey(w.start_at, timezone),
        ef: w.computed!.ef as number
      }))
      .sort((a, b) => a.t - b.t)
    return pts.map((p, i) => {
      const window = pts
        .slice(Math.max(0, i - 4), i + 1)
        .map((x) => x.ef)
        .sort((a, b) => a - b)
      const mid = Math.floor(window.length / 2)
      const median = window.length % 2 ? window[mid] : (window[mid - 1] + window[mid]) / 2
      return { ...p, median }
    })
  }, [workouts, timezone])

  // --- Summary: decoupling per eligible session ---
  const decouplingPoints = useMemo<DecouplingPoint[]>(
    () =>
      workouts
        .filter((w) => cardioModalityOf(w.type) === 'swim' && w.computed?.decoupling_pct != null)
        .map((w) => ({
          t: new Date(w.start_at).getTime(),
          date: localDateKey(w.start_at, timezone),
          pct: w.computed!.decoupling_pct as number
        }))
        .sort((a, b) => a.t - b.t),
    [workouts, timezone]
  )

  // --- Summary: time-in-zones, last 15 cardio sessions ---
  const cardioWorkouts = useMemo(() => workouts.filter((w) => isCardio(w.type)), [workouts])
  const tizBars = useMemo(() => tizRows(cardioWorkouts, timezone, 15), [cardioWorkouts, timezone])

  const hasComputed = workouts.some((w) => w.computed != null)

  return (
    <div className="view">
      <TabHeader eyebrow="Aerobic base · Zone 2" title="Cardio" />

      {/* Modality switcher — a real section-tab bar, first element under the
          header so it governs everything below it, summary included. */}
      <div className="zone2-tabs" role="tablist" aria-label="Modality">
        <button
          role="tab"
          aria-selected={activeView === 'summary'}
          className={activeView === 'summary' ? 'zone2-tab zone2-tab--active' : 'zone2-tab'}
          onClick={() => setView('summary')}
        >
          Summary
        </button>
        {presentModalities.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={activeView === key}
            className={activeView === key ? 'zone2-tab zone2-tab--active' : 'zone2-tab'}
            onClick={() => setView(key)}
          >
            {cardioModalityByKey(key).label}
          </button>
        ))}
      </div>

      {activeView === 'summary' && (
        /* Zone-2 fitness model: durable base + sharpness, calendar with degradation
           trail, honesty labels, maintenance nudge (docs/zone2-fitness-model.md §10). */
        <Zone2FitnessHeader timezone={timezone} />
      )}

      {activeView === 'summary' && !hasComputed ? (
        <EmptyState message="No computed zone data yet — the nightly metrics job fills this tab after your first workouts sync." />
      ) : activeView === 'summary' ? (
        <div className="zone2-grid">
          <ChartCard title="Weekly Zone 2 minutes" span={12}>
            <WeeklyZ2Bars data={weekly} targetMin={weeklyTargetMin} />
          </ChartCard>

          <ChartCard title="HR zones · Karvonen" span={12}>
            <Zone2HrZonesCard timezone={timezone} />
          </ChartCard>

          <ChartCard title="Time in zones — last 15 cardio sessions" span={12}>
            <TimeInZonesStacks data={tizBars} />
            <p className="zone2-caption">
              Zone 2 carries the accent; other zones use the qualitative zone palette. Minutes per
              session, Karvonen bounds, swim-adjusted.
            </p>
          </ChartCard>
        </div>
      ) : activeView === 'running' ? (
        <RunningView
          workouts={workouts.filter((workout) => cardioModalityOf(workout.type) === 'running')}
          timezone={timezone}
          onOpenSessions={onOpenSessions}
        />
      ) : (
        <ModalityView
          key={activeView}
          modalityKey={activeView}
          workouts={workouts}
          swimSets={swimSetsQuery.data ?? []}
          timezone={timezone}
          efPoints={efPoints}
          decouplingPoints={decouplingPoints}
          onOpenSessions={onOpenSessions}
        />
      )}
    </div>
  )
}

interface ModalityViewProps {
  modalityKey: CardioModalityKey
  workouts: Workout[]
  swimSets: SwimSet[]
  timezone: string | null
  efPoints: EfPoint[]
  decouplingPoints: DecouplingPoint[]
  onOpenSessions: (activity?: string) => void
}

function ModalityView({
  modalityKey,
  workouts,
  swimSets,
  timezone,
  efPoints,
  decouplingPoints,
  onOpenSessions
}: ModalityViewProps): ReactElement {
  const modality = cardioModalityByKey(modalityKey)

  const isSwim = modalityKey === 'swim'

  // Workouts of this modality with computed zones.
  const modalityWorkouts = useMemo(
    () => workouts.filter((w) => hasZones(w) && cardioModalityOf(w.type) === modalityKey),
    [workouts, modalityKey]
  )

  // All workouts of this modality, unfiltered by zones — the recent-sessions
  // card shows every session, not just ones the nightly job has classified yet.
  // Also feeds the swim-only stat block below (sessions this week/month).
  const allModalityWorkouts = useMemo(
    () => workouts.filter((w) => cardioModalityOf(w.type) === modalityKey),
    [workouts, modalityKey]
  )
  const swimWorkouts = allModalityWorkouts

  // Per-session swim set summaries, oldest→newest, joined to workout dates.
  // Uses the UNFILTERED `workouts` prop (not modalityWorkouts, which requires
  // hasZones — set data is available immediately, zones are not).
  const swimSessionRows = useMemo(() => {
    if (!isSwim || swimSets.length === 0) return []
    const byWorkout = groupByWorkout(swimSets)
    return workouts
      .filter((w) => byWorkout.has(w.id))
      .sort((a, b) => a.start_at.localeCompare(b.start_at))
      .map((w) => ({
        date: localDateKey(w.start_at, timezone).slice(5),
        fullDate: localDateKey(w.start_at, timezone),
        ...summarizeSession(byWorkout.get(w.id)!)
      }))
  }, [isSwim, swimSets, workouts, timezone])

  // Fastest /100m pace among sets of ≥~100m (see swimTrends.fastest100 — an
  // 80m set should never win this card), dated for the caption.
  const swimFastest100 = useMemo(() => {
    if (!isSwim || swimSets.length === 0) return null
    const effort = fastest100(swimSets)
    if (!effort) return null
    const w = workouts.find((x) => x.id === effort.workoutId)
    return { ...effort, date: w ? localDateKey(w.start_at, timezone) : '' }
  }, [isSwim, swimSets, workouts, timezone])

  // --- Swim stat area: sessions this week/month, monthly pace trend, fastest efforts ---
  const swimStats = useMemo(() => {
    if (!isSwim) return null
    const todayKey = localDateKey(new Date().toISOString(), timezone)
    const thisIsoWeek = isoWeekKey(toZonedYMD(new Date().toISOString(), timezone))
    const thisYm = todayKey.slice(0, 7)
    const sessionsThisWeek = swimWorkouts.filter(
      (w) => isoWeekKey(toZonedYMD(w.start_at, timezone)) === thisIsoWeek
    ).length
    const sessionsThisMonth = swimWorkouts.filter(
      (w) => localDateKey(w.start_at, timezone).slice(0, 7) === thisYm
    ).length

    const monthOfWorkout = (workoutId: string): string | null => {
      const w = workouts.find((x) => x.id === workoutId)
      return w ? localDateKey(w.start_at, timezone).slice(0, 7) : null
    }
    const paceByMonth = monthlyAvgPace(groupByWorkout(swimSets), monthOfWorkout)
    const monthDistanceM = swimSessionRows
      .filter((row) => row.fullDate.slice(0, 7) === thisYm)
      .reduce((sum, row) => sum + row.setDistanceM, 0)

    const fastest25Effort = fastest25(swimSets)
    const fastest25Date = fastest25Effort
      ? (() => {
          const w = workouts.find((x) => x.id === fastest25Effort.workoutId)
          return w ? localDateKey(w.start_at, timezone) : ''
        })()
      : ''

    return {
      sessionsThisWeek,
      sessionsThisMonth,
      monthDistanceM,
      paceByMonth,
      fastest25Effort,
      fastest25Date
    }
  }, [isSwim, workouts, swimSets, swimWorkouts, swimSessionRows, timezone])

  // --- stat row: this-week Z2 min (modality), sessions 90d, avg Z2 share 90d ---
  const weekly = useMemo(
    () => weeklyZ2(modalityWorkouts, timezone, 12),
    [modalityWorkouts, timezone]
  )
  const thisWeekMin = weekly.length > 0 ? weekly[weekly.length - 1].minutes : 0

  const { sessions90d, avgZ2Share } = useMemo(() => {
    const cutoff = Date.now() - 90 * 86400_000
    const recent = modalityWorkouts.filter((w) => new Date(w.start_at).getTime() >= cutoff)
    let z2Sum = 0
    let totalSum = 0
    for (const w of recent) {
      const tiz = w.computed!.time_in_zones as Record<string, number>
      const total = (['z1', 'z2', 'z3', 'z4', 'z5'] as const).reduce((s, z) => s + (tiz[z] ?? 0), 0)
      z2Sum += tiz.z2 ?? 0
      totalSum += total
    }
    return {
      sessions90d: recent.length,
      avgZ2Share: totalSum > 0 ? Math.round((z2Sum / totalSum) * 100) : 0
    }
  }, [modalityWorkouts])

  const tizBars = useMemo(
    () => tizRows(modalityWorkouts, timezone, 15),
    [modalityWorkouts, timezone]
  )

  return (
    <>
      {isSwim ? (
        <section className="zone2-swim-overview" aria-label="Swimming overview">
          <div className="zone2-swim-overview-top">
            <div className="zone2-swim-volume">
              <span className="zone2-swim-eyebrow">Swimming · this month</span>
              <strong className="zone2-swim-volume-value tabular-nums">
                {formatSwimDistance(swimStats?.monthDistanceM ?? 0)}
              </strong>
              <span className="zone2-swim-volume-caption">Detected set distance</span>
            </div>
            <div className="zone2-swim-facts">
              <div>
                <span>Sessions this week</span>
                <strong className="tabular-nums">{swimStats?.sessionsThisWeek ?? 0}</strong>
              </div>
              <div>
                <span>Sessions this month</span>
                <strong className="tabular-nums">{swimStats?.sessionsThisMonth ?? 0}</strong>
              </div>
              <div>
                <span>Fastest /100m</span>
                <strong className="tabular-nums">
                  {swimFastest100 ? formatPace100(swimFastest100.paceSecPer100m) : EM_DASH}
                </strong>
                <small>{swimFastest100 ? swimFastest100.date : 'Needs a 100m set'}</small>
              </div>
              <div>
                <span>Fastest 25m equiv.</span>
                <strong className="tabular-nums">
                  {swimStats?.fastest25Effort
                    ? `${swimStats.fastest25Effort.seconds.toFixed(1)}s`
                    : EM_DASH}
                </strong>
                <small>
                  {swimStats?.fastest25Effort ? swimStats.fastest25Date : 'Needs a ≥25m set'}
                </small>
              </div>
            </div>
          </div>
          <div className="zone2-swim-pace-history">
            <span className="zone2-swim-pace-history-label">Monthly average pace</span>
            {swimStats && swimStats.paceByMonth.length > 0 ? (
              <div className="zone2-swim-pace-months">
                {swimStats.paceByMonth.slice(-5).map((row) => (
                  <div key={row.month}>
                    <span>{monthLabel(row.month)}</span>
                    <strong className="tabular-nums">{formatPace100(row.paceSecPer100m)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <span className="zone2-swim-pace-empty">
                Pace history appears after swim sets sync.
              </span>
            )}
          </div>
        </section>
      ) : (
        <div className="zone2-stat-row">
          <MetricCard
            eyebrow={`${modality.label} · Z2 this week`}
            value={String(thisWeekMin)}
            domain="aerobic"
            caption="minutes in Zone 2"
          />
          <MetricCard
            eyebrow={`${modality.label} · sessions 90d`}
            value={String(sessions90d)}
            caption="with zone data"
          />
          <MetricCard
            eyebrow={`${modality.label} · avg Z2 share`}
            value={`${avgZ2Share}%`}
            domain="aerobic"
            caption="Z2 / classified time, 90d"
          />
        </div>
      )}

      <div className="zone2-grid">
        <ChartCard
          title={`${modality.label} Zone 2`}
          span={12}
          headerRight={<span className="zone2-chart-unit">12 weeks · minutes</span>}
        >
          {weekly.every((w) => w.minutes === 0) ? (
            <EmptyState
              message={`No ${modality.label.toLowerCase()} Zone 2 minutes in the last 12 weeks yet.`}
            />
          ) : (
            <>
              <WeeklyZ2Bars data={weekly} />
              <p className="zone2-caption">
                No target line — the 90-min target is whole-body aerobic, not per-modality.
              </p>
            </>
          )}
        </ChartCard>

        {isSwim ? (
          <>
            <div className="zone2-section-heading chart-card--span-12">
              <h2>Technique and pace</h2>
              <p>Session-level trends from the individual sets detected by Apple Health.</p>
            </div>

            <ChartCard
              title="Set pace"
              span={6}
              headerRight={<span className="zone2-chart-unit">per 100m</span>}
            >
              {swimSessionRows.length === 0 ? (
                <EmptyState message="No swim set data yet — sets appear as soon as a pool swim syncs." />
              ) : (
                <>
                  <SwimTrendChart
                    data={swimSessionRows}
                    dataKey="avgPaceSecPer100m"
                    format={(v) =>
                      `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')} /100m`
                    }
                    axisFormat={(v) =>
                      `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}`
                    }
                    label="Pace"
                  />
                  <p className="zone2-caption">Set-weighted pace per session — down is faster.</p>
                </>
              )}
            </ChartCard>

            <ChartCard
              title="SWOLF efficiency"
              span={6}
              headerRight={<span className="zone2-chart-unit">25m normalized</span>}
            >
              {swimSessionRows.length === 0 ? (
                <EmptyState message="No swim set data yet — sets appear as soon as a pool swim syncs." />
              ) : (
                <>
                  <SwimTrendChart
                    data={swimSessionRows}
                    dataKey="medianSwolf25"
                    format={(v) => v.toFixed(1)}
                    axisFormat={(v) => v.toFixed(0)}
                    label="SWOLF"
                  />
                  <p className="zone2-caption">
                    Median (time + both-hands strokes) per 25m — freestyle assumption, lower is
                    better.
                  </p>
                </>
              )}
            </ChartCard>

            <ChartCard
              title="Stroke mechanics"
              span={12}
              headerRight={
                <SwimChartKey
                  items={[
                    { label: 'Distance / cycle' },
                    { label: 'Stroke rate', tone: 'neutral', dashed: true }
                  ]}
                />
              }
            >
              {swimSessionRows.length === 0 ? (
                <EmptyState message="No swim set data yet." />
              ) : (
                <>
                  <StrokeMechanicsChart data={swimSessionRows} />
                  <p className="zone2-caption">
                    Distance per stroke cycle (teal, left) vs stroke rate (gray, right). Longer
                    glide at a steady rate = technique improving; rate creeping up to hold pace =
                    fighting the water.
                  </p>
                </>
              )}
            </ChartCard>

            <div className="zone2-section-heading chart-card--span-12">
              <h2>Aerobic response</h2>
              <p>Heart-rate efficiency and stability from eligible steady swimming.</p>
            </div>

            <ChartCard
              title="Efficiency factor"
              span={6}
              headerRight={<span className="zone2-chart-unit">90 days</span>}
            >
              {efPoints.length === 0 ? (
                <EmptyState message="No eligible swims in the last 90 days — EF needs ≥20 min mostly in Z1–Z2." />
              ) : (
                <>
                  <EfScatter data={efPoints} />
                  <p className="zone2-caption">
                    Output per heartbeat. A rising median suggests more speed for the same effort.
                  </p>
                </>
              )}
            </ChartCard>

            <ChartCard
              title="Aerobic stability"
              span={6}
              headerRight={<span className="zone2-chart-unit">decoupling</span>}
            >
              {decouplingPoints.length === 0 ? (
                <EmptyState message="No eligible sessions yet — decoupling uses the same swims as EF." />
              ) : (
                <>
                  <DecouplingScatter data={decouplingPoints} />
                  <p className="zone2-caption">
                    Inside the ±5% band means effort stayed aerobically steady.
                  </p>
                </>
              )}
            </ChartCard>
          </>
        ) : (
          <ChartCard title="Efficiency factor" span={12}>
            <p className="zone2-ef-explainer">
              EF needs a reliable output signal (distance). {modality.label} sessions don&apos;t
              carry one — zones and duration still count toward your aerobic base.
              {modalityKey === 'rowing'
                ? ' If your erg reports distance and you start logging it, EF switches on here.'
                : ''}
            </p>
          </ChartCard>
        )}

        <ChartCard
          title="Session intensity mix"
          span={12}
          headerRight={<span className="zone2-chart-unit">last 15 · minutes</span>}
        >
          {tizBars.length === 0 ? (
            <EmptyState
              message={`No ${modality.label.toLowerCase()} sessions with zone data yet.`}
            />
          ) : (
            <>
              <TimeInZonesStacks data={tizBars} />
              <p className="zone2-caption">
                Zone 2 carries the teal; other zones are neutral. Minutes per session, Karvonen
                bounds.
              </p>
            </>
          )}
        </ChartCard>

        <div className="chart-card--span-12">
          <RecentSessionsCard
            title={`Recent ${modality.label.toLowerCase()} sessions`}
            workouts={allModalityWorkouts}
            timezone={timezone}
            onOpenAll={() => onOpenSessions(modality.label)}
          />
        </div>
      </div>
    </>
  )
}
