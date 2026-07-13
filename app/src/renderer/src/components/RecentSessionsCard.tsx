import { useState, type ReactElement } from 'react'
import { ArrowRight } from 'lucide-react'
import type { Workout } from '@shared/types'
import { EmptyState } from './EmptyState'
import { ModalityIcon } from './ModalityIcon'
import { activityEnvironmentAccent } from './modalityAccent'
import { DayDetailDrawer } from './DayDetailDrawer'
import { EM_DASH, formatDurationHM } from '../lib/format'
import './RecentSessionsCard.css'

export interface RecentSessionsCardProps {
  /** Card heading, e.g. "Recent swim sessions". */
  title: string
  /** Candidate workouts (already scoped to a modality); the newest `limit` show. */
  workouts: Workout[]
  timezone: string | null | undefined
  /** How many rows to show (default 5). */
  limit?: number
  /** The "All sessions →" header link — e.g. jump to the filtered Sessions tab. */
  onOpenAll: () => void
  /** Message when there are no sessions to show. */
  emptyMessage?: string
}

function fmtRowDate(iso: string, timezone: string | null | undefined): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone ?? undefined,
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  }).format(new Date(iso))
}

function fmtFullDate(iso: string, timezone: string | null | undefined): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone ?? undefined,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(iso))
}

/**
 * A compact list of the most recent sessions for one activity. Two distinct
 * interactions: the header's "All sessions →" jumps to the full Sessions list
 * filtered to this activity, while each row opens THAT session in the shared
 * day-detail drawer. Rows give a clear hover cue so it's obvious they're
 * individually clickable.
 */
export function RecentSessionsCard({
  title,
  workouts,
  timezone,
  limit = 5,
  onOpenAll,
  emptyMessage = 'No sessions yet.'
}: RecentSessionsCardProps): ReactElement {
  const [selected, setSelected] = useState<Workout | null>(null)

  const rows = [...workouts]
    .sort((a, b) => b.start_at.localeCompare(a.start_at))
    .slice(0, limit)

  return (
    <div className="recent-card">
      <div className="recent-card-header">
        <h3 className="recent-card-title">{title}</h3>
        <button type="button" className="recent-card-all" onClick={onOpenAll}>
          All sessions
          <ArrowRight size={14} strokeWidth={1.75} />
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <ul className="recent-card-list">
          {rows.map((w) => {
            const distanceKm = w.distance_m !== null ? (w.distance_m / 1000).toFixed(2) : null
            return (
              <li key={w.id}>
                <button
                  type="button"
                  className="recent-card-row"
                  onClick={() => setSelected(w)}
                  aria-label={`${fmtFullDate(w.start_at, timezone)} — open session detail`}
                >
                  <span
                    className="recent-card-row-date"
                    style={{ color: activityEnvironmentAccent(w.type) }}
                  >
                    <ModalityIcon type={w.type} size={15} className="recent-card-row-icon" />
                    <span className="tabular-nums">{fmtRowDate(w.start_at, timezone)}</span>
                  </span>
                  <span className="recent-card-row-meta tabular-nums">
                    {formatDurationHM(w.duration_s ?? 0)}
                    <span className="recent-card-row-dot">·</span>
                    {distanceKm ? `${distanceKm} km` : EM_DASH}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {selected && (
        <DayDetailDrawer
          dateLabel={fmtFullDate(selected.start_at, timezone)}
          workouts={[selected]}
          timezone={timezone}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
