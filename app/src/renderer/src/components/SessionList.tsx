import { useMemo, useState, type ReactElement } from 'react'
import type { Workout } from '@shared/types'
import { BadgeDomain } from './BadgeDomain'
import { EmptyState } from './EmptyState'
import { modalityLabel, modalityToDomain } from './modalityAccent'
import { ModalityIcon } from './ModalityIcon'
import { formatWorkoutDuration } from '../lib/calendarDayLabel'
import { localDateKey, toZonedYMD } from '../hooks/sessionsDate'
import './SessionList.css'

const EM_DASH = '—'
const PAGE_SIZE = 20

export interface SessionListProps {
  workouts: Workout[]
  timezone: string | null | undefined
  /** Opens the existing day-detail drawer for the local date key of the clicked row's workout. */
  onSelectDay: (dateKey: string) => void
  /** Hides the Prev/Next pagination row when there's only a single page (default: always shown when >1 page, as before). */
  hidePaginationIfSinglePage?: boolean
}

function fmtDateTime(iso: string, timezone: string | null | undefined): string {
  const ymd = toZonedYMD(iso, timezone)
  const datePart = `${ymd.year.toString().padStart(4, '0')}-${ymd.month.toString().padStart(2, '0')}-${ymd.day.toString().padStart(2, '0')}`
  const tz = timezone || 'UTC'
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso))
  return `${datePart} · ${timePart}`
}

/**
 * The full workout list: most-recent-first, one row per session, paginated
 * client-side at PAGE_SIZE. Clicking a row reuses the Sessions view's
 * existing day-detail drawer (via onSelectDay) rather than opening its own.
 */
export function SessionList({
  workouts,
  timezone,
  onSelectDay,
  hidePaginationIfSinglePage = true
}: SessionListProps): ReactElement {
  const [page, setPage] = useState(0)

  const sorted = useMemo(
    () => [...workouts].sort((a, b) => b.start_at.localeCompare(a.start_at)),
    [workouts]
  )

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const clampedPage = Math.min(page, pageCount - 1)
  const pageItems = sorted.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE)

  if (sorted.length === 0) {
    return <EmptyState message="No sessions yet — workouts appear here after the sync." />
  }

  return (
    <div className="session-list">
      <div className="session-list-rows">
        {pageItems.map((w) => {
          const domain = modalityToDomain(w.type)
          const badgeDomain = domain === 'neutral' ? 'sessions' : domain
          const distanceKm = w.distance_m !== null ? (w.distance_m / 1000).toFixed(2) : null
          const trimp = w.computed?.trimp ?? null

          return (
            <button
              type="button"
              key={w.id}
              className="session-list-row"
              onClick={() => onSelectDay(localDateKey(w.start_at, timezone))}
            >
              <span className="session-list-cell session-list-cell--datetime tabular-nums">
                {fmtDateTime(w.start_at, timezone)}
              </span>
              <span className="session-list-cell session-list-cell--modality">
                <ModalityIcon type={w.type} className="session-list-modality-icon" />
                <BadgeDomain domain={badgeDomain} label={modalityLabel(w.type)} />
              </span>
              <span className="session-list-cell session-list-cell--duration tabular-nums">
                {formatWorkoutDuration(w.duration_s ?? 0)}
              </span>
              <span className="session-list-cell session-list-cell--distance tabular-nums">
                {distanceKm ? `${distanceKm} km` : EM_DASH}
              </span>
              <span className="session-list-cell session-list-cell--trimp tabular-nums">
                {trimp !== null ? Math.round(trimp) : EM_DASH}
              </span>
            </button>
          )
        })}
      </div>

      {(pageCount > 1 || !hidePaginationIfSinglePage) && (
        <div className="session-list-pagination">
          <button
            type="button"
            className="session-list-page-btn"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={clampedPage === 0}
          >
            Prev
          </button>
          <span className="session-list-page-label tabular-nums">
            page {clampedPage + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="session-list-page-btn"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={clampedPage >= pageCount - 1}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
