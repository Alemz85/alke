import type { ReactElement } from 'react'
import { TabHeader } from './TabHeader'
import { EmptyState } from '../components'

export function ChatView(): ReactElement {
  return (
    <div className="view">
      <TabHeader eyebrow="Assistant" title="Chat" />
      <EmptyState message="Chat switches on in a later phase — ask questions about your training and recovery data here." />
    </div>
  )
}
