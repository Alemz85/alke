import { useMemo, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { GymSession } from '@shared/types'
import { MONTH_NAMES, WEEKDAY_LABELS, addDays, isoWeekStart, type YMD, ymdKey } from '../../hooks/sessionsDate'
import { gymWeekDays } from '../../lib/gymWeek'
import './GymWeekCalendar.css'

function weekRangeLabel(start: YMD): string {
  const end = addDays(start, 6)
  const startMonth = MONTH_NAMES[start.month - 1].slice(0, 3)
  const endMonth = MONTH_NAMES[end.month - 1].slice(0, 3)
  return start.month === end.month
    ? `${startMonth} ${start.day}–${end.day}`
    : `${startMonth} ${start.day} – ${endMonth} ${end.day}`
}

function sessionName(session: GymSession, templateNameById: Map<string, string>): string {
  return session.title || (session.template_ids[0] ? templateNameById.get(session.template_ids[0]) : null) || 'Gym session'
}

/** A navigable, Gym-log-only weekly calendar for the Gym Main tab. */
export function GymWeekCalendar({
  sessions,
  today,
  timezone,
  templateNameById,
  onOpenSession
}: {
  sessions: GymSession[]
  today: YMD
  timezone: string | null | undefined
  templateNameById: Map<string, string>
  onOpenSession: (session: GymSession) => void
}): ReactElement {
  const [weekOffset, setWeekOffset] = useState(0)
  const currentWeekStart = useMemo(() => isoWeekStart(today), [today])
  const weekStart = useMemo(() => addDays(currentWeekStart, weekOffset * 7), [currentWeekStart, weekOffset])
  const days = useMemo(() => gymWeekDays(sessions, weekStart, timezone), [sessions, weekStart, timezone])
  const sessionCount = days.reduce((total, day) => total + day.sessions.length, 0)
  const todayKey = ymdKey(today)

  return (
    <section className="gym-week-calendar" aria-label="Gym sessions by week">
      <div className="gym-week-calendar-head">
        <div>
          <h2 className="gym-week-calendar-title">{weekRangeLabel(weekStart)}</h2>
          <p className="gym-week-calendar-caption">
            {sessionCount === 0 ? 'No Gym sessions' : `${sessionCount} Gym ${sessionCount === 1 ? 'session' : 'sessions'}`}
          </p>
        </div>
        <div className="gym-week-calendar-nav">
          <button
            type="button"
            className="gym-week-calendar-nav-btn"
            onClick={() => setWeekOffset((offset) => offset - 1)}
            aria-label="Previous week"
          >
            <ChevronLeft size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="gym-week-calendar-nav-btn"
            onClick={() => setWeekOffset((offset) => Math.min(0, offset + 1))}
            aria-label="Next week"
            disabled={weekOffset === 0}
          >
            <ChevronRight size={16} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="gym-week-calendar-scroll">
        <div className="gym-week-calendar-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((label) => (
            <span key={label} className="gym-week-calendar-weekday">{label}</span>
          ))}
        </div>
        <div className="gym-week-calendar-grid">
          {days.map((day) => {
            const isToday = day.dateKey === todayKey
            const workingSets = day.sessions.reduce(
              (total, session) => total + session.sets.filter((set) => !set.is_warmup).length,
              0
            )
            const step = workingSets === 0 ? -1 : workingSets < 8 ? 0 : workingSets < 16 ? 1 : workingSets < 24 ? 2 : 3
            return (
              <button
                type="button"
                key={day.dateKey}
                className={
                  'gym-week-calendar-day' +
                  (step >= 0 ? ` gym-week-calendar-day--step-${step}` : '') +
                  (isToday ? ' gym-week-calendar-day--today' : '')
                }
                disabled={day.sessions.length === 0}
                onClick={() => day.sessions[0] && onOpenSession(day.sessions[0])}
                aria-label={
                  day.sessions.length > 0
                    ? `Open ${day.sessions.length === 1 ? sessionName(day.sessions[0], templateNameById) : `${day.sessions.length} Gym sessions`} on ${day.dateKey}`
                    : `No Gym session on ${day.dateKey}`
                }
              >
                <div className="gym-week-calendar-day-head">
                  <span className="gym-week-calendar-date tabular-nums">{day.date.day}</span>
                </div>
                {day.sessions.length === 0 ? (
                  <span className="gym-week-calendar-rest">Rest</span>
                ) : (
                  <div className="gym-week-calendar-sessions">
                    <span className="gym-week-calendar-session-name">
                      {sessionName(day.sessions[0], templateNameById)}
                    </span>
                    <span className="gym-week-calendar-session-meta tabular-nums">
                      {workingSets} {workingSets === 1 ? 'set' : 'sets'}
                      {day.sessions.length > 1 ? ` · ${day.sessions.length} sessions` : ''}
                    </span>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
