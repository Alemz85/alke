import type { ReactElement } from 'react'
import { Dropdown, type DropdownOption } from './Dropdown'
import { ModalityIcon } from './ModalityIcon'
import { activityEnvironmentAccent } from './modalityAccent'
import './SessionFilters.css'

export interface SessionTypeOption {
  value: string
  label: string
}

export interface SessionFiltersProps {
  /** Years present in the data, descending. Offered after an "All time" option. */
  years: number[]
  /** Distinct activity types present, with display labels. */
  types: SessionTypeOption[]
  /** 'all' or a year as a string. */
  period: string
  /** 'all' or a workout type. */
  activityType: string
  onPeriodChange: (value: string) => void
  onActivityTypeChange: (value: string) => void
}

/**
 * Two compact dropdowns that filter the all-sessions list — by time (all-time
 * or a specific year) and by activity type. Both default to "all", so the list
 * shows every session until narrowed. Sits on the list header row.
 */
export function SessionFilters({
  years,
  types,
  period,
  activityType,
  onPeriodChange,
  onActivityTypeChange
}: SessionFiltersProps): ReactElement {
  const periodOptions: DropdownOption[] = [
    { value: 'all', label: 'All time' },
    ...years.map((y) => ({ value: String(y), label: String(y) }))
  ]

  const activityOptions: DropdownOption[] = [
    { value: 'all', label: 'All activities' },
    ...types.map((t) => ({
      value: t.value,
      label: t.label,
      icon: <ModalityIcon type={t.value} size={14} />,
      accent: activityEnvironmentAccent(t.value)
    }))
  ]

  return (
    <div className="session-filters">
      <Dropdown
        ariaLabel="Filter by time"
        value={period}
        options={periodOptions}
        onChange={onPeriodChange}
      />
      <Dropdown
        ariaLabel="Filter by activity type"
        value={activityType}
        options={activityOptions}
        onChange={onActivityTypeChange}
      />
    </div>
  )
}
