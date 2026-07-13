// Data hooks for the manual protein tracker (Gym > Main > ProteinCard),
// following useGymData.ts conventions: view-neutral 'health'-prefixed query
// keys, sensible staleTime, mutations invalidate the ['health', 'protein']
// family so the day total + weekly table both refresh after a write.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProteinDay } from '@shared/types'
import { applyProteinOptimistic } from '../lib/offlineOptimistic'
import { isQueuedWriteReceipt } from '../lib/optimisticEntities'

type ProteinMutationContext = {
  previous: Array<[readonly unknown[], ProteinDay[] | undefined]>
}

function dateFallsWithinProteinQuery(queryKey: readonly unknown[], date: string): boolean {
  const from = typeof queryKey[2] === 'string' ? queryKey[2] : null
  const to = typeof queryKey[3] === 'string' ? queryKey[3] : null
  return from != null && to != null && date >= from && date <= to
}

async function optimisticallyUpdateProtein(
  queryClient: ReturnType<typeof useQueryClient>,
  date: string,
  grams: number,
  mode: 'add' | 'set'
): Promise<ProteinMutationContext> {
  await queryClient.cancelQueries({ queryKey: ['health', 'protein'] })
  const previous = queryClient.getQueriesData<ProteinDay[]>({ queryKey: ['health', 'protein'] })

  for (const [queryKey, days] of previous) {
    if (!days || !dateFallsWithinProteinQuery(queryKey, date)) continue
    queryClient.setQueryData(queryKey, applyProteinOptimistic(days, date, grams, mode))
  }

  return { previous }
}

function restoreProteinQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  context: ProteinMutationContext | undefined
): void {
  for (const [queryKey, data] of context?.previous ?? []) queryClient.setQueryData(queryKey, data)
}

export function useProteinLog(fromDate: string, toDate: string) {
  return useQuery<ProteinDay[]>({
    queryKey: ['health', 'protein', fromDate, toDate],
    queryFn: () => window.api.getProteinLog(fromDate, toDate),
    staleTime: 60_000
  })
}

export function useAddProtein() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ date, grams }: { date: string; grams: number }) =>
      window.api.addProtein(date, grams),
    scope: { id: 'protein-log' },
    meta: { errorMessage: 'Couldn’t add the protein entry. The previous total was restored.' },
    onMutate: ({ date, grams }) => optimisticallyUpdateProtein(queryClient, date, grams, 'add'),
    onError: (_error, _variables, context) => restoreProteinQueries(queryClient, context),
    onSuccess: (result) => {
      if (!isQueuedWriteReceipt(result)) {
        void queryClient.invalidateQueries({ queryKey: ['health', 'protein'] })
      }
    }
  })
}

export function useSetProtein() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ date, grams }: { date: string; grams: number }) =>
      window.api.setProtein(date, grams),
    scope: { id: 'protein-log' },
    meta: { errorMessage: 'Couldn’t correct the protein total. The previous value was restored.' },
    onMutate: ({ date, grams }) => optimisticallyUpdateProtein(queryClient, date, grams, 'set'),
    onError: (_error, _variables, context) => restoreProteinQueries(queryClient, context),
    onSuccess: (result) => {
      if (!isQueuedWriteReceipt(result)) {
        void queryClient.invalidateQueries({ queryKey: ['health', 'protein'] })
      }
    }
  })
}
