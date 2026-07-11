// THE titled stat-table card (Month summary, yearly averages, cardio twins).
// One implementation for every view; the CSS also owns the equal-height
// behavior (rows space out when a stretching column makes the card taller).
import type { ReactElement } from 'react'
import { StatTable } from './StatTable'
import type { StatTableRow } from './StatTable'
import './SummaryCard.css'

export interface SummaryCardProps {
  title: string
  rows: StatTableRow[]
}

export function SummaryCard({ title, rows }: SummaryCardProps): ReactElement {
  return (
    <div className="summary-card">
      <h3 className="summary-card-title">{title}</h3>
      <StatTable rows={rows} />
    </div>
  )
}
