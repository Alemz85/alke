import type { ReactElement } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import './FlagBanner.css'

export interface FlagBannerProps {
  message: string
  onDismiss?: () => void
}

export function FlagBanner({ message, onDismiss }: FlagBannerProps): ReactElement {
  return (
    <div className="flag-banner">
      <AlertTriangle size={16} strokeWidth={1.5} className="flag-banner-icon" />
      <span className="flag-banner-text">{message}</span>
      {onDismiss && (
        <button className="flag-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
          <X size={16} strokeWidth={1.5} />
        </button>
      )}
    </div>
  )
}
