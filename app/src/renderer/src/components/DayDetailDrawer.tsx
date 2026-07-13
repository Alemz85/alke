import { useEffect, type ReactElement, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Heart, X } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { SwimSet, Workout, WorkoutHrSample } from '@shared/types'
import { BadgeDomain } from './BadgeDomain'
import { ModalityIcon } from './ModalityIcon'
import { modalityLabel, modalityToDomain } from './modalityAccent'
import { RouteMap } from './RouteMap'
import { formatLocalTime } from '../hooks/sessionsDate'
import { formatDuration } from '../hooks/sessionsCompute'
import { useWorkoutDetail } from '../hooks/useSessionsData'
import { CHART, chartAxisTickSm } from '../lib/chartTheme'
import { EM_DASH, formatClock, formatPace100 } from '../lib/format'
import { isGymType } from '../lib/periodSummary'
import {
  activeTimePercent,
  buildSetComposition,
  detectSprintSets,
  groupByWorkout,
  normalizeHrTrack,
  paceSecPer100m,
  restRecoveryBpm,
  setAvgHr,
  sprintStats,
  summarizeSession,
  swolf25
} from '../lib/swimSets'
import './DayDetailDrawer.css'

export interface DayDetailDrawerProps {
  dateLabel: string
  workouts: Workout[]
  timezone: string | null | undefined
  onClose: () => void
  children?: ReactNode
}

export function DayDetailDrawer({
  dateLabel,
  workouts,
  timezone,
  onClose,
  children
}: DayDetailDrawerProps): ReactElement {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="day-drawer-overlay" onClick={onClose}>
      <div
        className="day-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Sessions on ${dateLabel}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="day-drawer-header">
          <h3 className="day-drawer-title">{dateLabel}</h3>
          <button type="button" className="day-drawer-close" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        <div className="day-drawer-body">
          {workouts.map((w) => (
            <SessionCard key={w.id} workout={w} timezone={timezone} />
          ))}
          {children}
        </div>
      </div>
    </div>
  )
}

// One {label, value} cell in the organized stat box (day-drawer-session-stats-block).
// `icon` renders before the value (e.g. the Heart glyph on HR stats).
function StatCell({
  label,
  value,
  icon
}: {
  label: string
  value: ReactNode
  icon?: ReactNode
}): ReactElement {
  return (
    <div className="day-drawer-session-stat">
      <span
        className={
          icon
            ? 'day-drawer-session-stat-value day-drawer-session-stat-value--hr tabular-nums'
            : 'day-drawer-session-stat-value tabular-nums'
        }
      >
        {icon}
        {value}
      </span>
      <span className="day-drawer-session-stat-label">{label}</span>
    </div>
  )
}

