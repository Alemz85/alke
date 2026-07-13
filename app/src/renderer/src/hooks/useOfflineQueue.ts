import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { OfflineQueueStatus } from '@shared/types'

const EMPTY_STATUS: OfflineQueueStatus = {
  pending: 0,
  failed: 0,
  syncing: false,
  lastError: null
}

export function useOfflineQueue(): {
  status: OfflineQueueStatus
  retry: () => Promise<OfflineQueueStatus>
} {
  const [status, setStatus] = useState<OfflineQueueStatus>(EMPTY_STATUS)
  const previousTotal = useRef(0)
  const queryClient = useQueryClient()

  const receiveStatus = useCallback(
    (next: OfflineQueueStatus): void => {
      const nextTotal = next.pending + next.failed
      if (previousTotal.current > 0 && nextTotal === 0) {
        // Reconcile optimistic and persisted query data with the authoritative
        // rows once every locally durable operation has replayed.
        void queryClient.invalidateQueries()
      }
      previousTotal.current = nextTotal
      setStatus(next)
    },
    [queryClient]
  )

  useEffect(() => {
    let active = true
    const unsubscribe = window.api.onOfflineQueueStatus((next) => {
      if (active) receiveStatus(next)
    })
    void window.api.getOfflineQueueStatus().then((next) => {
      if (active) receiveStatus(next)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [receiveStatus])

  const retry = useCallback(async (): Promise<OfflineQueueStatus> => {
    const next = await window.api.retryOfflineQueue()
    receiveStatus(next)
    return next
  }, [receiveStatus])

  return { status, retry }
}
