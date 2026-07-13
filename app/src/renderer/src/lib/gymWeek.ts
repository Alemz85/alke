import type { GymSession } from '@shared/types'
import { addDays, localDateKey, type YMD, ymdKey } from '../hooks/sessionsDate'

export interface GymWeekDay {
  date: YMD
  dateKey: string
  sessions: GymSession[]
}

/** Seven consecutive local dates, bucketed from Gym logs only. */
export function gymWeekDays(
  sessions: GymSession[],
  weekStart: YMD,
  timezone: string | null | undefined
): GymWeekDay[] {
  const sessionsByDate = new Map<string, GymSession[]>()
  for (const session of sessions) {
    const key = localDateKey(session.performed_at, timezone)
    const existing = sessionsByDate.get(key) ?? []
    existing.push(session)
    sessionsByDate.set(key, existing)
  }

  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index)
    const dateKey = ymdKey(date)
    return {
      date,
      dateKey,
      sessions: [...(sessionsByDate.get(dateKey) ?? [])].sort((a, b) =>
        a.performed_at.localeCompare(b.performed_at)
      )
    }
  })
}
