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
import { Sparkline, type SparklinePoint } from './Sparkline'
import './BodyWeightPill.css'

export interface BodyWeightPillProps {
  summary: BodyWeightSummary
  /** Weigh-in history behind the headline number, oldest first. Optional: the
      pill is still correct without it, it just loses the trend shape. */
  trend?: SparklinePoint[]
}

export function BodyWeightPill({ summary, trend = [] }: BodyWeightPillProps): ReactElement {
  const {
    latestKg,
    latestDateLabel,
    stalenessLabel,
    isStale,
    deltaKg,
    deltaLabel,
    latestBodyFatPct,
    bodyFatDeltaPct,
    bodyFatDeltaLabel
  } = summary

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
  const bodyFatTone =
    bodyFatDeltaPct === null
      ? 'neutral'
      : bodyFatDeltaPct > 0
        ? 'up'
        : bodyFatDeltaPct < 0
          ? 'down'
          : 'neutral'

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
      {/* Body fat is the SECOND series of the recovery domain, so it wears
          neutral ink rather than the domain accent (DESIGN.md: "domain accent
          plus text-tertiary gray for secondary series") — weight stays the one
          accented headline. The whole row is absent when no reading has synced,
          so the tile is byte-identical to before for anyone without a scale
          that reports body fat. */}
      {latestBodyFatPct !== null && (
        <div className="bodyweight-pill-subfigure">
          <span className="bodyweight-pill-subvalue tabular-nums">
            {latestBodyFatPct.toFixed(1)}%
          </span>
          <span className="bodyweight-pill-sublabel">body fat</span>
          {bodyFatDeltaLabel && (
            <span
              className={`bodyweight-pill-delta bodyweight-pill-delta--${bodyFatTone} tabular-nums`}
            >
              {bodyFatDeltaLabel}
            </span>
          )}
        </div>
      )}
      <Sparkline points={trend} domain="recovery" ariaLabel="Body weight over recent months" />
      <span className="bodyweight-pill-meta">
        {stalenessLabel ? `Weighed ${stalenessLabel.toLowerCase()}` : latestDateLabel}
        {stalenessLabel && stalenessLabel !== 'Today' ? ` · ${latestDateLabel}` : ''}
      </span>
    </div>
  )
}
