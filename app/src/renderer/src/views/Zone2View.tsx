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
  HeroMetric,
  MetricCard,
  StatTable,
  Zone2FitnessHeader
} from '../components'
import type { StatTableRow } from '../components'
import { addDays, isoWeekKey, isoWeekStart, localDateKey, toZonedYMD } from '../hooks/sessionsDate'
import {
  CARDIO_MODALITIES,
  cardioModalityByKey,
  cardioModalityOf,
  type CardioModalityKey
} from '../lib/cardioModality'
import { bestEfforts, groupByWorkout, summarizeSession } from '../lib/swimSets'
import { fastest25, monthlyAvgPace } from '../lib/swimTrends'
import { weekLabel } from '../lib/weekLabel'
import { monthSummary } from '../lib/periodSummary'
import type { SummaryItem } from '../lib/periodSummary'
import { EM_DASH, fmtDelta, fmtDuration } from './dashboardUtils'
import './Zone2View.css'

const AEROBIC = 'var(--color-aerobic)'
const AEROBIC_DIM = 'var(--color-aerobic-dim)'
const TERTIARY = 'var(--color-text-tertiary)'
const GRID = 'var(--color-divider-soft)'
// Z2 carries the domain accent; other zones use the qualitative zone tokens.
const ZONE_FILLS = [
  'var(--color-zone1)',
  'var(--color-zone2)',
  'var(--color-zone3)',
  'var(--color-zone4)',
  'var(--color-zone5)'
]
const CHART_CURSOR = 'var(--color-chart-cursor)'

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

/** Formats a sec/100m pace as m:ss. */
function fmtPace100(pace: number): string {
  const m = Math.floor(pace / 60)
  const s = Math.round(pace % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
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

const tooltipStyle = {
  backgroundColor: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 12,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums' as const
}

// --- shared chart bodies (reused by Summary and modality views) ---

interface WeeklyBarsProps {
  data: { week: string; key: string; minutes: number }[]
  targetMin?: number
}

/** Weekly Z2 minutes bar chart. Target line drawn only when `targetMin` given. */
function WeeklyZ2Bars({ data, targetMin }: WeeklyBarsProps): ReactElement {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="week" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: CHART_CURSOR }} />
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
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: CHART_CURSOR }} />
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
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          domain={['auto', 'auto']}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => v.toFixed(2)}
        />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : v)} />
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
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: -8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          yAxisId="dps"
          domain={['auto', 'auto']}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => v.toFixed(1)}
        />
        <YAxis
          yAxisId="rate"
          orientation="right"
          domain={['auto', 'auto']}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => v.toFixed(1)}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v, name) =>
            typeof v === 'number'
              ? name === 'dpsMPerCycle'
                ? [`${v.toFixed(2)} m/cycle`, 'DPS']
                : [`${v.toFixed(1)} cycles/min`, 'stroke rate']
              : v
          }
        />
        <Line yAxisId="dps" dataKey="dpsMPerCycle" stroke={AEROBIC} strokeWidth={1.5} dot type="monotone" />
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
}

function SwimTrendChart({ data, dataKey, format }: SwimTrendChartProps): ReactElement {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          domain={['auto', 'auto']}
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v) => (typeof v === 'number' ? format(v) : v)}
        />
        <Scatter dataKey={dataKey} fill={AEROBIC} />
        <Line dataKey={dataKey} stroke={AEROBIC} strokeWidth={1.5} dot={false} type="monotone" />
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
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fill: TERTIARY, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : v)} />
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

