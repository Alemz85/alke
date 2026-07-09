import type { ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'

export function RecoveryView(): ReactElement {
  return (
    <div className="view">
      <TabHeader eyebrow="Sleep & readiness" title="Recovery" />
      <EmptyState message="Recovery coming online in this phase — sleep, RHR, and HRV trends will appear here once the data layer is wired up." />
    </div>
  )
}
