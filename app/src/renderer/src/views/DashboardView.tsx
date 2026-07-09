import type { ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'

export function DashboardView(): ReactElement {
  return (
    <div className="view">
      <TabHeader eyebrow="Overview" title="Dashboard" />
      <EmptyState message="Dashboard coming online in this phase — your weekly overview will appear here once the data layer is wired up to live charts." />
    </div>
  )
}
