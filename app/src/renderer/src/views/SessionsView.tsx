import { useMemo, type ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { CalendarHeatmap } from '../components/CalendarHeatmap'
import { DayDetailDrawer } from '../components/DayDetailDrawer'
import { SessionList } from '../components/SessionList'
import { SummaryCard } from '../components/SummaryCard'
import { EmptyState, HeroMetric } from '../components'
import type { StatTableRow } from '../components'
import { useMonthWorkouts, useUserConfig, useYearWorkouts } from '../hooks/useSessionsData'
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { useMonthCalendar } from '../hooks/useMonthCalendar'
import { isoWeekKey, localDateKey, toZonedYMD } from '../hooks/sessionsDate'
import { formatDurationHM, formatPerMonth, formatTrendPct } from '../lib/format'
import { monthSummary, yearSummary, type SummaryItem } from '../lib/periodSummary'
import './SessionsView.css'

export function SessionsView(): ReactElement {
  const userConfigQuery = useUserConfig()
  const timezone = userConfigQuery.data?.timezone

  const {
    today,
    viewYear,
    viewMonth,
    handlePrevMonth,
    handleNextMonth,
    selectedDayKey,
    openDay,
    closeDay,
    showMonthOf
  } = useMonthCalendar(timezone)

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

  const hasAnySessionThisMonth = sessionsCount > 0

  // --- Month / year pill summaries (lib/periodSummary.ts) ---
  const summaryItems: SummaryItem[] = useMemo(
    () =>
      summaryWorkouts.map((w) => {
        const startMs = Date.parse(w.start_at)
        // end_at is sometimes null (HAE didn't report it) — derive from duration_s
        // so back-to-back visit merging still works for those workouts.
        const endMs = w.end_at
          ? Date.parse(w.end_at)
          : w.duration_s !== null
            ? startMs + w.duration_s * 1000
            : undefined
        return {
          dateKey: localDateKey(w.start_at, timezone),
          durationS: w.duration_s ?? 0,
          type: w.type,
          startMs: Number.isNaN(startMs) ? undefined : startMs,
          endMs: endMs !== undefined && Number.isNaN(endMs) ? undefined : endMs
        }
      }),
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

  // "Month summary" table: exactly workouts/time/gym/cardio/trend — no
  // per-modality breakdown, no streak (dropped per user feedback).
  const monthStatRows: StatTableRow[] = hasAnySessionThisMonth
    ? [
        { label: 'Workouts', value: monthSum.workouts.toString() },
        { label: 'Total time', value: formatDurationHM(monthSum.totalDurationS) },
        { label: 'Gym sessions', value: monthSum.gymSessions.toString() },
        { label: 'Cardio sessions', value: monthSum.cardioSessions.toString() },
        { label: 'Time trend', value: `${formatTrendPct(monthSum.timeTrendPct)} vs last month` }
      ]
    : [{ label: 'Time trend', value: `${formatTrendPct(monthSum.timeTrendPct)} vs last month` }]

  const yearStatRows: StatTableRow[] = [
    { label: 'Workouts/mo', value: formatPerMonth(yearSum.avgWorkoutsPerMonth) },
    { label: 'Time/mo', value: formatDurationHM(yearSum.avgDurationSPerMonth) },
    { label: 'Gym/mo', value: formatPerMonth(yearSum.avgGymPerMonth) },
    { label: 'Cardio/mo', value: formatPerMonth(yearSum.avgCardioPerMonth) }
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

  /** Session-list row click: jump the calendar to that day's month (if needed) and open its drawer. */
  function handleSelectSessionDay(dateKey: string): void {
    showMonthOf(dateKey)
    openDay(dateKey)
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
            onSelectDay={openDay}
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
          <SummaryCard title="Month summary" rows={monthStatRows} />
          <SummaryCard title={`${viewYear} · monthly average`} rows={yearStatRows} />
        </div>
      </div>

      <div className="sessions-list-section">
        <h3 className="sessions-list-title">All sessions</h3>
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
          onClose={closeDay}
        />
      )}
    </div>
  )
}
