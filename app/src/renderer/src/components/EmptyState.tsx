import type { ReactElement, ReactNode } from 'react'
import './EmptyState.css'

export interface EmptyStateProps {
  message: string
  action?: ReactNode
}

export function EmptyState({ message, action }: EmptyStateProps): ReactElement {
  return (
    <div className="empty-state">
      <p className="empty-state-message">{message}</p>
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
