// Compact body-weight pill for the Dashboard (top of the tab). Weigh-ins in
// this data are SPARSE — often weeks apart — so the pill leads with the latest
// reading, a terse trend vs ~1 month ago, and a plain-language staleness note
// ("weighed N days ago"). It renders a quiet empty state when there is no
// reading at all, and dims once the latest weigh-in is over a week old.
//
// All derivation is the pure computeBodyWeightSummary() helper in
// dashboardUtils.ts (unit-tested); this component only formats + renders.
import type { ReactElement } from 'react'
import type { BodyWeightSummary } from '../views/dashboardUtils'
import './BodyWeightPill.css'

export interface BodyWeightPillProps {
  summary: BodyWeightSummary
}

export function BodyWeightPill({ summary }: BodyWeightPillProps): ReactElement {
  const { latestKg, latestDateLabel, stalenessLabel, isStale, deltaKg, deltaLabel } = summary

  // Quiet empty state — no weigh-in has ever synced.
  if (latestKg === null) {
    return (
      <div className="bodyweight-pill bodyweight-pill--empty">
        <span className="bodyweight-pill-eyebrow">Body weight</span>
        <span className="bodyweight-pill-empty-text">
          No weigh-ins yet — they&apos;ll appear once Apple Health syncs a reading.
        </span>
      </div>
    )
  }

  const deltaTone =
    deltaKg === null ? 'neutral' : deltaKg > 0 ? 'up' : deltaKg < 0 ? 'down' : 'neutral'

  return (
    <div className={`bodyweight-pill${isStale ? ' bodyweight-pill--stale' : ''}`}>
      <span className="bodyweight-pill-eyebrow">Body weight</span>
      <div className="bodyweight-pill-figure">
        <span className="bodyweight-pill-value tabular-nums">{latestKg.toFixed(1)} kg</span>
        {deltaLabel && (
          <span
            className={`bodyweight-pill-delta bodyweight-pill-delta--${deltaTone} tabular-nums`}
          >
            {deltaLabel}
          </span>
        )}
      </div>
      <span className="bodyweight-pill-meta">
        {stalenessLabel ? `Weighed ${stalenessLabel.toLowerCase()}` : latestDateLabel}
        {stalenessLabel && stalenessLabel !== 'Today' ? ` · ${latestDateLabel}` : ''}
      </span>
    </div>
  )
}
