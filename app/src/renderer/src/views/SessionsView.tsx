import { useMemo, useState, type ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { CalendarHeatmap } from '../components/CalendarHeatmap'
import { DayDetailDrawer } from '../components/DayDetailDrawer'
import { modalityLabel } from '../components/modalityAccent'
import { EmptyState, HeroMetric, StatTable } from '../components'
import type { StatTableRow } from '../components'
import { useMonthWorkouts, useUserConfig, useYearWorkouts } from '../hooks/useSessionsData'
import { formatDuration, groupWorkoutsByDay, longestWeeklyStreak } from '../hooks/sessionsCompute'
import { isoWeekKey, todayYMD, toZonedYMD } from '../hooks/sessionsDate'
import './SessionsView.css'

export function SessionsView(): ReactElement {
  const userConfigQuery = useUserConfig()
  const timezone = userConfigQuery.data?.timezone

  const today = todayYMD(timezone)
  const [viewYear, setViewYear] = useState(today.year)
  const [viewMonth, setViewMonth] = useState(today.month) // 1-12
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null)

  const monthWorkoutsQuery = useMonthWorkouts(viewYear, viewMonth)
  const yearWorkoutsQuery = useYearWorkouts(timezone)

  const monthWorkouts = monthWorkoutsQuery.data ?? []
  const yearWorkouts = yearWorkoutsQuery.data ?? []

  const daysByKey = useMemo(
    () => groupWorkoutsByDay(monthWorkouts, timezone),
    [monthWorkouts, timezone]
  )

  // --- Hero: sessions this ISO week ---
  const thisWeekKey = isoWeekKey(today)
  const sessionsThisWeek = useMemo(() => {
    return yearWorkouts.filter((w) => isoWeekKey(toZonedYMD(w.start_at, timezone)) === thisWeekKey)
      .length
  }, [yearWorkouts, timezone, thisWeekKey])

  // --- Month summary stat table ---
  const monthCellsInMonth = Array.from(daysByKey.values()).filter((bucket) => {
    const [y, m] = bucket.dateKey.split('-').map(Number)
    return y === viewYear && m === viewMonth
  })
  const sessionsCount = monthCellsInMonth.reduce((sum, b) => sum + b.workouts.length, 0)
  const totalDurationS = monthCellsInMonth.reduce((sum, b) => sum + b.totalDurationS, 0)

  const durationByModality = new Map<string, number>()
  for (const bucket of monthCellsInMonth) {
    for (const w of bucket.workouts) {
      const type = w.type?.toLowerCase() ?? 'other'
      durationByModality.set(type, (durationByModality.get(type) ?? 0) + (w.duration_s ?? 0))
    }
  }

  const weeklyMin = userConfigQuery.data?.weekly_min_sessions ?? null
  const streakWeeks = useMemo(
    () => longestWeeklyStreak(yearWorkouts, weeklyMin, timezone),
    [yearWorkouts, weeklyMin, timezone]
  )

  const hasAnySessionThisMonth = sessionsCount > 0
  const statRows: StatTableRow[] = hasAnySessionThisMonth
    ? [
        { label: 'Sessions', value: sessionsCount.toString() },
        { label: 'Total time', value: formatDuration(totalDurationS) },
        ...Array.from(durationByModality.entries()).map(([type, durS]) => ({
          label: modalityLabel(type),
          value: formatDuration(durS)
        })),
        { label: 'Longest streak', value: `${streakWeeks} week${streakWeeks === 1 ? '' : 's'}` }
      ]
    : [{ label: 'Longest streak', value: `${streakWeeks} week${streakWeeks === 1 ? '' : 's'}` }]

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

  function handlePrevMonth(): void {
    if (viewMonth === 1) {
      setViewMonth(12)
      setViewYear((y) => y - 1)
    } else {
      setViewMonth((m) => m - 1)
    }
  }

  function handleNextMonth(): void {
    if (viewMonth === 12) {
      setViewMonth(1)
      setViewYear((y) => y + 1)
    } else {
      setViewMonth((m) => m + 1)
    }
  }

  return (
    <div className="view">
      <TabHeader eyebrow="Sessions · Adherence" title="Sessions" />

      <HeroMetric
        eyebrow="Sessions · This week"
        value={sessionsThisWeek.toString()}
        unit={sessionsThisWeek === 1 ? 'session' : 'sessions'}
        domain="sessions"
      />

      <div className="sessions-grid">
        <div className="sessions-grid-calendar">
          <CalendarHeatmap
            year={viewYear}
            month={viewMonth}
            today={today}
            daysByKey={daysByKey}
            onSelectDay={setSelectedDayKey}
            onPrevMonth={handlePrevMonth}
            onNextMonth={handleNextMonth}
          />
          {!hasAnySessionThisMonth && (
            <div className="sessions-empty-note">
              <EmptyState message="No sessions in this month yet — workouts appear here after the sync." />
            </div>
          )}
        </div>

        <div className="sessions-grid-summary">
          <div className="sessions-summary-card">
            <h3 className="sessions-summary-title">Month summary</h3>
            <StatTable rows={statRows} />
          </div>
        </div>
      </div>

      {selectedDayKey && selectedBucket && (
        <DayDetailDrawer
          dateLabel={selectedDateLabel}
          workouts={selectedBucket.workouts}
          timezone={timezone}
          onClose={() => setSelectedDayKey(null)}
        />
      )}
    </div>
  )
}
