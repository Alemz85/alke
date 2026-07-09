import type { ReactElement, ReactNode } from 'react'
import './ChartCard.css'

export interface ChartCardProps {
  title: string
  /** Optional right-aligned header content, e.g. a ChipFilter range switcher. */
  headerRight?: ReactNode
  children: ReactNode
  /** Grid span hint applied by the caller's layout (12-col grid: 6 | 8 | 12). Purely informational className hook. */
  span?: 6 | 8 | 12
}

export function ChartCard({ title, headerRight, children, span }: ChartCardProps): ReactElement {
  return (
    <div className={span ? `chart-card chart-card--span-${span}` : 'chart-card'}>
      <div className="chart-card-header">
        <h3 className="chart-card-title">{title}</h3>
        {headerRight && <div className="chart-card-header-right">{headerRight}</div>}
      </div>
      <div className="chart-card-plot">{children}</div>
    </div>
  )
}