export function Zone2View(): ReactElement {
  const yearAgo = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 366)
    return d.toISOString()
  }, [])
  const workoutsQuery = useQuery({
    queryKey: ['zone2', 'workouts'],
    queryFn: () => window.api.getWorkouts(yearAgo, new Date().toISOString()),
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

  // Modalities that actually have ≥1 workout with computed zones, in canonical order.
  const presentModalities = useMemo(() => {
    const present = new Set<CardioModalityKey>()
    for (const w of workouts) {
      if (!hasZones(w)) continue
      const key = cardioModalityOf(w.type)
      if (key) present.add(key)
    }
    return CARDIO_MODALITIES.filter((m) => present.has(m.key)).map((m) => m.key)
  }, [workouts])

  // If the selected modality vanishes (data reload), fall back to Summary.
  const activeView: ViewKey =
    view === 'summary' || presentModalities.includes(view) ? view : 'summary'

  // --- tab-level hero: Z2 min this ISO week, all cardio ---
  const weekly = useMemo(() => weeklyZ2(workouts, timezone, 12), [workouts, timezone])
  const thisWeekMin = weekly.length > 0 ? weekly[weekly.length - 1].minutes : 0
  const lastWeekMin = weekly.length > 1 ? weekly[weekly.length - 2].minutes : null
  const delta =
    lastWeekMin === null
      ? undefined
      : `${thisWeekMin - lastWeekMin >= 0 ? '+' : ''}${thisWeekMin - lastWeekMin} min vs last week`

  // --- Summary: EF trend (eligible swims, 90d) ---
  const efPoints = useMemo<EfPoint[]>(() => {
    const cutoff = Date.now() - 90 * 86400_000
    const pts = workouts
      .filter((w) => w.computed?.ef != null && new Date(w.start_at).getTime() >= cutoff)
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
        .filter((w) => w.computed?.decoupling_pct != null)
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

  // --- Summary: current-month cardio summary blocks ---
  const todayKey = localDateKey(new Date().toISOString(), timezone)
  const viewedYm = todayKey.slice(0, 7)
  const cardioMonth = useMemo(() => {
    const items: SummaryItem[] = cardioWorkouts.map((w) => ({
      dateKey: localDateKey(w.start_at, timezone),
      durationS: w.duration_s ?? 0,
      type: w.type
    }))
    return monthSummary(items, viewedYm, todayKey)
  }, [cardioWorkouts, timezone, viewedYm, todayKey])
  const cardioZ2MinThisMonth = useMemo(
    () =>
      Math.round(
        cardioWorkouts
          .filter((w) => localDateKey(w.start_at, timezone).slice(0, 7) === viewedYm)
          .reduce((sum, w) => sum + z2Seconds(w), 0) / 60
      ),
    [cardioWorkouts, timezone, viewedYm]
  )

  const hasComputed = workouts.some((w) => w.computed != null)

  const cardioTimeTrend =
    cardioMonth.timeTrendPct === null
      ? EM_DASH
      : `${fmtDelta(cardioMonth.timeTrendPct, 0)}% vs last month`

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
        <>
          {/* Zone-2 fitness model: durable base + sharpness, calendar with degradation
              trail, honesty labels, maintenance nudge (docs/zone2-fitness-model.md §10). */}
          <Zone2FitnessHeader timezone={timezone} />

          <HeroMetric
            eyebrow="Zone 2 · this week"
            value={String(thisWeekMin)}
            unit="min"
            delta={delta}
            domain="aerobic"
            deltaPositive={lastWeekMin !== null && thisWeekMin >= lastWeekMin}
          />
        </>
      )}

      {!hasComputed ? (
        <EmptyState message="No computed zone data yet — the nightly metrics job fills this tab after your first workouts sync." />
      ) : activeView === 'summary' ? (
        <div className="zone2-grid">
          <MetricCard
            eyebrow="Cardio sessions · this month"
            value={String(cardioMonth.cardioSessions)}
            domain="aerobic"
            caption="cardio workouts logged"
          />
          <MetricCard
            eyebrow="Cardio time · this month"
            value={fmtDuration(cardioMonth.totalDurationS)}
            caption="total cardio duration"
          />
          <MetricCard
            eyebrow="Z2 minutes · this month"
            value={String(cardioZ2MinThisMonth)}
            domain="aerobic"
            caption="time in Zone 2, all cardio"
          />
          <MetricCard
            eyebrow="Time trend"
            value={cardioTimeTrend}
            caption="cardio time vs comparable window last month"
          />

          <ChartCard title="Weekly Zone 2 minutes" span={12}>
            <WeeklyZ2Bars data={weekly} targetMin={weeklyTargetMin} />
          </ChartCard>

          <ChartCard title="Efficiency factor — swims" span={6}>
            {efPoints.length === 0 ? (
              <EmptyState message="No eligible swims in the last 90 days — EF needs ≥20 min mostly in Z1–Z2." />
            ) : (
              <>
                <EfScatter data={efPoints} />
                <p className="zone2-caption">
                  Output per heartbeat — up and to the right means the base is rebuilding.
                </p>
              </>
            )}
          </ChartCard>

          <ChartCard title="Decoupling per session" span={6}>
            {decouplingPoints.length === 0 ? (
              <EmptyState message="No eligible sessions yet — decoupling uses the same swims as EF." />
            ) : (
              <>
                <DecouplingScatter data={decouplingPoints} />
                <p className="zone2-caption">Within ±5% (shaded) = aerobically steady for the session.</p>
              </>
            )}
          </ChartCard>

          <ChartCard title="Time in zones — last 15 cardio sessions" span={12}>
            <TimeInZonesStacks data={tizBars} />
            <p className="zone2-caption">
              Zone 2 carries the accent; other zones use the qualitative zone palette. Minutes per
              session, Karvonen bounds, swim-adjusted.
            </p>
          </ChartCard>
        </div>
      ) : (
        <ModalityView
          key={activeView}
          modalityKey={activeView}
          workouts={workouts}
          swimSets={swimSetsQuery.data ?? []}
          timezone={timezone}
          efPoints={efPoints}
          decouplingPoints={decouplingPoints}
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
}

function ModalityView({
  modalityKey,
  workouts,
  swimSets,
  timezone,
  efPoints,
  decouplingPoints
}: ModalityViewProps): ReactElement {
  const modality = cardioModalityByKey(modalityKey)

  const isSwim = modalityKey === 'swim'

  // Workouts of this modality with computed zones.
  const modalityWorkouts = useMemo(
    () => workouts.filter((w) => hasZones(w) && cardioModalityOf(w.type) === modalityKey),
    [workouts, modalityKey]
  )

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

  // Best efforts across all sessions with set data, dated for the captions.
  const swimBest = useMemo(() => {
    if (!isSwim || swimSets.length === 0) return null
    const dateOf = (id: string): string => {
      const w = workouts.find((x) => x.id === id)
      return w ? localDateKey(w.start_at, timezone) : ''
    }
    return { ...bestEfforts(groupByWorkout(swimSets)), dateOf }
  }, [isSwim, swimSets, workouts, timezone])

  // --- Swim stat area: sessions this week/month, monthly pace trend, fastest efforts ---
  const swimStats = useMemo(() => {
    if (!isSwim) return null
    const todayKey = localDateKey(new Date().toISOString(), timezone)
    const thisIsoWeek = isoWeekKey(toZonedYMD(new Date().toISOString(), timezone))
    const thisYm = todayKey.slice(0, 7)
    const swimWorkouts = workouts.filter((w) => cardioModalityOf(w.type) === 'swim')
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

    const fastest25Effort = fastest25(swimSets)
    const fastest25Date = fastest25Effort
      ? (() => {
          const w = workouts.find((x) => x.id === fastest25Effort.workoutId)
          return w ? localDateKey(w.start_at, timezone) : ''
        })()
      : ''

    return { sessionsThisWeek, sessionsThisMonth, paceByMonth, fastest25Effort, fastest25Date }
  }, [isSwim, workouts, swimSets, timezone])

  // --- stat row: this-week Z2 min (modality), sessions 90d, avg Z2 share 90d ---
  const weekly = useMemo(() => weeklyZ2(modalityWorkouts, timezone, 12), [modalityWorkouts, timezone])
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

  const tizBars = useMemo(() => tizRows(modalityWorkouts, timezone, 15), [modalityWorkouts, timezone])

  const paceTableRows: StatTableRow[] =
    swimStats && swimStats.paceByMonth.length > 0
      ? swimStats.paceByMonth.map((row) => ({
          label: monthLabel(row.month),
          value: fmtPace100(row.paceSecPer100m)
        }))
      : []

  return (
    <>
      {isSwim ? (
        <div className="zone2-swim-stats">
          <MetricCard
            eyebrow="Swim · sessions this week"
            value={String(swimStats?.sessionsThisWeek ?? 0)}
            domain="aerobic"
            caption="ISO week to date"
          />
          <MetricCard
            eyebrow="Swim · sessions this month"
            value={String(swimStats?.sessionsThisMonth ?? 0)}
            domain="aerobic"
            caption="calendar month to date"
          />
          <div className="zone2-swim-pace-table">
            <h3 className="zone2-swim-pace-table-title">Avg pace /100m by month</h3>
            {paceTableRows.length === 0 ? (
              <EmptyState message="No swim set data yet." />
            ) : (
              <StatTable rows={paceTableRows} />
            )}
          </div>
          <MetricCard
            eyebrow="Swim · fastest /100m"
            value={swimBest?.fastestSet ? fmtPace100(swimBest.fastestSet.paceSecPer100m) : '—'}
            domain="aerobic"
            caption={
              swimBest?.fastestSet
                ? `${Math.round(swimBest.fastestSet.distanceM)}m set · ${swimBest.dateOf(swimBest.fastestSet.workoutId)}`
                : 'needs a set of 45m or more'
            }
          />
          <MetricCard
            eyebrow="Swim · fastest 25m"
            value={swimStats?.fastest25Effort ? `${swimStats.fastest25Effort.seconds.toFixed(1)}s` : '—'}
            domain="aerobic"
            caption={
              swimStats?.fastest25Effort
                ? `25m-equivalent · ${swimStats.fastest25Date}`
                : 'needs a set of 25m or more'
            }
          />
        </div>
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
        <ChartCard title={`Weekly Zone 2 minutes — ${modality.label.toLowerCase()}`} span={12}>
          {weekly.every((w) => w.minutes === 0) ? (
            <EmptyState message={`No ${modality.label.toLowerCase()} Zone 2 minutes in the last 12 weeks yet.`} />
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
            <ChartCard title="Efficiency factor — swims" span={6}>
              {efPoints.length === 0 ? (
                <EmptyState message="No eligible swims in the last 90 days — EF needs ≥20 min mostly in Z1–Z2." />
              ) : (
                <>
                  <EfScatter data={efPoints} />
                  <p className="zone2-caption">
                    Output per heartbeat — up and to the right means the base is rebuilding.
                  </p>
                </>
              )}
            </ChartCard>

            <ChartCard title="Decoupling per session" span={6}>
              {decouplingPoints.length === 0 ? (
                <EmptyState message="No eligible sessions yet — decoupling uses the same swims as EF." />
              ) : (
                <>
                  <DecouplingScatter data={decouplingPoints} />
                  <p className="zone2-caption">Within ±5% (shaded) = aerobically steady for the session.</p>
                </>
              )}
            </ChartCard>

            <ChartCard title="Set pace — swims" span={6}>
              {swimSessionRows.length === 0 ? (
                <EmptyState message="No swim set data yet — sets appear as soon as a pool swim syncs." />
              ) : (
                <>
                  <SwimTrendChart
                    data={swimSessionRows}
                    dataKey="avgPaceSecPer100m"
                    format={(v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')} /100m`}
                  />
                  <p className="zone2-caption">
                    Set-weighted pace per session — down is faster.
                  </p>
                </>
              )}
            </ChartCard>

            <ChartCard title="SWOLF — swims" span={6}>
              {swimSessionRows.length === 0 ? (
                <EmptyState message="No swim set data yet — sets appear as soon as a pool swim syncs." />
              ) : (
                <>
                  <SwimTrendChart data={swimSessionRows} dataKey="medianSwolf25" format={(v) => v.toFixed(1)} />
                  <p className="zone2-caption">
                    Median (time + both-hands strokes) per 25m — freestyle assumption, lower is better.
                  </p>
                </>
              )}
            </ChartCard>

            <ChartCard title="Stroke mechanics — swims" span={12}>
              {swimSessionRows.length === 0 ? (
                <EmptyState message="No swim set data yet." />
              ) : (
                <>
                  <StrokeMechanicsChart data={swimSessionRows} />
                  <p className="zone2-caption">
                    Distance per stroke cycle (teal, left) vs stroke rate (gray, right). Longer glide at a
                    steady rate = technique improving; rate creeping up to hold pace = fighting the water.
                  </p>
                </>
              )}
            </ChartCard>

            <ChartCard title="Recent swim sessions" span={12}>
              {swimSessionRows.length === 0 ? (
                <EmptyState message="No swim set data yet." />
              ) : (
                <table className="zone2-swim-sessions">
                  <thead>
                    <tr>
                      <th>date</th>
                      <th>structure</th>
                      <th>set distance</th>
                      <th>rest</th>
                      <th>fade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {swimSessionRows
                      .slice(-8)
                      .reverse()
                      .map((row) => (
                        <tr key={row.fullDate}>
                          <td className="tabular-nums">{row.fullDate}</td>
                          <td>{row.structure}</td>
                          <td className="tabular-nums">{Math.round(row.setDistanceM)}m</td>
                          <td className="tabular-nums">
                            {row.medianRestS === null ? '—' : `~${Math.round(row.medianRestS)}s`}
                          </td>
                          <td className="tabular-nums">
                            {row.fadePct === null ? '—' : `${row.fadePct >= 0 ? '+' : ''}${row.fadePct.toFixed(1)}%`}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </ChartCard>
          </>
        ) : (
          <ChartCard title="Efficiency factor" span={12}>
            <p className="zone2-ef-explainer">
              EF needs a reliable output signal (distance). {modality.label} sessions don&apos;t carry one — zones and
              duration still count toward your aerobic base.
              {modalityKey === 'rowing'
                ? ' If your erg reports distance and you start logging it, EF switches on here.'
                : ''}
            </p>
          </ChartCard>
        )}

        <ChartCard title={`Time in zones — last 15 ${modality.label.toLowerCase()} sessions`} span={12}>
          {tizBars.length === 0 ? (
            <EmptyState message={`No ${modality.label.toLowerCase()} sessions with zone data yet.`} />
          ) : (
            <>
              <TimeInZonesStacks data={tizBars} />
              <p className="zone2-caption">
                Zone 2 carries the teal; other zones are neutral. Minutes per session, Karvonen bounds.
              </p>
            </>
          )}
        </ChartCard>
      </div>
    </>
  )
}