function SessionCard({
  workout,
  timezone
}: {
  workout: Workout
  timezone: string | null | undefined
}): ReactElement {
  const detailQuery = useWorkoutDetail(workout.id)
  const domain = modalityToDomain(workout.type)
  const badgeDomain = domain === 'neutral' ? 'sessions' : domain
  const distanceKm = workout.distance_m !== null ? (workout.distance_m / 1000).toFixed(2) : null
  const isStrength = isGymType(workout.type)

  const hrSamples = detailQuery.data?.hrSamples ?? []
  const hrChartData = hrSamples.map((s) => ({
    min: Math.round((s.offset_s / 60) * 10) / 10,
    bpm: s.bpm
  }))

  // Gym sessions show simple max/avg HR stats instead of the HR line chart —
  // prefer the workout row's own aggregates, fall back to the fetched trace.
  const gymMaxHr =
    workout.max_hr ?? (hrSamples.length > 0 ? Math.max(...hrSamples.map((s) => s.bpm)) : null)
  const gymAvgHr =
    workout.avg_hr ??
    (hrSamples.length > 0
      ? hrSamples.reduce((sum, s) => sum + s.bpm, 0) / hrSamples.length
      : null)

  const computed = detailQuery.data?.computed
  const trimp = computed?.trimp
  const ef = computed?.ef
  const decoupling = computed?.decoupling_pct

  const swimSets = detailQuery.data?.swimSets ?? []
  const swimSummary = swimSets.length > 0 ? summarizeSession(swimSets) : null
  const swimActiveTimePct =
    swimSets.length > 0 ? activeTimePercent(swimSets, workout.duration_s) : null

  return (
    <div className="day-drawer-session">
      <div className="day-drawer-session-header">
        <div className="day-drawer-session-header-badge">
          <ModalityIcon type={workout.type} size={16} />
          <BadgeDomain domain={badgeDomain} label={modalityLabel(workout.type)} />
        </div>
        <span className="day-drawer-session-time tabular-nums">
          {formatLocalTime(workout.start_at, timezone)}
        </span>
      </div>

      <div className="day-drawer-session-stats-block">
        <div className="day-drawer-session-stats">
          <StatCell label="Duration" value={formatDuration(workout.duration_s ?? 0)} />
          {distanceKm && <StatCell label="Distance" value={`${distanceKm} km`} />}
          <StatCell label="TRIMP" value={trimp != null ? Math.round(trimp) : EM_DASH} />
          {!isStrength && (
            <StatCell label="EF" value={ef != null ? ef.toFixed(2) : EM_DASH} />
          )}
          {!isStrength && (
            <StatCell
              label="Decoupling"
              value={decoupling != null ? `${decoupling.toFixed(1)}%` : EM_DASH}
            />
          )}
          {isStrength && (
            <StatCell
              label="Max HR"
              value={gymMaxHr != null ? Math.round(gymMaxHr) : EM_DASH}
            />
          )}
          {isStrength && (
            <StatCell
              label="Avg HR"
              value={gymAvgHr != null ? Math.round(gymAvgHr) : EM_DASH}
            />
          )}
        </div>

        {swimSummary && (
          <div className="day-drawer-session-stats">
            <StatCell
              label="Avg set pace"
              value={
                swimSummary.avgPaceSecPer100m !== null
                  ? `${formatClock(swimSummary.avgPaceSecPer100m)} /100m`
                  : EM_DASH
              }
            />
            <StatCell
              label="Rest"
              value={
                swimSummary.medianRestS !== null ? `~${Math.round(swimSummary.medianRestS)}s` : EM_DASH
              }
            />
            <StatCell label="Detected sets" value={swimSummary.nSets} />
            <StatCell
              label="Active time"
              value={swimActiveTimePct !== null ? `${Math.round(swimActiveTimePct)}%` : EM_DASH}
            />
            <StatCell
              label="Avg HR"
              value={workout.avg_hr !== null ? Math.round(workout.avg_hr) : EM_DASH}
              icon={
                workout.avg_hr !== null ? (
                  <Heart size={14} strokeWidth={1.75} className="day-drawer-session-stat-hr-icon" />
                ) : undefined
              }
            />
          </div>
        )}
      </div>

      <RouteMap route={detailQuery.data?.route ?? []} geo={detailQuery.data?.geo ?? null} />

      {!isStrength && (
        <div className="day-drawer-hr-chart">
          <div className="day-drawer-section-label">Heart rate</div>
          {detailQuery.isLoading ? (
            <div className="day-drawer-hr-plot day-drawer-hr-plot--empty">
              <span className="day-drawer-empty-text">Loading...</span>
            </div>
          ) : hrChartData.length > 0 ? (
            <div className="day-drawer-hr-plot">
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={hrChartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <XAxis
                    dataKey="min"
                    tick={chartAxisTickSm}
                    axisLine={{ stroke: CHART.grid }}
                    tickLine={false}
                    minTickGap={24}
                    unit="m"
                  />
                  <YAxis tick={chartAxisTickSm} axisLine={false} tickLine={false} width={30} />
                  <Line
                    type="monotone"
                    dataKey="bpm"
                    stroke="var(--color-sessions)"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="day-drawer-hr-plot day-drawer-hr-plot--empty">
              <span className="day-drawer-empty-text">No heart-rate trace for this session.</span>
            </div>
          )}
        </div>
      )}

      {!isStrength && (
        <div className="day-drawer-zones">
          <div className="day-drawer-section-label">Time in zones</div>
          {computed?.time_in_zones ? (
            <TimeInZonesBar zones={computed.time_in_zones} />
          ) : (
            <div className="day-drawer-zones-empty">
              <span className="day-drawer-empty-text">
                Zone breakdown appears once this session is processed.
              </span>
            </div>
          )}
        </div>
      )}

      {swimSets.length > 0 && <SwimSetsSection sets={swimSets} hrSamples={hrSamples} />}

      {swimSets.length > 0 && (
        <SprintsSection sets={swimSets} currentWorkoutId={workout.id} />
      )}
    </div>
  )
}

// Ordered zone keys z1..z5, each mapped to its qualitative zone color token
// (tokens.css) so the bar and legend read the same hues as the rest of the
// app's zone displays — light blue through purple, not a single-hue ramp.
const ZONE_ORDER = ['z1', 'z2', 'z3', 'z4', 'z5'] as const
const ZONE_COLOR: Record<string, string> = {
  z1: 'var(--color-zone1)',
  z2: 'var(--color-zone2)',
  z3: 'var(--color-zone3)',
  z4: 'var(--color-zone4)',
  z5: 'var(--color-zone5)'
}
const ZONE_LABEL: Record<string, string> = { z1: 'Z1', z2: 'Z2', z3: 'Z3', z4: 'Z4', z5: 'Z5' }

function fmtZoneTime(seconds: number): string {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s}s`
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

function TimeInZonesBar({ zones }: { zones: Record<string, unknown> }): ReactElement {
  const entries: [string, number][] = ZONE_ORDER.flatMap((z) => {
    const v = zones[z]
    return typeof v === 'number' ? [[z, v] as [string, number]] : []
  })
  const total = entries.reduce((sum, [, v]) => sum + v, 0)
  if (total === 0) {
    return (
      <div className="day-drawer-zones-empty">
        <span className="day-drawer-empty-text">No zone data recorded for this session.</span>
      </div>
    )
  }
  const shown = entries.filter(([, v]) => v > 0)
  return (
    <>
      <div className="day-drawer-zones-bar">
        {shown.map(([zone, value]) => (
          <div
            key={zone}
            className="day-drawer-zones-segment"
            style={{
              width: `${(value / total) * 100}%`,
              background: ZONE_COLOR[zone] ?? 'var(--color-sessions)'
            }}
            title={`${ZONE_LABEL[zone] ?? zone}: ${fmtZoneTime(value)}`}
          />
        ))}
      </div>
      <div className="day-drawer-zones-legend">
        {shown.map(([zone, value]) => (
          <span key={zone} className="day-drawer-zones-legend-item">
            <span
              className="day-drawer-zones-swatch"
              style={{ background: ZONE_COLOR[zone] ?? 'var(--color-sessions)' }}
            />
            {ZONE_LABEL[zone] ?? zone} <span className="tabular-nums">{fmtZoneTime(value)}</span>
          </span>
        ))}
      </div>
    </>
  )
}

function SetComposition({ sets }: { sets: SwimSet[] }): ReactElement | null {
  const rows = buildSetComposition(sets)
  if (rows.length === 0) return null

  return (
    <div className="day-drawer-set-composition" aria-label="Set composition by distance">
      {rows.map((row) => (
        <div key={row.distanceM} className="day-drawer-set-composition-row">
          <span className="day-drawer-set-composition-distance tabular-nums">
            {row.distanceM}m
          </span>
          <span className="day-drawer-set-composition-track" aria-hidden="true">
            <span
              className="day-drawer-set-composition-bar"
              style={{ width: `${row.barPercent}%` }}
            />
          </span>
          <span className="day-drawer-set-composition-total tabular-nums">
            {row.count} {row.count === 1 ? 'set' : 'sets'} · {row.contributedDistanceM}m
          </span>
        </div>
      ))}
    </div>
  )
}

// Time-proportional session timeline: set blocks sit on the real time axis
// (opacity = pace within the session, strong = fast; gaps = rest) with the HR
// trace overlaid, so recovery dips during rests are visible at a glance.
function SwimTimeline({
  sets,
  paces,
  hrSamples
}: {
  sets: SwimSet[]
  paces: (number | null)[]
  hrSamples: WorkoutHrSample[]
}): ReactElement {
  const first = sets[0]
  const last = sets[sets.length - 1]
  const fromS = first.start_offset_s
  const toS = last.start_offset_s + last.duration_s
  const totalS = Math.max(toS - fromS, 1)
  const known = paces.filter((p): p is number => p !== null)
  const fastest = known.length > 0 ? Math.min(...known) : 0
  const slowest = known.length > 0 ? Math.max(...known) : 0
  const span = Math.max(slowest - fastest, 1e-9)

  const W = 1000
  const H = 64
  const BAR_H = 14
  const track = normalizeHrTrack(hrSamples, fromS, toS)
  const hrPath = track
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'}${(p.t * W).toFixed(1)},${(4 + (1 - p.v) * (H - BAR_H - 12)).toFixed(1)}`
    )
    .join(' ')

  return (
    <svg
      className="day-drawer-swim-timeline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Set timeline with heart-rate overlay"
    >
      {sets.map((s, i) => {
        const pace = paces[i]
        // 0 = slowest, 1 = fastest within this session
        const speed = pace === null ? 0.5 : (slowest - pace) / span
        return (
          <rect
            key={s.set_index}
            x={((s.start_offset_s - fromS) / totalS) * W}
            y={H - BAR_H}
            width={(s.duration_s / totalS) * W}
            height={BAR_H}
            rx={2}
            fill={`color-mix(in srgb, var(--color-aerobic) ${Math.round(35 + speed * 65)}%, transparent)`}
          >
            <title>{`Set ${s.set_index}: ${Math.round(s.distance_m)}m in ${formatClock(s.duration_s)} (${formatPace100(pace)} /100m)`}</title>
          </rect>
        )
      })}
      {hrPath && (
        <path
          d={hrPath}
          fill="none"
          stroke="var(--color-text-tertiary)"
          strokeWidth={1.2}
          vectorEffect="non-scaling-stroke"
          opacity={0.8}
        />
      )}
    </svg>
  )
}

