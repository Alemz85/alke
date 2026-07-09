import type { ReactElement } from 'react'
import { AlertTriangle, Info, X } from 'lucide-react'
import './FlagBanner.css'

export interface FlagBannerProps {
  message: string
  /** `info` renders neutral — red is reserved for genuine warnings, and a
   * missed weekly minimum must never get alarm styling (SPEC §5.3). */
  severity?: 'warn' | 'info'
  onDismiss?: () => void
}

export function FlagBanner({ message, severity = 'warn', onDismiss }: FlagBannerProps): ReactElement {
  const isInfo = severity === 'info'
  const Icon = isInfo ? Info : AlertTriangle
  return (
    <div className={isInfo ? 'flag-banner flag-banner--info' : 'flag-banner'}>
      <Icon size={16} strokeWidth={1.5} className="flag-banner-icon" />
      <span className="flag-banner-text">{message}</span>
      {onDismiss && (
        <button className="flag-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
          <X size={16} strokeWidth={1.5} />
        </button>
      )}
    </div>
  )
}
