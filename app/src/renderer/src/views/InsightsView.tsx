import type { ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'

export function InsightsView(): ReactElement {
  return (
    <div className="view">
      <TabHeader eyebrow="Analysis" title="Insights" />
      <EmptyState message="Insights switches on in a later phase — cross-metric analysis and trend narration will live here." />
    </div>
  )
}
