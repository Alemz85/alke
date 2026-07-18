import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Heart, X } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { GymSession, SwimSet, Workout, WorkoutHrSample } from '@shared/types'
import { BadgeDomain } from './BadgeDomain'
import { ModalityIcon } from './ModalityIcon'
import { modalityLabel, modalityToDomain } from './modalityAccent'
import { RouteMap } from './RouteMap'
import { formatLocalTime } from '../hooks/sessionsDate'
import { formatDuration } from '../hooks/sessionsCompute'
import { useWorkoutDetail } from '../hooks/useSessionsData'
import { useExercises, useGymSessionForWorkout, useGymTemplates } from '../hooks/useGymData'
import { CHART, chartAxisTickSm } from '../lib/chartTheme'
import { EM_DASH, formatClock, formatPace100 } from '../lib/format'
import {
  displayBodyPart,
  formatExerciseSetSummary,
  groupExerciseBlocksByBodyPart,
  groupSetsIntoBlocks,
  sessionBodyParts,
  type ExerciseBlock
} from '../lib/gymLog'
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
  /** Disable the built-in read-only Gym log when the caller supplies an editable one. */
  showGymLog?: boolean
  children?: ReactNode
}

export function DayDetailDrawer({
  dateLabel,
  workouts,
  timezone,
  onClose,
  showGymLog = true,
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
            <SessionCard
              key={w.id}
              workout={w}
              timezone={timezone}
              showGymLog={showGymLog}
            />
          ))}
          {children}
        </div>
      </div>
    </div>
  )
}

