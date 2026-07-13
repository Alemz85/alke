import { useMemo, useState, type ReactElement } from 'react'
import type { Exercise } from '@shared/types'
import { ActivityBadge } from '../../components/ActivityBadge'
import { EmptyState } from '../../components/EmptyState'
import { ButtonSoft } from '../../components/ButtonSoft'
import { ModalityIcon } from '../../components/ModalityIcon'
import { displayBodyPart, sessionBodyParts } from '../../lib/gymLog'
import { EM_DASH, formatDurationHM } from '../../lib/format'
import { formatDateShort, formatTime } from './gymFormat'
import type { GymSessionItem } from './gymSessionItem'
import '../../components/SessionList.css'

const PAGE_SIZE = 10

function bodyPartTag(item: GymSessionItem, exercisesById: Map<string, Exercise>): string | null {
  const s = item.session
  if (!s) return null
  const parts = (s.sets.length > 0 ? sessionBodyParts(s, exercisesById) : (s.body_parts ?? [])).map(
    displayBodyPart
  )
  if (parts.length === 0) return null
  const shown = parts.slice(0, 3).join(' · ')
  return parts.length > 3 ? `${shown} +${parts.length - 3}` : shown
}

function rowTitle(item: GymSessionItem, templateNameById: Map<string, string>): string {
  const s = item.session
  if (s?.title) return s.title
  if (s?.template_ids[0]) {
    const n = templateNameById.get(s.template_ids[0])
    if (n) return n
  }
  return 'Gym session'
}

/**
 * Gym Sessions sub-tab — a gym-only session list (the activity filter is fixed
 * to gym). Each bar shows a body-part tag and a colour-coded log/logged bubble
 * so the ones that still need logging stand out; a click opens the workout view.
 */
export function GymSessionsTab({
  items,
  exercisesById,
  templateNameById,
  timezone,
  onOpenItem,
  onLogUnlinked
}: {
  items: GymSessionItem[]
  exercisesById: Map<string, Exercise>
  templateNameById: Map<string, string>
  timezone: string | null | undefined
  onOpenItem: (item: GymSessionItem) => void
  onLogUnlinked: () => void
}): ReactElement {
  const [page, setPage] = useState(0)
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.dateIso.localeCompare(a.dateIso)),
    [items]
  )
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const clampedPage = Math.min(page, pageCount - 1)
  const pageItems = sorted.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE)

  return (
    <div className="gym-subtab">
      <section className="gym-section">
        <div className="gym-section-head">
          <h2 className="gym-section-title">Gym sessions</h2>
          <ButtonSoft onClick={onLogUnlinked}>Log a session</ButtonSoft>
        </div>

        {items.length === 0 ? (
          <EmptyState message="No gym sessions yet — synced strength workouts and your own logs appear here." />
        ) : (
          <div className="session-list gym-session-list">
            <div className="session-list-header gym-session-list-grid" aria-hidden="true">
              <span className="session-list-col-label">Date</span>
              <span className="session-list-col-label">Activity</span>
              <span className="session-list-col-label session-list-col-label--num">Duration</span>
              <span className="session-list-col-label session-list-col-label--num">Muscles</span>
              <span className="session-list-col-label session-list-col-label--num">Log</span>
            </div>
            <div className="session-list-rows">
            {pageItems.map((item) => {
              const tag = bodyPartTag(item, exercisesById)
              const dur = item.workout?.duration_s ?? null
              return (
                <button
                  key={item.key}
                  type="button"
                  className="session-list-row gym-session-list-grid"
                  onClick={() => onOpenItem(item)}
                >
                  <span className="session-list-cell session-list-cell--datetime">
                    <span className="session-list-date tabular-nums">
                      {formatDateShort(item.dateIso, timezone)}
                    </span>
                    <span className="session-list-time tabular-nums">
                      {formatTime(item.dateIso, timezone)}
                    </span>
                  </span>
                  <span className="session-list-cell session-list-cell--modality gym-session-activity">
                    <ModalityIcon type="Traditional Strength Training" className="session-list-modality-icon" />
                    <ActivityBadge type="Traditional Strength Training" label={rowTitle(item, templateNameById)} />
                  </span>
                  <span className="session-list-cell session-list-cell--duration tabular-nums">
                    {dur !== null ? formatDurationHM(dur) : EM_DASH}
                  </span>
                  <span className="session-list-cell gym-session-muscles">
                    {tag ? <span className="gym-sess-tag">{tag}</span> : EM_DASH}
                  </span>
                  <span
                    className={
                      item.logged
                        ? 'gym-sess-status gym-sess-status--logged'
                        : 'gym-sess-status gym-sess-status--tolog'
                    }
                  >
                    {item.logged ? 'logged' : 'log session'}
                  </span>
                </button>
              )
            })}
            </div>
            {pageCount > 1 && (
              <div className="session-list-pagination">
                <button
                  type="button"
                  className="session-list-page-btn"
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
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
                  onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                  disabled={clampedPage >= pageCount - 1}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
