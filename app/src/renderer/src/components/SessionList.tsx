import { useMemo, useState, type ReactElement } from 'react'
import { Heart } from 'lucide-react'
import type { Workout } from '@shared/types'
import { ActivityBadge } from './ActivityBadge'
import { EmptyState } from './EmptyState'
import { activityEnvironmentAccent, modalityLabel } from './modalityAccent'
import { ModalityIcon } from './ModalityIcon'
import { EM_DASH, formatDurationHM } from '../lib/format'
import { localDateKey, toZonedYMD } from '../hooks/sessionsDate'
import './SessionList.css'

const PAGE_SIZE = 10

export interface SessionListProps {
  workouts: Workout[]
  timezone: string | null | undefined
  /** Opens the existing day-detail drawer for the local date key of the clicked row's workout. */
  onSelectDay: (dateKey: string) => void
  /** Hides the Prev/Next pagination row when there's only a single page (default: always shown when >1 page, as before). */
  hidePaginationIfSinglePage?: boolean
  /** Message shown when there are no rows (e.g. filtered to empty). */
  emptyMessage?: string
}

/**
 * Splits a workout start into a readable date (weekday-short + day + short
 * month, appending the year only when it isn't the current one) and a
 * de-emphasized HH:MM time. The year is dropped for current-year rows to keep
 * the column tight; older rows carry it so history stays unambiguous.
 */
function fmtDateParts(
  iso: string,
  timezone: string | null | undefined
): { date: string; time: string } {
  const tz = timezone || 'UTC'
  const ymd = toZonedYMD(iso, timezone)
  const currentYear = toZonedYMD(new Date().toISOString(), timezone).year
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(ymd.year !== currentYear ? { year: 'numeric' } : {})
  }).format(new Date(iso))
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso))
  return { date, time }
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
  hidePaginationIfSinglePage = true,
  emptyMessage = 'No sessions yet — workouts appear here after the sync.'
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
    return <EmptyState message={emptyMessage} />
  }

  return (
    <div className="session-list">
      <div className="session-list-header" aria-hidden="true">
        <span className="session-list-col-label">Date</span>
        <span className="session-list-col-label">Activity</span>
        <span className="session-list-col-label session-list-col-label--num">Duration</span>
        <span className="session-list-col-label session-list-col-label--num">Distance</span>
        <span className="session-list-col-label session-list-col-label--num">TRIMP</span>
        <span className="session-list-col-label session-list-col-label--num">Avg HR</span>
      </div>
      <div className="session-list-rows">
        {pageItems.map((w) => {
          const distanceKm = w.distance_m !== null ? (w.distance_m / 1000).toFixed(2) : null
          const trimp = w.computed?.trimp ?? null
          const { date, time } = fmtDateParts(w.start_at, timezone)

          return (
            <button
              type="button"
              key={w.id}
              className="session-list-row"
              onClick={() => onSelectDay(localDateKey(w.start_at, timezone))}
            >
              <span className="session-list-cell session-list-cell--datetime">
                <span className="session-list-date tabular-nums">{date}</span>
                <span className="session-list-time tabular-nums">{time}</span>
              </span>
              <span
                className="session-list-cell session-list-cell--modality"
                style={{ color: activityEnvironmentAccent(w.type) }}
              >
                <ModalityIcon type={w.type} className="session-list-modality-icon" />
                <ActivityBadge type={w.type} label={modalityLabel(w.type)} />
              </span>
              <span className="session-list-cell session-list-cell--duration tabular-nums">
                {formatDurationHM(w.duration_s ?? 0)}
              </span>
              <span className="session-list-cell session-list-cell--distance tabular-nums">
                {distanceKm ? `${distanceKm} km` : EM_DASH}
              </span>
              <span className="session-list-cell session-list-cell--trimp tabular-nums">
                {trimp !== null ? Math.round(trimp) : EM_DASH}
              </span>
              <span className="session-list-cell session-list-cell--avghr tabular-nums">
                {w.avg_hr !== null ? (
                  <>
                    <Heart size={12} strokeWidth={1.75} className="session-list-avghr-icon" />
                    {Math.round(w.avg_hr)}
                  </>
                ) : (
                  EM_DASH
                )}
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
