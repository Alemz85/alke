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

/**
 * Adds to a day's protein total. Takes the date up front (not just at
 * `.mutate()` time) so `scope` — fixed at `useMutation()` construction — can
 * be keyed per-date: mutations sharing a scope run serially, one at a time,
 * and a flat 'protein-log' scope meant logging today's protein queued
 * behind an in-flight edit of an unrelated day (e.g. a backfilled correction
 * for yesterday), even though the two writes touch different rows and have
 * no reason to serialize. Same-day repeats DO need to serialize: onError
 * restores from a pre-mutation snapshot, so two in-flight adds for the same
 * date racing to settle could let an earlier failure roll back a later
 * success. Mirrors the gym-session / injury-log-delete scoping fix.
 */
export function useAddProtein(date: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ date, grams }: { date: string; grams: number }) =>
      window.api.addProtein(date, grams),
    scope: { id: `protein-log:${date}` },
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

/** Overwrites a day's protein total (a correction). See useAddProtein above for the per-date scope rationale. */
export function useSetProtein(date: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ date, grams }: { date: string; grams: number }) =>
      window.api.setProtein(date, grams),
    scope: { id: `protein-log:${date}` },
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
