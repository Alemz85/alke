import type { ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'

export function Zone2View(): ReactElement {
  return (
    <div className="view">
      <TabHeader eyebrow="Aerobic base" title="Zone 2" />
      <EmptyState message="Zone 2 tracking switches on in a later phase — time-in-zone charts and efficiency trends will live here." />
    </div>
  )
}
