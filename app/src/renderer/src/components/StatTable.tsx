import type { ReactElement } from 'react'
import './StatTable.css'

export interface StatTableRow {
  label: string
  value: string
}

export interface StatTableProps {
  rows: StatTableRow[]
}

export function StatTable({ rows }: StatTableProps): ReactElement {
  return (
    <div className="stat-table">
      {rows.map((row) => (
        <div className="stat-table-row" key={row.label}>
          <span className="stat-table-label">{row.label}</span>
          <span className="stat-table-value tabular-nums">{row.value}</span>
        </div>
      ))}
    </div>
  )
}
