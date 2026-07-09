import type { ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'

export function SessionsView(): ReactElement {
  return (
    <div className="view">
      <TabHeader eyebrow="Adherence" title="Sessions" />
      <EmptyState message="Sessions coming online in this phase — your workout calendar and streaks will appear here once the data layer is wired up." />
    </div>
  )
}
