import { useEffect, type ReactElement } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import './Toast.css'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastProps {
  message: string
  tone?: ToastTone
  onDismiss: () => void
  /** Auto-dismiss delay in ms; 0 disables auto-dismiss. */
  duration?: number
}

const ICONS = { success: CheckCircle2, error: AlertTriangle, info: Info } as const

export function Toast({
  message,
  tone = 'info',
  onDismiss,
  duration = 4500
}: ToastProps): ReactElement {
  useEffect(() => {
    if (duration <= 0) return
    const id = setTimeout(onDismiss, duration)
    return () => clearTimeout(id)
  }, [duration, onDismiss, message])

  const Icon = ICONS[tone]
  return (
    <div
      className={`toast toast--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      <Icon size={16} strokeWidth={1.5} className="toast-icon" />
      <span className="toast-text">{message}</span>
      <button className="toast-dismiss" onClick={onDismiss} aria-label="Dismiss">
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  )
}
