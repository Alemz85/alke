import { useMemo, useState, type ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { CalendarHeatmap } from '../components/CalendarHeatmap'
import { DayDetailDrawer } from '../components/DayDetailDrawer'
import { SessionList } from '../components/SessionList'
import { modalityLabel } from '../components/modalityAccent'
import { EmptyState, HeroMetric, StatTable } from '../components'
import type { StatTableRow } from '../components'
import { useMonthWorkouts, useUserConfig, useYearWorkouts } from '../hooks/useSessionsData'
import { formatDuration, groupWorkoutsByDay, longestWeeklyStreak } from '../hooks/sessionsCompute'
import { isoWeekKey, localDateKey, todayYMD, toZonedYMD } from '../hooks/sessionsDate'
import { formatWorkoutDuration } from '../lib/calendarDayLabel'
import { monthSummary, yearSummary, type SummaryItem } from '../lib/periodSummary'
import './SessionsView.css'

const EM_DASH = '—'

function fmtTrendPct(pct: number | null): string {
  if (pct === null) return EM_DASH
  const sign = pct > 0 ? '+' : ''
  return `${sign}${Math.round(pct)}%`
}

function fmtPerMonth(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(1)
}

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

  // Combine the year window (365d trailing, covers "this year" stats) with the
  // currently-viewed month window (covers months outside that trailing year
  // when the user pages the calendar further back) — deduped by workout id so
  // an overlapping workout isn't double-counted. Feeds the month/year pill
  // summaries, the session list, and the drawer lookup for list rows outside
  // the visible calendar month.
  const summaryWorkouts = useMemo(() => {
    const byId = new Map(yearWorkouts.map((w) => [w.id, w]))
    for (const w of monthWorkouts) byId.set(w.id, w)
    return Array.from(byId.values())
  }, [yearWorkouts, monthWorkouts])

  // Drawer needs to resolve a day bucket for ANY session-list row, not just
  // days within the currently-viewed calendar month — so it looks up against
  // a bucket map built from the wider summary window.
  const summaryDaysByKey = useMemo(
    () => groupWorkoutsByDay(summaryWorkouts, timezone),
    [summaryWorkouts, timezone]
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

  // --- Month / year pill summaries (lib/periodSummary.ts) ---
  const summaryItems: SummaryItem[] = useMemo(
    () =>
      summaryWorkouts.map((w) => ({
        dateKey: localDateKey(w.start_at, timezone),
        durationS: w.duration_s ?? 0,
        type: w.type
      })),
    [summaryWorkouts, timezone]
  )

  const todayKey = localDateKey(new Date().toISOString(), timezone)
  const viewedYm = `${viewYear.toString().padStart(4, '0')}-${viewMonth.toString().padStart(2, '0')}`

  const monthSum = useMemo(
    () => monthSummary(summaryItems, viewedYm, todayKey),
    [summaryItems, viewedYm, todayKey]
  )
  const yearSum = useMemo(
    () => yearSummary(summaryItems, viewYear),
    [summaryItems, viewYear]
  )

  // Merged "Month summary" table: monthSum's workouts/time/gym/cardio/trend
  // (new values win over the pre-existing sessions/total-time rows), plus the
  // pre-existing per-modality breakdown and longest-streak rows.
  const monthStatRows: StatTableRow[] = hasAnySessionThisMonth
    ? [
        { label: 'Workouts', value: monthSum.workouts.toString() },
        { label: 'Total time', value: formatWorkoutDuration(monthSum.totalDurationS) },
        { label: 'Gym sessions', value: monthSum.gymSessions.toString() },
        { label: 'Cardio sessions', value: monthSum.cardioSessions.toString() },
        { label: 'Time trend', value: `${fmtTrendPct(monthSum.timeTrendPct)} vs last month` },
        ...Array.from(durationByModality.entries()).map(([type, durS]) => ({
          label: modalityLabel(type),
          value: formatDuration(durS)
        })),
        { label: 'Longest streak', value: `${streakWeeks} week${streakWeeks === 1 ? '' : 's'}` }
      ]
    : [
        { label: 'Time trend', value: `${fmtTrendPct(monthSum.timeTrendPct)} vs last month` },
        { label: 'Longest streak', value: `${streakWeeks} week${streakWeeks === 1 ? '' : 's'}` }
      ]

  const yearStatRows: StatTableRow[] = [
    { label: 'Workouts/mo', value: fmtPerMonth(yearSum.avgWorkoutsPerMonth) },
    { label: 'Time/mo', value: formatWorkoutDuration(yearSum.avgDurationSPerMonth) },
    { label: 'Gym/mo', value: fmtPerMonth(yearSum.avgGymPerMonth) },
    { label: 'Cardio/mo', value: fmtPerMonth(yearSum.avgCardioPerMonth) }
  ]

  const selectedBucket = selectedDayKey
    ? (daysByKey.get(selectedDayKey) ?? summaryDaysByKey.get(selectedDayKey))
    : undefined
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

  /** Session-list row click: jump the calendar to that day's month (if needed) and open its drawer. */
  function handleSelectSessionDay(dateKey: string): void {
    const [y, m] = dateKey.split('-').map(Number)
    if (y !== viewYear || m !== viewMonth) {
      setViewYear(y)
      setViewMonth(m)
    }
    setSelectedDayKey(dateKey)
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
            showDayLabel
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
            <StatTable rows={monthStatRows} />
          </div>
          <div className="sessions-summary-card">
            <h3 className="sessions-summary-title">{viewYear} · monthly average</h3>
            <StatTable rows={yearStatRows} />
          </div>
        </div>
      </div>

      <div className="sessions-list-section">
        <h3 className="sessions-summary-title">All sessions</h3>
        <SessionList
          workouts={summaryWorkouts}
          timezone={timezone}
          onSelectDay={handleSelectSessionDay}
        />
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
