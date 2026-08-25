// Compact active-energy pill for the Dashboard glance row (next to Body
// weight and Protein). Today's kcal is a PARTIAL figure — Apple Health
// accumulates it through the day — so the pill never scores today against
// anything; the meta line offers the 7-day average as quiet context instead
// of a delta that would always read low in the morning.
//
// The HAE automation exports complete days only, so most of the time "today"
// has no row yet: the pill then leads with the latest synced day's total,
// relabeled honestly ("· yesterday"), instead of pinning an em-dash all day.
//
// All derivation is the pure computeActiveEnergySummary() helper in
// dashboardUtils.ts (unit-tested); this component only formats + renders.
import type { ReactElement } from 'react'
import type { ActiveEnergySummary } from '../views/dashboardUtils'
import { Sparkline, type SparklinePoint } from './Sparkline'
import './ActiveEnergyPill.css'

export interface ActiveEnergyPillProps {
  summary: ActiveEnergySummary
  /** Recent daily totals behind the headline number, oldest first. Optional. */
  trend?: SparklinePoint[]
  /** Opens the metric-detail popup — the pill renders as a button when provided. */
  onClick?: () => void
}

export function ActiveEnergyPill({
  summary,
  trend = [],
  onClick
}: ActiveEnergyPillProps): ReactElement {
  const { todayKcal, weekAvgKcal, hasAnyData, latestKcal, latestDaysAgo } = summary

  // Quiet empty state — active energy has never synced (it only started
  // arriving once the metric was enabled in the phone's HAE automation).
  // Never clickable: there is no history to expand into.
  if (!hasAnyData) {
    return (
      <div className="activeenergy-pill activeenergy-pill--empty">
        <span className="activeenergy-pill-eyebrow">Active energy</span>
        <span className="activeenergy-pill-empty-text">
          No active-energy data yet — it&apos;ll appear once Apple Health syncs it.
        </span>
      </div>
    )
  }

  const displayKcal = todayKcal ?? latestKcal
  const eyebrow =
    todayKcal !== null
      ? 'Active energy · today'
      : latestDaysAgo === 1
        ? 'Active energy · yesterday'
        : 'Active energy'
  const syncNote =
    todayKcal !== null
      ? 'So far today'
      : latestKcal !== null && latestDaysAgo !== null && latestDaysAgo > 1
        ? `Last synced ${latestDaysAgo} days ago`
        : 'No sync yet today'

  const body = (
    <>
      <span className="activeenergy-pill-eyebrow">{eyebrow}</span>
      <div className="activeenergy-pill-figure">
        {displayKcal === null ? (
          <span className="activeenergy-pill-value activeenergy-pill-value--pending">—</span>
        ) : (
          <span className="activeenergy-pill-value tabular-nums">
            {Math.round(displayKcal)}
            <span className="activeenergy-pill-unit">kcal</span>
          </span>
        )}
      </div>
      <Sparkline points={trend} domain="load" ariaLabel="Active energy over the last two weeks" />
      <span className="activeenergy-pill-meta">
        {syncNote}
        {weekAvgKcal !== null ? ` · 7-day avg ${Math.round(weekAvgKcal)} kcal` : ''}
      </span>
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        className="activeenergy-pill activeenergy-pill--button"
        onClick={onClick}
        aria-haspopup="dialog"
        aria-label="Active energy — open details"
      >
        {body}
      </button>
    )
  }
  return <div className="activeenergy-pill">{body}</div>
}
