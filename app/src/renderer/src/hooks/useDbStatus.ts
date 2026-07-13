import { useQuery } from '@tanstack/react-query'
import type { DbStatus } from '@shared/types'

export function useDbStatus() {
  return useQuery<DbStatus>({
    queryKey: ['dbStatus'],
    queryFn: () => window.api.getDbStatus(),
    refetchInterval: 30_000,
    networkMode: 'always'
  })
}
