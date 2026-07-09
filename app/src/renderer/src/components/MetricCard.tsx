import type { ReactElement, ReactNode } from 'react'
import type { Domain } from './domain'
import './MetricCard.css'

export interface MetricCardProps {
  eyebrow: string
  value: string
  caption?: string
  domain?: Domain
  /** Optional sparkline or other small visual, rendered between value and caption. */
  sparkline?: ReactNode
}

export function MetricCard({
  eyebrow,
  value,
  caption,
  domain,
  sparkline
}: MetricCardProps): ReactElement {
  return (
    <div className="metric-card">
      <div className="metric-card-eyebrow">{eyebrow}</div>
      <div
        className={
          domain ? `metric-card-value metric-card-value--${domain} tabular-nums` : 'metric-card-value tabular-nums'
        }
      >
        {value}
      </div>
      {sparkline && <div className="metric-card-sparkline">{sparkline}</div>}
      {caption && <div className="metric-card-caption">{caption}</div>}
    </div>
  )
}
