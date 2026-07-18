// Compact active-energy pill for the Dashboard glance row (next to Body
// weight and Protein). Today's kcal is a PARTIAL figure — Apple Health
// accumulates it through the day — so the pill never scores today against
// anything; the meta line offers the 7-day average as quiet context instead
// of a delta that would always read low in the morning.
//
// All derivation is the pure computeActiveEnergySummary() helper in
// dashboardUtils.ts (unit-tested); this component only formats + renders.
import type { ReactElement } from 'react'
import type { ActiveEnergySummary } from '../views/dashboardUtils'
import './ActiveEnergyPill.css'

export interface ActiveEnergyPillProps {
  summary: ActiveEnergySummary
}

export function ActiveEnergyPill({ summary }: ActiveEnergyPillProps): ReactElement {
  const { todayKcal, weekAvgKcal, hasAnyData } = summary

  // Quiet empty state — active energy has never synced (it only started
  // arriving once the metric was enabled in the phone's HAE automation).
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

  return (
    <div className="activeenergy-pill">
      <span className="activeenergy-pill-eyebrow">Active energy · today</span>
      <div className="activeenergy-pill-figure">
        {todayKcal === null ? (
          <span className="activeenergy-pill-value activeenergy-pill-value--pending">—</span>
        ) : (
          <span className="activeenergy-pill-value tabular-nums">
            {Math.round(todayKcal)}
            <span className="activeenergy-pill-unit">kcal</span>
          </span>
        )}
      </div>
      <span className="activeenergy-pill-meta">
        {todayKcal === null ? 'No sync yet today' : 'So far today'}
        {weekAvgKcal !== null ? ` · 7-day avg ${Math.round(weekAvgKcal)} kcal` : ''}
      </span>
    </div>
  )
}
