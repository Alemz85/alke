import type { ReactElement } from 'react'
import { AlertTriangle } from 'lucide-react'
import { ButtonSoft } from '../components'
import './DbErrorState.css'

export interface DbErrorStateProps {
  message?: string
  onRetry: () => void
}

export function DbErrorState({ message, onRetry }: DbErrorStateProps): ReactElement {
  return (
    <div className="db-error-state">
      <AlertTriangle size={20} strokeWidth={1.5} className="db-error-state-icon" />
      <h2 className="db-error-state-title">Can&apos;t reach the database</h2>
      <p className="db-error-state-message">
        {message ?? 'The app could not connect to Supabase. Check your network and .env configuration.'}
      </p>
      <ButtonSoft onClick={onRetry}>Retry</ButtonSoft>
    </div>
  )
}
