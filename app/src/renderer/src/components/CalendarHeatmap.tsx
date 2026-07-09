import type { ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DayBucket } from '../hooks/sessionsCompute'
import { durationStepIndex } from '../hooks/sessionsCompute'
import { buildMonthGrid, MONTH_NAMES, WEEKDAY_LABELS, type YMD } from '../hooks/sessionsDate'
import { modalityToDomain } from './modalityAccent'
import './CalendarHeatmap.css'

export interface CalendarHeatmapProps {
  year: number
  month: number // 1-12
  today: YMD
  daysByKey: Map<string, DayBucket>
  onSelectDay: (dateKey: string) => void
  onPrevMonth: () => void
  onNextMonth: () => void
}

export function CalendarHeatmap({
  year,
  month,
  today,
  daysByKey,
  onSelectDay,
  onPrevMonth,
  onNextMonth
}: CalendarHeatmapProps): ReactElement {
  const cells = buildMonthGrid(year, month)
  const todayKey = `${today.year.toString().padStart(4, '0')}-${today.month.toString().padStart(2, '0')}-${today.day.toString().padStart(2, '0')}`

  return (
    <div className="calendar-heatmap">
      <div className="calendar-heatmap-header">
        <h3 className="calendar-heatmap-title">
          {MONTH_NAMES[month - 1]} {year}
        </h3>
        <div className="calendar-heatmap-nav">
          <button
            type="button"
            className="calendar-heatmap-nav-btn"
            onClick={onPrevMonth}
            aria-label="Previous month"
          >
            <ChevronLeft size={16} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="calendar-heatmap-nav-btn"
            onClick={onNextMonth}
            aria-label="Next month"
          >
            <ChevronRight size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="calendar-heatmap-weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <div className="calendar-heatmap-weekday" key={label}>
            {label}
          </div>
        ))}
      </div>

      <div className="calendar-heatmap-grid">
        {cells.map((cell) => {
          if (!cell.inMonth) {
            return <div className="calendar-heatmap-cell calendar-heatmap-cell--blank" key={cell.key} />
          }
          const bucket = daysByKey.get(cell.key)
          const isToday = cell.key === todayKey
          const hasWorkouts = !!bucket && bucket.workouts.length > 0
          const stepIndex = hasWorkouts ? durationStepIndex(bucket.totalDurationS) : -1

          return (
            <button
              type="button"
              key={cell.key}
              className={
                'calendar-heatmap-cell' +
                (hasWorkouts ? ` calendar-heatmap-cell--step-${stepIndex}` : '') +
                (isToday ? ' calendar-heatmap-cell--today' : '')
              }
              disabled={!hasWorkouts}
              onClick={() => hasWorkouts && onSelectDay(cell.key)}
              aria-label={
                hasWorkouts
                  ? `${cell.ymd.day}: ${bucket!.workouts.length} session${bucket!.workouts.length > 1 ? 's' : ''}`
                  : `${cell.ymd.day}: no sessions`
              }
            >
              <span className="calendar-heatmap-daynum">{cell.ymd.day}</span>
              {hasWorkouts && bucket!.modalities.length > 0 && (
                <span className="calendar-heatmap-dots">
                  {bucket!.modalities.map((modality) => {
                    const domain = modalityToDomain(modality)
                    return (
                      <span
                        key={modality}
                        className={`calendar-heatmap-dot calendar-heatmap-dot--${domain}`}
                      />
                    )
                  })}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
