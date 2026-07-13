import type { ReactElement } from 'react'
import { activityEnvironment } from './modalityAccent'
import './ActivityBadge.css'

export interface ActivityBadgeProps {
  /** Workout type; classified into an environment for the badge colour. */
  type: string
  /** Display label (e.g. modalityLabel(type)). */
  label: string
}

/**
 * A pill badge for an activity name, coloured by its ENVIRONMENT — water=blue,
 * indoor=orange, outdoor=green. Same shape as BadgeDomain, but keyed on setting
 * rather than training domain.
 */
export function ActivityBadge({ type, label }: ActivityBadgeProps): ReactElement {
  return <span className={`activity-badge activity-badge--${activityEnvironment(type)}`}>{label}</span>
}