// Swim set breakdown — ingest-detected sets from the watch's per-second swim
// series, with the timeline above and the per-set table below.
function SwimSetsSection({
  sets,
  hrSamples
}: {
  sets: SwimSet[]
  hrSamples: WorkoutHrSample[]
}): ReactElement {
  const paces = sets.map(paceSecPer100m)
  const setHrs = sets.map((s) => setAvgHr(s, hrSamples))
  const hasHr = setHrs.some((v) => v !== null)
  const recoveries = sets
    .map((s) => restRecoveryBpm(s, hrSamples))
    .filter((v): v is number => v !== null)
  const medianRecovery =
    recoveries.length >= 3
      ? [...recoveries].sort((a, b) => a - b)[Math.floor(recoveries.length / 2)]
      : null

  return (
    <div className="day-drawer-swim">
      <div className="day-drawer-section-label">Set composition</div>

      <SetComposition sets={sets} />

      <div className="day-drawer-swim-detail-label">Set timeline</div>

      <SwimTimeline sets={sets} paces={paces} hrSamples={hrSamples} />

      <table className="day-drawer-swim-table">
        <thead>
          <tr>
            <th>#</th>
            <th>m</th>
            <th>time</th>
            <th>/100m</th>
            <th>strokes</th>
            {hasHr && <th title="Average heart rate while swimming this set.">HR</th>}
            <th title="Time + strokes (both hands) per 25m, lower is better. The watch counts arm cycles; they are doubled here assuming freestyle.">
              SWOLF
            </th>
            <th>rest</th>
          </tr>
        </thead>
        <tbody>
          {sets.map((s, i) => {
            const sw = swolf25(s)
            const hr = setHrs[i]
            return (
              <tr key={s.set_index}>
                <td className="tabular-nums">{s.set_index}</td>
                <td className="tabular-nums">{Math.round(s.distance_m)}</td>
                <td className="tabular-nums">{formatClock(s.duration_s)}</td>
                <td className="tabular-nums">{formatPace100(paceSecPer100m(s))}</td>
                <td className="tabular-nums">{Math.round(s.strokes)}</td>
                {hasHr && <td className="tabular-nums">{hr === null ? EM_DASH : Math.round(hr)}</td>}
                <td className="tabular-nums">{sw === null ? EM_DASH : sw.toFixed(1)}</td>
                <td className="tabular-nums">{s.rest_after_s === null ? EM_DASH : `${s.rest_after_s}s`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="day-drawer-swim-caption">
        Sets detected from the watch&apos;s per-second swim samples; strokes are watch-arm counts
        (SWOLF doubles them, assuming freestyle).
        {medianRecovery !== null
          ? ` Rests recover ~${Math.round(medianRecovery)} bpm (median) — shrinking recovery late in a session signals fatigue.`
          : ''}
      </p>
    </div>
  )
}

function fmtSpeed(mps: number): string {
  return `${mps.toFixed(2)} m/s`
}

// Trailing-block sprint detector's own summary card, plus a one-year
// historical lookup (fetched independently so the drawer opens instantly and
// this comparison fills in once it resolves) to say whether today's top
// speed is a new best.
function SprintsSection({
  sets,
  currentWorkoutId
}: {
  sets: SwimSet[]
  currentWorkoutId: string
}): ReactElement | null {
  const sprintSets = detectSprintSets(sets)
  const stats = sprintStats(sprintSets)

  const now = new Date()
  const oneYearAgo = new Date(now)
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
  const nowIso = now.toISOString()
  const oneYearAgoIso = oneYearAgo.toISOString()

  const historyQuery = useQuery<SwimSet[]>({
    queryKey: ['drawer', 'swimSets'],
    queryFn: () => window.api.getSwimSets(oneYearAgoIso, nowIso),
    enabled: stats !== null
  })

  if (stats === null) return null

  let comparisonText = ''
  if (historyQuery.data) {
    const byWorkout = groupByWorkout(historyQuery.data)
    let bestEverMps = 0
    let sessionCount = 0
    for (const [workoutId, workoutSets] of byWorkout) {
      if (workoutId === currentWorkoutId) continue
      const historicalSprints = detectSprintSets(workoutSets)
      const historicalStats = sprintStats(historicalSprints)
      if (historicalStats === null) continue
      sessionCount++
      if (historicalStats.topSpeedMps > bestEverMps) bestEverMps = historicalStats.topSpeedMps
    }
    if (sessionCount === 0) {
      comparisonText = 'First sprint session logged.'
    } else {
      comparisonText = `Best ever: ${bestEverMps.toFixed(2)} m/s across ${sessionCount} sprint session${sessionCount === 1 ? '' : 's'}`
      if (stats.topSpeedMps > bestEverMps) comparisonText += ' — fastest yet'
      comparisonText += '.'
    }
  }

  return (
    <div className="day-drawer-sprints">
      <div className="day-drawer-section-label">Sprints</div>
      <div className="day-drawer-sprints-stats">
        <div className="day-drawer-sprints-stat">
          <span className="day-drawer-sprints-stat-value tabular-nums">
            {fmtSpeed(stats.topSpeedMps)}
          </span>
          <span className="day-drawer-sprints-stat-label">
            Top speed ({formatClock(stats.topPaceSecPer100m)} /100m)
          </span>
        </div>
        <div className="day-drawer-sprints-stat">
          <span className="day-drawer-sprints-stat-value tabular-nums">
            {fmtSpeed(stats.avgSpeedMps)}
          </span>
          <span className="day-drawer-sprints-stat-label">Avg speed</span>
        </div>
        <div className="day-drawer-sprints-stat">
          <span className="day-drawer-sprints-stat-value tabular-nums">
            {stats.count} × ~25m
          </span>
          <span className="day-drawer-sprints-stat-label">Sprints</span>
        </div>
      </div>
      {comparisonText && <p className="day-drawer-sprints-caption">{comparisonText}</p>}
    </div>
  )
}
