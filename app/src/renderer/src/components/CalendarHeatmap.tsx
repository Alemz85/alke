import type { ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DayBucket } from '../hooks/sessionsCompute'
import { durationStepIndex } from '../hooks/sessionsCompute'
import { calendarDayLabel } from '../lib/calendarDayLabel'
import { buildMonthGrid, MONTH_NAMES, WEEKDAY_LABELS, type YMD } from '../hooks/sessionsDate'
import { modalityToDomain } from './modalityAccent'
import './CalendarHeatmap.css'

/** A forward-looking coaching annotation for a single day cell (Zone 2 tab). */
export interface CalendarDayMarker {
  kind: 'build' | 'maintain' | 'decay'
  /** Accessible title / tooltip for the annotated cell. */
  label: string
}

export interface CalendarHeatmapProps {
  year: number
  month: number // 1-12
  today: YMD
  daysByKey: Map<string, DayBucket>
  onSelectDay: (dateKey: string) => void
  onPrevMonth: () => void
  onNextMonth: () => void
  /**
   * Optional forward-looking guidance markers keyed by "YYYY-MM-DD". When
   * provided, matching day cells get a small ring/dot + accessible title. Default
   * undefined — the Sessions view passes nothing and is unaffected.
   */
  markers?: Record<string, CalendarDayMarker>
  /**
   * When true, each workout day shows a compact bottom-corner label — the
   * longest activity's name (strength/core collapse to "Gym") + total duration
   * ("Swim · 44m", "Gym · 1h 45m"). Opt-in — the Zone 2 calendar leaves it off.
   */
  showDayLabel?: boolean
}

export function CalendarHeatmap({
  year,
  month,
  today,
  daysByKey,
  onSelectDay,
  onPrevMonth,
  onNextMonth,
  markers,
  showDayLabel = false
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
          const marker = markers?.[cell.key]
          const dayLabel = showDayLabel && hasWorkouts ? calendarDayLabel(bucket) : null
          const sessionLabel = hasWorkouts
            ? `${cell.ymd.day}: ${dayLabel ? `${dayLabel.name} ${dayLabel.duration}` : `${bucket!.workouts.length} session${bucket!.workouts.length > 1 ? 's' : ''}`}`
            : `${cell.ymd.day}: no sessions`
          const cellLabel = marker ? `${sessionLabel}. ${marker.label}` : sessionLabel

          return (
            <button
              type="button"
              key={cell.key}
              className={
                'calendar-heatmap-cell' +
                (hasWorkouts ? ` calendar-heatmap-cell--step-${stepIndex}` : '') +
                (isToday ? ' calendar-heatmap-cell--today' : '') +
                (marker ? ` calendar-heatmap-cell--marker-${marker.kind}` : '')
              }
              disabled={!hasWorkouts}
              onClick={() => hasWorkouts && onSelectDay(cell.key)}
              aria-label={cellLabel}
              title={marker ? marker.label : undefined}
            >
              {marker && <span className="calendar-heatmap-marker" aria-hidden="true" />}
              <span className="calendar-heatmap-daynum">{cell.ymd.day}</span>
              {hasWorkouts && (bucket!.modalities.length > 0 || dayLabel) && (
                <div className="calendar-heatmap-cell-foot">
                  {bucket!.modalities.length > 0 && (
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
                  {dayLabel && (
                    <span className="calendar-heatmap-daylabel">
                      <span className="calendar-heatmap-daylabel-name">{dayLabel.name}</span>
                      <span className="calendar-heatmap-daylabel-time">{dayLabel.duration}</span>
                    </span>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