// One {label, value} cell in the organized stat box (day-drawer-session-stats-block).
// `icon` renders before the value (e.g. the Heart glyph on HR stats).
interface StatSpec {
  label: string
  value: ReactNode
  icon?: ReactNode
}

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
  timezone,
  showGymLog
}: {
  workout: Workout
  timezone: string | null | undefined
  showGymLog: boolean
}): ReactElement {
  const detailQuery = useWorkoutDetail(workout.id)
  const domain = modalityToDomain(workout.type)
  const badgeDomain = domain === 'neutral' ? 'sessions' : domain
  const distanceKm = workout.distance_m !== null ? (workout.distance_m / 1000).toFixed(2) : null
  const isStrength = isGymType(workout.type)

  // The Gym tab's logged workout details (exercises/sets/notes) — self-sufficient
  // lookup so this section renders identically from Dashboard/Sessions/Gym,
  // not just when opened from the Gym tab. Gated to strength workouts only.
  const gymSessionQuery = useGymSessionForWorkout(
    workout.id,
    workout.start_at,
    isStrength && showGymLog
  )

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

  // Two ordered groups so the box reads top-down: the human, at-a-glance
  // numbers first (duration, distance, pace, rest, HR), the modeled/technical
  // ones below (TRIMP, EF, decoupling, set counts). Each group is one grid row.
  const heartIcon = (
    <Heart size={14} strokeWidth={1.75} className="day-drawer-session-stat-hr-icon" />
  )
  const avgHr = swimSummary ? workout.avg_hr : isStrength ? gymAvgHr : null

  const basicStats: StatSpec[] = [
    { label: 'Duration', value: formatDuration(workout.duration_s ?? 0) }
  ]
  if (distanceKm) basicStats.push({ label: 'Distance', value: `${distanceKm} km` })
  if (workout.energy_kcal !== null) {
    basicStats.push({ label: 'Energy', value: `${Math.round(workout.energy_kcal)} kcal` })
  }
  if (swimSummary) {
    basicStats.push({
      label: 'Avg set pace',
      value:
        swimSummary.avgPaceSecPer100m !== null
          ? `${formatClock(swimSummary.avgPaceSecPer100m)} /100m`
          : EM_DASH
    })
    basicStats.push({
      label: 'Rest',
      value:
        swimSummary.medianRestS !== null ? `~${Math.round(swimSummary.medianRestS)}s` : EM_DASH
    })
  }
  if (swimSummary || isStrength) {
    basicStats.push({
      label: 'Avg HR',
      value: avgHr != null ? Math.round(avgHr) : EM_DASH,
      icon: avgHr != null ? heartIcon : undefined
    })
  }

  const technicalStats: StatSpec[] = [
    { label: 'TRIMP', value: trimp != null ? Math.round(trimp) : EM_DASH }
  ]
  if (!isStrength) {
    technicalStats.push({ label: 'EF', value: ef != null ? ef.toFixed(2) : EM_DASH })
    technicalStats.push({
      label: 'Decoupling',
      value: decoupling != null ? `${decoupling.toFixed(1)}%` : EM_DASH
    })
  }
  if (swimSummary) {
    technicalStats.push({ label: 'Detected sets', value: swimSummary.nSets })
    technicalStats.push({
      label: 'Active time',
      value: swimActiveTimePct !== null ? `${Math.round(swimActiveTimePct)}%` : EM_DASH
    })
  }
  if (isStrength) {
    technicalStats.push({
      label: 'Max HR',
      value: gymMaxHr != null ? Math.round(gymMaxHr) : EM_DASH
    })
  }

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
          {basicStats.map((s) => (
            <StatCell key={s.label} label={s.label} value={s.value} icon={s.icon} />
          ))}
        </div>
        {technicalStats.length > 0 && (
          <div className="day-drawer-session-stats">
            {technicalStats.map((s) => (
              <StatCell key={s.label} label={s.label} value={s.value} icon={s.icon} />
            ))}
          </div>
        )}
      </div>

      {isStrength && showGymLog && (
        <GymLogSection isLoading={gymSessionQuery.isLoading} session={gymSessionQuery.data} />
      )}

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

/** One exercise's set table, collapsed by default — mirrors the Gym tab's
 *  ExerciseDisclosure, minus the edit affordance (this view is read-only). */
function GymLogExerciseDisclosure({
  block,
  blockKey,
  muscleGroup,
  expanded,
  onToggle
}: {
  block: ExerciseBlock
  blockKey: string
  muscleGroup: string | null
  expanded: boolean
  onToggle: () => void
}): ReactElement {
  return (
    <div
      className={
        expanded
          ? 'day-drawer-gymlog-exercise day-drawer-gymlog-exercise--expanded'
          : 'day-drawer-gymlog-exercise'
      }
    >
      <button
        type="button"
        className="day-drawer-gymlog-exercise-toggle"
        aria-expanded={expanded}
        aria-controls={`day-drawer-gymlog-sets-${blockKey}`}
        onClick={onToggle}
      >
        <span className="day-drawer-gymlog-exercise-name">{block.exerciseName}</span>
        <span className="day-drawer-gymlog-exercise-summary tabular-nums">
          {formatExerciseSetSummary(block.sets)}
        </span>
        <ChevronDown
          className="day-drawer-gymlog-exercise-chevron"
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div id={`day-drawer-gymlog-sets-${blockKey}`} className="day-drawer-gymlog-set-table">
          <div className="day-drawer-gymlog-set-row day-drawer-gymlog-set-row--head">
            <span>Set</span>
            <span>Reps</span>
            <span>Load</span>
            <span>Muscle group</span>
          </div>
          {block.sets.map((set, index) => (
            <div key={set.id} className="day-drawer-gymlog-set-row">
              <span className="tabular-nums">{index + 1}</span>
              <span className="tabular-nums">{set.reps ?? EM_DASH}</span>
              <span className="tabular-nums">
                {set.weight_kg == null ? 'BW' : `${set.weight_kg} kg`}
              </span>
              <span>{muscleGroup ? displayBodyPart(muscleGroup) : EM_DASH}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Read-only rendering of a logged strength workout's exercises/sets/notes —
 * the same section the Gym tab shows (GymWorkoutPanel's GymSessionReadView),
 * so opening a strength day from Dashboard or Sessions is no longer a
 * stats-only dead end. No "Edit log" button here: SessionEditorModal pulls in
 * the whole Gym tab's template/exercise-picker machinery, which isn't worth
 * dragging into Dashboard/Sessions — editing stays a Gym-tab action, this is
 * a viewer. `exercisesById`/`templateNameById` are the same cheap, shared,
 * view-neutral queries the Gym tab already uses (staleTime 60s), so mounting
 * them here for the first time (e.g. opening straight into Dashboard) costs
 * one extra pair of small fetches, not a duplicate of Gym-tab state.
 */
function GymLogSection({
  session,
  isLoading
}: {
  session: GymSession | null
  isLoading: boolean
}): ReactElement | null {
  const exercisesQuery = useExercises()
  const templatesQuery = useGymTemplates()
  const exercisesById = useMemo(
    () => new Map((exercisesQuery.data ?? []).map((e) => [e.id, e] as const)),
    [exercisesQuery.data]
  )
  const templateNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of templatesQuery.data ?? []) m.set(t.id, t.name)
    return m
  }, [templatesQuery.data])

  const blocks = useMemo(() => (session ? groupSetsIntoBlocks(session.sets) : []), [session])
  const exerciseGroups = useMemo(
    () => groupExerciseBlocksByBodyPart(blocks, exercisesById),
    [blocks, exercisesById]
  )
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => new Set())

  if (isLoading) {
    return (
      <div className="day-drawer-gymlog">
        <div className="day-drawer-section-label">Workout log</div>
        <div className="day-drawer-zones-empty">
          <span className="day-drawer-empty-text">Loading...</span>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="day-drawer-gymlog">
        <div className="day-drawer-section-label">Workout log</div>
        <div className="day-drawer-zones-empty">
          <span className="day-drawer-empty-text">
            Not logged yet — log this session from the Gym tab.
          </span>
        </div>
      </div>
    )
  }

  const bodyParts = sessionBodyParts(session, exercisesById)
  const appliedTemplates = session.template_ids.flatMap((id) => {
    const name = templateNameById.get(id)
    return name ? [name] : []
  })

  return (
    <div className="day-drawer-gymlog">
      <div className="day-drawer-gymlog-toolbar">
        <div className="day-drawer-gymlog-heading">
          <span className="day-drawer-section-label">Workout log</span>
          <h4 className="day-drawer-gymlog-title">
            {session.title ??
              (session.template_ids[0] ? templateNameById.get(session.template_ids[0]) : null) ??
              'Gym session'}
          </h4>
        </div>
        <span className="day-drawer-gymlog-count tabular-nums">
          {session.sets.filter((set) => !set.is_warmup).length} working sets
        </span>
      </div>

      {(bodyParts.length > 0 || appliedTemplates.length > 0) && (
        <div className="day-drawer-gymlog-chips">
          {bodyParts.map((part) => (
            <span key={part} className="day-drawer-gymlog-chip">
              {displayBodyPart(part)}
            </span>
          ))}
          {appliedTemplates.map((name) => (
            <span key={name} className="day-drawer-gymlog-chip day-drawer-gymlog-chip--template">
              {name}
            </span>
          ))}
        </div>
      )}

      {blocks.length === 0 ? (
        <p className="day-drawer-empty-text">Quick log only. No exercise sets were recorded.</p>
      ) : (
        <div className="day-drawer-gymlog-exercises">
          {exerciseGroups.map((group) => (
            <section key={group.bodyPart} className="day-drawer-gymlog-muscle-group">
              <h5 className="day-drawer-gymlog-muscle-group-title">
                {displayBodyPart(group.bodyPart)}
              </h5>
              <div className="day-drawer-gymlog-muscle-group-list">
                {group.blocks.map((block, blockIndex) => {
                  const blockKey = `${group.bodyPart}-${block.exerciseId}-${blockIndex}`
                  return (
                    <GymLogExerciseDisclosure
                      key={blockKey}
                      block={block}
                      blockKey={blockKey}
                      muscleGroup={group.bodyPart === 'other' ? null : group.bodyPart}
                      expanded={expandedBlocks.has(blockKey)}
                      onToggle={() =>
                        setExpandedBlocks((current) => {
                          const next = new Set(current)
                          if (next.has(blockKey)) next.delete(blockKey)
                          else next.add(blockKey)
                          return next
                        })
                      }
                    />
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {session.notes && (
        <div className="day-drawer-gymlog-notes">
          <span className="day-drawer-gymlog-notes-label">Notes</span>
          <p>{session.notes}</p>
        </div>
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
