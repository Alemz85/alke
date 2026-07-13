import { MutationCache, QueryClient, type Query } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client'
import { publishMutationError } from './mutationFeedback'

// Cache survival window: persisted entries older than this are dropped on
// rehydrate. gcTime must be at least this long or TanStack will garbage
// collect (and therefore never persist) queries before they reach this age.
const MAX_AGE_MS = 1000 * 60 * 60 * 24 // 24h

// Bump this when the shape of persisted query data changes incompatibly
// (e.g. a query fn's return type changes) to invalidate old caches.
const CACHE_BUSTER = 'v1'

// Query key prefixes that must always be served fresh rather than replayed
// from localStorage:
// - 'dbStatus': the live connection probe. Serving this stale would hide a
//   real Supabase outage behind last-known-good "connected" data.
// - 'chat': status/session lists are cheap to refetch and benefit from
//   always being current rather than showing stale session state.
const EXCLUDED_QUERY_KEY_PREFIXES = new Set(['dbStatus', 'chat'])

function shouldPersistQuery(query: Query): boolean {
  const firstKey = query.queryKey[0]
  return typeof firstKey !== 'string' || !EXCLUDED_QUERY_KEY_PREFIXES.has(firstKey)
}

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (_error, _variables, _context, mutation) => {
      const message = mutation.meta?.errorMessage
      if (typeof message === 'string' && message.length > 0) publishMutationError(message)
    }
  }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // Must be >= MAX_AGE_MS so entries aren't garbage-collected from
      // memory (and dropped from persistence) before persistOptions.maxAge
      // would otherwise expire them.
      gcTime: MAX_AGE_MS
    }
  }
})

export const persister = createSyncStoragePersister({
  storage: window.localStorage
})

export const persistOptions: PersistQueryClientOptions = {
  queryClient,
  persister,
  maxAge: MAX_AGE_MS,
  buster: CACHE_BUSTER,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) => shouldPersistQuery(query)
  }
}
