import { useMemo, useState, type ReactElement } from 'react'
import { ArrowLeft } from 'lucide-react'
import { TabHeader } from './TabHeader'
import { DayDetailDrawer } from '../components/DayDetailDrawer'
import { SessionList } from '../components/SessionList'
import { SessionFilters, type SessionTypeOption } from '../components/SessionFilters'
import { activityGroupLabel } from '../components/modalityAccent'
import { useAllWorkouts, useUserConfig } from '../hooks/useSessionsData'
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { useMonthCalendar } from '../hooks/useMonthCalendar'
import { toZonedYMD } from '../hooks/sessionsDate'
import './SessionsView.css'

export interface SessionsViewProps {
  /** Navigate back to the Dashboard (which now hosts the calendar + summaries). */
  onBack: () => void
  /**
   * Activity group to pre-select in the filter when arriving here (e.g. a cardio
   * "recent sessions" card jumped in filtered to "Swim"). An `activityGroupLabel`
   * value — 'all' or undefined shows everything. Read once on mount; the view
   * remounts on every navigation into it, so no live sync is needed.
   */
  initialActivity?: string
}

export function SessionsView({ onBack, initialActivity }: SessionsViewProps): ReactElement {
  const userConfigQuery = useUserConfig()
  const timezone = userConfigQuery.data?.timezone

  // The calendar itself now lives on the Dashboard; this view keeps only the
  // selection/paging hook so a session-list row can open its day in the drawer
  // and jump the (Dashboard) month into view on return.
  const { selectedDayKey, openDay, closeDay, showMonthOf } = useMonthCalendar(timezone)

  // One all-time pull (the DB holds only a few hundred workouts) drives the
  // filterable session list — no trailing-window that would hide older history
  // (e.g. imported runs).
  const allWorkoutsQuery = useAllWorkouts()
  const allWorkouts = useMemo(() => allWorkoutsQuery.data ?? [], [allWorkoutsQuery.data])

  // Buckets over ALL history: resolves the drawer for any session-list row no
  // matter how far back it is.
  const daysByKey = useMemo(
    () => groupWorkoutsByDay(allWorkouts, timezone),
    [allWorkouts, timezone]
  )

  // --- All-sessions list: filters over the full history ---
  const [period, setPeriod] = useState('all') // 'all' | year-as-string
  // Activity filter keyed by GROUP label (activityGroupLabel), so all strength
  // variants collapse to one "Gym" option and a cardio card can deep-link here
  // by passing its modality label. 'all' | group label.
  const [activityType, setActivityType] = useState(initialActivity ?? 'all')

  const years = useMemo(() => {
    const set = new Set<number>()
    for (const w of allWorkouts) set.add(toZonedYMD(w.start_at, timezone).year)
    return Array.from(set).sort((a, b) => b - a)
  }, [allWorkouts, timezone])

  const typeOptions: SessionTypeOption[] = useMemo(() => {
    // One option per activity GROUP; the first raw type seen for a group carries
    // the option's icon/accent (SessionFilters keys those off `value`).
    const byGroup = new Map<string, { value: string; count: number }>()
    for (const w of allWorkouts) {
      const group = activityGroupLabel(w.type)
      const cur = byGroup.get(group)
      if (cur) cur.count += 1
      else byGroup.set(group, { value: group, count: 1 })
    }
    return Array.from(byGroup.entries())
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([label, { value }]) => ({ value, label }))
  }, [allWorkouts])

  const filteredWorkouts = useMemo(() => {
    return allWorkouts.filter((w) => {
      if (period !== 'all' && toZonedYMD(w.start_at, timezone).year !== Number(period)) return false
      if (activityType !== 'all' && activityGroupLabel(w.type) !== activityType) return false
      return true
    })
  }, [allWorkouts, period, activityType, timezone])

  const selectedBucket = selectedDayKey ? daysByKey.get(selectedDayKey) : undefined
  const selectedDateLabel = selectedDayKey
    ? new Date(`${selectedDayKey}T12:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
      })
    : ''

  /** Session-list row click: open that day's drawer, and point the Dashboard
   *  calendar at its month so returning lands on the right view. */
  function handleSelectSessionDay(dateKey: string): void {
    showMonthOf(dateKey)
    openDay(dateKey)
  }

  return (
    <div className="view">
      <button type="button" className="sessions-back" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.75} />
        Dashboard
      </button>

      <TabHeader eyebrow="Sessions · Adherence" title="Sessions" />

      <div className="sessions-list-section">
        <div className="sessions-list-header">
          <h3 className="sessions-list-title">All sessions</h3>
          <SessionFilters
            years={years}
            types={typeOptions}
            period={period}
            activityType={activityType}
            onPeriodChange={setPeriod}
            onActivityTypeChange={setActivityType}
          />
        </div>
        <SessionList
          workouts={filteredWorkouts}
          timezone={timezone}
          emptyMessage="No sessions match these filters."
          onSelectDay={handleSelectSessionDay}
        />
      </div>

      {selectedDayKey && selectedBucket && (
        <DayDetailDrawer
          dateLabel={selectedDateLabel}
          workouts={selectedBucket.workouts}
          timezone={timezone}
          onClose={closeDay}
        />
      )}
    </div>
  )
}
