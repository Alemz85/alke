import type { ReactElement } from 'react'
import type { Domain } from './domain'
import './HeroMetric.css'

export interface HeroMetricProps {
  /** Eyebrow label, e.g. "ZONE 2 · THIS WEEK". Rendered uppercase in the domain accent. */
  eyebrow: string
  /** The one big number for this tab. Pass pre-formatted (e.g. "142"). */
  value: string
  /** Unit shown next to the value, e.g. "min". */
  unit?: string
  /** Delta/comparison caption, e.g. "+12% vs last week". */
  delta?: string
  /** Whether the delta is "positive for the user" — uses domain accent instead of neutral gray. Never red. */
  deltaPositive?: boolean
  domain: Domain
}

export function HeroMetric({
  eyebrow,
  value,
  unit,
  delta,
  deltaPositive = false,
  domain
}: HeroMetricProps): ReactElement {
  return (
    <div className="hero-metric">
      <div className={`hero-metric-eyebrow hero-metric-eyebrow--${domain}`}>{eyebrow}</div>
      <div className="hero-metric-row">
        <span className="hero-metric-value tabular-nums">{value}</span>
        {unit && <span className="hero-metric-unit">{unit}</span>}
      </div>
      {delta && (
        <div
          className={
            deltaPositive
              ? `hero-metric-delta hero-metric-delta--${domain}`
              : 'hero-metric-delta hero-metric-delta--neutral'
          }
        >
          {delta}
        </div>
      )}
    </div>
  )
}
