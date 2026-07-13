// THE month-calendar state hook: paging, "today", and day-drawer selection —
// the wiring Sessions and Cardio used to duplicate. Views bring their own
// workout buckets; this owns only navigation + selection state.
import { useMemo, useState } from 'react'
import { todayYMD, ymdKey } from './sessionsDate'
import type { YMD } from './sessionsDate'

export interface MonthCalendarState {
  today: YMD
  todayKey: string
  viewYear: number
  viewMonth: number
  handlePrevMonth: () => void
  handleNextMonth: () => void
  /** 'YYYY-MM-DD' of the drawer's open day, or null when closed. */
  selectedDayKey: string | null
  openDay: (dateKey: string) => void
  closeDay: () => void
  /** Points the calendar at the month containing dateKey (list → calendar jumps). */
  showMonthOf: (dateKey: string) => void
  /** Jumps the calendar straight to an arbitrary year + month (1-12). */
  jumpToMonth: (year: number, month: number) => void
}

export function useMonthCalendar(timezone: string | null | undefined): MonthCalendarState {
  const today = useMemo(() => todayYMD(timezone ?? null), [timezone])
  const [viewYear, setViewYear] = useState(today.year)
  const [viewMonth, setViewMonth] = useState(today.month)
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null)

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

  function showMonthOf(dateKey: string): void {
    const [y, m] = dateKey.split('-').map(Number)
    if (Number.isFinite(y) && Number.isFinite(m)) {
      setViewYear(y)
      setViewMonth(m)
    }
  }

  function jumpToMonth(year: number, month: number): void {
    if (Number.isFinite(year) && month >= 1 && month <= 12) {
      setViewYear(year)
      setViewMonth(month)
    }
  }

  return {
    today,
    todayKey: ymdKey(today),
    viewYear,
    viewMonth,
    handlePrevMonth,
    handleNextMonth,
    selectedDayKey,
    openDay: setSelectedDayKey,
    closeDay: () => setSelectedDayKey(null),
    showMonthOf,
    jumpToMonth
  }
}
