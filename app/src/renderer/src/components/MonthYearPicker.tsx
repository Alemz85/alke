import { useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { MONTH_NAMES } from '../hooks/sessionsDate'
import './MonthYearPicker.css'

export interface MonthYearPickerProps {
  /** Currently-viewed year the calendar is showing (the picker opens on it). */
  year: number
  /** Currently-viewed month (1-12), highlighted when its year is browsed. */
  month: number
  /** Called with the chosen year + month (1-12). */
  onSelect: (year: number, month: number) => void
}

const MONTH_ABBR = MONTH_NAMES.map((name) => name.slice(0, 3))

/**
 * Compact year-stepper + 12-month grid, shown as a popover under the calendar
 * title so a user can jump straight to any month instead of paging one at a
 * time (needed once history spans years — e.g. imported RunKeeper runs).
 */
export function MonthYearPicker({ year, month, onSelect }: MonthYearPickerProps): ReactElement {
  const [browseYear, setBrowseYear] = useState(year)

  return (
    <div className="month-year-picker" role="dialog" aria-label="Jump to month">
      <div className="month-year-picker-yearrow">
        <button
          type="button"
          className="month-year-picker-yearbtn"
          onClick={() => setBrowseYear((y) => y - 1)}
          aria-label="Previous year"
        >
          <ChevronLeft size={16} strokeWidth={1.5} />
        </button>
        <span className="month-year-picker-year tabular-nums">{browseYear}</span>
        <button
          type="button"
          className="month-year-picker-yearbtn"
          onClick={() => setBrowseYear((y) => y + 1)}
          aria-label="Next year"
        >
          <ChevronRight size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="month-year-picker-months">
        {MONTH_ABBR.map((label, i) => {
          const m = i + 1
          const isCurrent = browseYear === year && m === month
          return (
            <button
              key={label}
              type="button"
              className={isCurrent ? 'month-year-picker-month is-current' : 'month-year-picker-month'}
              onClick={() => onSelect(browseYear, m)}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
