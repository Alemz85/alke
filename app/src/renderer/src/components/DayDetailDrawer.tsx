import { useEffect, type ReactElement } from 'react'
import { X } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { Workout } from '@shared/types'
import { BadgeDomain } from './BadgeDomain'
import { modalityLabel, modalityToDomain } from './modalityAccent'
import { formatLocalTime } from '../hooks/sessionsDate'
import { formatDuration } from '../hooks/sessionsCompute'
import { useWorkoutDetail } from '../hooks/useSessionsData'
import './DayDetailDrawer.css'

const EM_DASH = '—'

export interface DayDetailDrawerProps {
  dateLabel: string
  workouts: Workout[]
  timezone: string | null | undefined
  onClose: () => void
}

export function DayDetailDrawer({
  dateLabel,
  workouts,
  timezone,
  onClose
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
        </div>
      </div>
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

  const hrSamples = detailQuery.data?.hrSamples ?? []
  const hrChartData = hrSamples.map((s) => ({
    min: Math.round((s.offset_s / 60) * 10) / 10,
    bpm: s.bpm
  }))

  const computed = detailQuery.data?.computed
  const trimp = computed?.trimp
  const ef = computed?.ef
  const decoupling = computed?.decoupling_pct

  return (
    <div className="day-drawer-session">
      <div className="day-drawer-session-header">
        <BadgeDomain domain={badgeDomain} label={modalityLabel(workout.type)} />
        <span className="day-drawer-session-time tabular-nums">
          {formatLocalTime(workout.start_at, timezone)}
        </span>
      </div>

      <div className="day-drawer-session-stats">
        <div className="day-drawer-session-stat">
          <span className="day-drawer-session-stat-value tabular-nums">
            {formatDuration(workout.duration_s ?? 0)}
          </span>
          <span className="day-drawer-session-stat-label">Duration</span>
        </div>
        {distanceKm && (
          <div className="day-drawer-session-stat">
            <span className="day-drawer-session-stat-value tabular-nums">{distanceKm} km</span>
            <span className="day-drawer-session-stat-label">Distance</span>
          </div>
        )}
        <div className="day-drawer-session-stat">
          <span className="day-drawer-session-stat-value tabular-nums">
            {trimp != null ? Math.round(trimp) : EM_DASH}
          </span>
          <span className="day-drawer-session-stat-label">TRIMP</span>
        </div>
        <div className="day-drawer-session-stat">
          <span className="day-drawer-session-stat-value tabular-nums">
            {ef != null ? ef.toFixed(2) : EM_DASH}
          </span>
          <span className="day-drawer-session-stat-label">EF</span>
        </div>
        <div className="day-drawer-session-stat">
          <span className="day-drawer-session-stat-value tabular-nums">
            {decoupling != null ? `${decoupling.toFixed(1)}%` : EM_DASH}
          </span>
          <span className="day-drawer-session-stat-label">Decoupling</span>
        </div>
      </div>

      <div className="day-drawer-hr-chart">
        <div className="day-drawer-section-label">Heart rate</div>
        {detailQuery.isLoading ? (
          <div className="day-drawer-hr-plot day-drawer-hr-plot--empty">
            <span className="day-drawer-empty-text">Loading...</span>
          </div>
        ) : hrChartData.length > 0 ? (
          <div className="day-drawer-hr-plot">
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={hrChartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="min"
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  axisLine={{ stroke: 'var(--color-divider-soft)' }}
                  tickLine={false}
                  minTickGap={24}
                  unit="m"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
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
    </div>
  )
}

// Ordered zone keys z1..z5. Each zone gets a luminance step within the sessions
// (orange) domain — lightest for easy Z1, full accent for hard Z5 — so the bar
// reads as one domain, never borrowing another family's hue.
const ZONE_ORDER = ['z1', 'z2', 'z3', 'z4', 'z5'] as const
const ZONE_OPACITY: Record<string, number> = { z1: 0.28, z2: 0.45, z3: 0.62, z4: 0.8, z5: 1 }
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
              background: `color-mix(in srgb, var(--color-sessions) ${(ZONE_OPACITY[zone] ?? 1) * 100}%, transparent)`
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
              style={{ background: `color-mix(in srgb, var(--color-sessions) ${(ZONE_OPACITY[zone] ?? 1) * 100}%, transparent)` }}
            />
            {ZONE_LABEL[zone] ?? zone} <span className="tabular-nums">{fmtZoneTime(value)}</span>
          </span>
        ))}
      </div>
    </>
  )
}
