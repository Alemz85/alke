import type { ReactElement } from 'react'
import { AlertTriangle, CloudOff, LoaderCircle, RotateCw } from 'lucide-react'
import type { OfflineQueueStatus as QueueStatus } from '@shared/types'
import { ButtonSoft } from './ButtonSoft'
import './OfflineQueueStatus.css'

export function OfflineQueueStatus({
  connected,
  status,
  onRetry
}: {
  connected: boolean
  status: QueueStatus
  onRetry: () => void
}): ReactElement | null {
  if (connected && status.pending === 0 && status.failed === 0 && !status.syncing) return null

  if (status.failed > 0) {
    const label = `${status.failed} ${status.failed === 1 ? 'needs' : 'need'} attention`
    return (
      <ButtonSoft
        className="offline-queue-status offline-queue-status--failed"
        onClick={onRetry}
        title={`Retry queued writes. Last error: ${status.lastError ?? 'unknown error'}`}
      >
        <AlertTriangle size={15} strokeWidth={1.75} />
        {label}
        <span className="offline-queue-retry">Retry</span>
      </ButtonSoft>
    )
  }

  if (status.syncing) {
    return (
      <ButtonSoft className="offline-queue-status" disabled title="Synchronizing locally saved changes">
        <LoaderCircle className="icon-spin" size={15} strokeWidth={1.75} />
        Syncing
      </ButtonSoft>
    )
  }

  if (status.pending > 0) {
    return (
      <ButtonSoft
        className="offline-queue-status"
        onClick={onRetry}
        title="Saved locally. These changes will sync automatically when the database is reachable."
      >
        <CloudOff size={15} strokeWidth={1.75} />
        {status.pending} pending
      </ButtonSoft>
    )
  }

  return (
    <ButtonSoft
      className="offline-queue-status"
      onClick={onRetry}
      title="The database is unreachable. Cached data remains available."
    >
      <CloudOff size={15} strokeWidth={1.75} />
      Offline
      <RotateCw className="offline-queue-retry-icon" size={13} strokeWidth={1.75} />
    </ButtonSoft>
  )
}

