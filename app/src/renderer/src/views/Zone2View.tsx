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
import type { Workout } from '@shared/types'
import { TabHeader } from './TabHeader'
import { ChartCard, EmptyState, HeroMetric, MetricCard, Zone2FitnessHeader } from '../components'
import { isoWeekKey, localDateKey, toZonedYMD } from '../hooks/sessionsDate'
import {
  CARDIO_MODALITIES,
  cardioModalityByKey,
  cardioModalityOf,
  type CardioModalityKey
} from '../lib/cardioModality'
import './Zone2View.css'

const AEROBIC = 'var(--color-aerobic)'
const AEROBIC_DIM = 'var(--color-aerobic-dim)'
const TERTIARY = 'var(--color-text-tertiary)'
const GRID = 'var(--color-divider-soft)'
// Z2 carries the domain accent; other zones are neutral grays so color = Z2.
const ZONE_FILLS = [
  'var(--color-zone-neutral-1)',
  AEROBIC,
  'var(--color-zone-neutral-2)',
  'var(--color-zone-neutral-3)',
  'var(--color-zone-neutral-4)'
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

/** Weekly Z2 minutes over the last `count` ISO weeks for the given workouts. */
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
  const thisWeek = isoWeekKey(toZonedYMD(new Date().toISOString(), timezone))
  const keys = [...new Set([...byWeek.keys(), thisWeek])].sort().slice(-count)
  return keys.map((k) => ({
    week: k.slice(5),
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
  const tizBars = useMemo(
    () => tizRows(workouts.filter((w) => isCardio(w.type)), timezone, 15),
    [workouts, timezone]
  )

  const hasComputed = workouts.some((w) => w.computed != null)

  return (
    <div className="view">
      <TabHeader eyebrow="Aerobic base" title="Zone 2" />

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

      {/* Modality switcher — chip row directly under the hero. */}
      <div className="zone2-switcher" role="tablist" aria-label="Modality">
        <button
          role="tab"
          aria-selected={activeView === 'summary'}
          className={activeView === 'summary' ? 'chip chip--active' : 'chip'}
          onClick={() => setView('summary')}
        >
          Summary
        </button>
        {presentModalities.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={activeView === key}
            className={activeView === key ? 'chip chip--active' : 'chip'}
            onClick={() => setView(key)}
          >
            {cardioModalityByKey(key).label}
          </button>
        ))}
      </div>

      {!hasComputed ? (
        <EmptyState message="No computed zone data yet — the nightly metrics job fills this tab after your first workouts sync." />
      ) : activeView === 'summary' ? (
        <div className="zone2-grid">
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
              Zone 2 carries the teal; other zones are neutral. Minutes per session, Karvonen bounds, swim-adjusted.
            </p>
          </ChartCard>
        </div>
      ) : (
        <ModalityView
          key={activeView}
          modalityKey={activeView}
          workouts={workouts}
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
  timezone: string | null
  efPoints: EfPoint[]
  decouplingPoints: DecouplingPoint[]
}

function ModalityView({
  modalityKey,
  workouts,
  timezone,
  efPoints,
  decouplingPoints
}: ModalityViewProps): ReactElement {
  const modality = cardioModalityByKey(modalityKey)

  // Workouts of this modality with computed zones.
  const modalityWorkouts = useMemo(
    () => workouts.filter((w) => hasZones(w) && cardioModalityOf(w.type) === modalityKey),
    [workouts, modalityKey]
  )

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

  const isSwim = modalityKey === 'swim'

  return (
    <>
      <div className="zone2-stat-row">
        <MetricCard
          eyebrow={`${modality.label} · Z2 this week`}
          value={String(thisWeekMin)}
          domain="aerobic"
          caption="minutes in Zone 2"
        />
        <MetricCard eyebrow={`${modality.label} · sessions 90d`} value={String(sessions90d)} caption="with zone data" />
        <MetricCard
          eyebrow={`${modality.label} · avg Z2 share`}
          value={`${avgZ2Share}%`}
          domain="aerobic"
          caption="Z2 / classified time, 90d"
        />
      </div>

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
