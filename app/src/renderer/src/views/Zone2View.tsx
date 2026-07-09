import { useMemo } from 'react'
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
import { ChartCard, EmptyState, FlagBanner, HeroMetric } from '../components'
import { isoWeekKey, localDateKey, toZonedYMD } from '../hooks/sessionsDate'
import './Zone2View.css'

const AEROBIC = 'var(--color-aerobic)'
const AEROBIC_DIM = 'var(--color-aerobic-dim)'
const TERTIARY = 'var(--color-text-tertiary)'
const GRID = 'var(--color-divider-soft)'
const WEEKLY_TARGET_MIN = 90 // modest default per spec; editable in user_config later
// Z2 carries the domain accent; other zones are neutral grays so color = Z2.
const ZONE_FILLS = [
  'rgba(255,255,255,0.10)',
  AEROBIC,
  'rgba(255,255,255,0.22)',
  'rgba(255,255,255,0.34)',
  'rgba(255,255,255,0.46)'
]

function z2Seconds(w: Workout): number {
  const tiz = w.computed?.time_in_zones as Record<string, number> | null | undefined
  return typeof tiz?.z2 === 'number' ? tiz.z2 : 0
}

function isCardio(type: string | null): boolean {
  return !!type && !/strength|core|other/.test(type)
}

const tooltipStyle = {
  backgroundColor: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 12,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums' as const
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
  const flagsQuery = useQuery({
    queryKey: ['zone2', 'flags'],
    queryFn: () => window.api.getTodayFlags(),
    staleTime: 60_000
  })

  const timezone = configQuery.data?.timezone ?? null
  const workouts = useMemo(() => workoutsQuery.data ?? [], [workoutsQuery.data])

  // --- weekly Z2 minutes, last 12 ISO weeks ---
  const weekly = useMemo(() => {
    const byWeek = new Map<string, number>()
    for (const w of workouts) {
      const key = isoWeekKey(toZonedYMD(w.start_at, timezone))
      byWeek.set(key, (byWeek.get(key) ?? 0) + z2Seconds(w))
    }
    const thisWeek = isoWeekKey(toZonedYMD(new Date().toISOString(), timezone))
    const keys = [...new Set([...byWeek.keys(), thisWeek])].sort().slice(-12)
    return keys.map((k) => ({
      week: k.slice(5),
      key: k,
      minutes: Math.round((byWeek.get(k) ?? 0) / 60)
    }))
  }, [workouts, timezone])

  const thisWeekMin = weekly.length > 0 ? weekly[weekly.length - 1].minutes : 0
  const lastWeekMin = weekly.length > 1 ? weekly[weekly.length - 2].minutes : null
  const delta =
    lastWeekMin === null
      ? undefined
      : `${thisWeekMin - lastWeekMin >= 0 ? '+' : ''}${thisWeekMin - lastWeekMin} min vs last week`

  // --- EF trend: eligible swims, 90d, with rolling median of last 5 ---
  const efPoints = useMemo(() => {
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

  // --- decoupling per eligible session ---
  const decouplingPoints = useMemo(
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

  // --- time-in-zones stacked bars, last 15 cardio sessions ---
  const tizBars = useMemo(
    () =>
      workouts
        .filter((w) => isCardio(w.type) && w.computed?.time_in_zones)
        .sort((a, b) => a.start_at.localeCompare(b.start_at))
        .slice(-15)
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
        }),
    [workouts, timezone]
  )

  const hasComputed = workouts.some((w) => w.computed != null)

  return (
    <div className="view">
      <TabHeader eyebrow="Aerobic base" title="Zone 2" />
      {(flagsQuery.data ?? []).map((flag, i) => (
        <FlagBanner key={`${flag.type}-${i}`} message={flag.message} severity={flag.severity === 'info' ? 'info' : 'warn'} />
      ))}
      <HeroMetric
        eyebrow="Zone 2 · this week"
        value={String(thisWeekMin)}
        unit="min"
        delta={delta}
        domain="aerobic"
        deltaPositive={lastWeekMin !== null && thisWeekMin >= lastWeekMin}
      />

      {!hasComputed ? (
        <EmptyState message="No computed zone data yet — the nightly metrics job fills this tab after your first workouts sync." />
      ) : (
        <div className="zone2-grid">
          <ChartCard title="Weekly Zone 2 minutes" span={12}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={weekly} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="week" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <ReferenceLine
                  y={WEEKLY_TARGET_MIN}
                  stroke={TERTIARY}
                  strokeDasharray="4 4"
                  label={{
                    value: `${WEEKLY_TARGET_MIN} min target`,
                    fill: TERTIARY,
                    fontSize: 11,
                    position: 'insideTopRight'
                  }}
                />
                <Bar dataKey="minutes" fill={AEROBIC} radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Efficiency factor — swims" span={6}>
            {efPoints.length === 0 ? (
              <EmptyState message="No eligible swims in the last 90 days — EF needs ≥20 min mostly in Z1–Z2." />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={efPoints} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis
                      domain={['auto', 'auto']}
                      tick={{ fill: TERTIARY, fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => v.toFixed(2)}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : v)}
                    />
                    <Scatter dataKey="ef" fill={AEROBIC} />
                    <Line dataKey="median" stroke={AEROBIC} strokeWidth={1.5} dot={false} type="monotone" />
                  </ComposedChart>
                </ResponsiveContainer>
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
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={decouplingPoints} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis
                      tick={{ fill: TERTIARY, fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : v)}
                    />
                    <ReferenceArea y1={-5} y2={5} fill={AEROBIC_DIM} strokeOpacity={0} />
                    <Scatter dataKey="pct" fill={AEROBIC} />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="zone2-caption">Within ±5% (shaded) = aerobically steady for the session.</p>
              </>
            )}
          </ChartCard>

          <ChartCard title="Time in zones — last 15 cardio sessions" span={12}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={tizBars} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: TERTIARY, fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                {(['z1', 'z2', 'z3', 'z4', 'z5'] as const).map((z, i) => (
                  <Bar key={z} dataKey={z} stackId="tiz" fill={ZONE_FILLS[i]} maxBarSize={32} />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <p className="zone2-caption">
              Zone 2 carries the teal; other zones are neutral. Minutes per session, Karvonen bounds, swim-adjusted.
            </p>
          </ChartCard>
        </div>
      )}
    </div>
  )
}
