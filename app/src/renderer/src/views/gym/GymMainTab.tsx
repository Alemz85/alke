import { type ReactElement } from 'react'
import { ArrowRight } from 'lucide-react'
import type { GymSession } from '@shared/types'
import { EmptyState } from '../../components/EmptyState'
import { ModalityIcon } from '../../components/ModalityIcon'
import { activityEnvironmentAccent } from '../../components/modalityAccent'
import type { YMD } from '../../hooks/sessionsDate'
import { summarizeSession } from '../../lib/gymLog'
import type { MuscleFatigueResult } from '../../lib/muscleFatigue'
import type { StrengthResult } from '../../lib/strengthLevel'
import { GymWeekCalendar } from './GymWeekCalendar'
import { MuscleLoadCard } from './MuscleLoadCard'
import { ProteinCard } from './ProteinCard'
import { StrengthCard } from './StrengthCard'
import { formatDateShort } from './gymFormat'
import '../../components/RecentSessionsCard.css'

/**
 * Gym Main tab — overview: stat strip + muscle load & fatigue centerpiece +
 * recent sessions. Protein + Strength cards slot into the top area later.
 */
export function GymMainTab({
  muscleFatigue,
  strengthLevels,
  recentSessions,
  templateNameById,
  today,
  timezone,
  onOpenSession,
  onOpenSessionsTab
}: {
  muscleFatigue: MuscleFatigueResult
  strengthLevels: StrengthResult
  recentSessions: GymSession[]
  templateNameById: Map<string, string>
  today: YMD
  timezone: string | null | undefined
  onOpenSession: (session: GymSession) => void
  onOpenSessionsTab: () => void
}): ReactElement {
  const recent = recentSessions.slice(0, 5)

  return (
    <div className="gym-subtab">
      <GymWeekCalendar
        sessions={recentSessions}
        today={today}
        timezone={timezone}
        templateNameById={templateNameById}
        onOpenSession={onOpenSession}
      />

      <MuscleLoadCard result={muscleFatigue} />

      <ProteinCard timezone={timezone} />

      <StrengthCard result={strengthLevels} />

      <section className="recent-card">
        <div className="recent-card-header">
          <h2 className="recent-card-title">Recent sessions</h2>
          <button type="button" className="recent-card-all" onClick={onOpenSessionsTab}>
            All sessions
            <ArrowRight size={14} strokeWidth={1.75} />
          </button>
        </div>
        {recent.length === 0 ? (
          <EmptyState message="No gym logs yet — log a session from the Sessions tab." />
        ) : (
          <ul className="recent-card-list">
            {recent.map((s) => {
              const templateName = s.template_ids[0]
                ? (templateNameById.get(s.template_ids[0]) ?? null)
                : null
              return (
                <li key={s.id}>
                  <button type="button" className="recent-card-row" onClick={() => onOpenSession(s)}>
                    <span
                      className="recent-card-row-date"
                      style={{ color: activityEnvironmentAccent('Traditional Strength Training') }}
                    >
                      <ModalityIcon type="Traditional Strength Training" size={15} className="recent-card-row-icon" />
                      <span className="tabular-nums">{formatDateShort(s.performed_at, timezone)}</span>
                    </span>
                    <span className="recent-card-row-meta gym-recent-row-meta">
                      <span className="gym-recent-row-title">{s.title || templateName || 'Gym session'}</span>
                      <span className="recent-card-row-dot">·</span>
                      <span className="tabular-nums">{summarizeSession(s, templateName)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
