import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { invalidateWorkoutViews, resolveGymSessionLookupWindow } from '../useGymData'

// invalidateWorkoutViews is the fix for the bug where logging/editing/deleting
// a gym session (mutations that only ever patched ['health','gym','sessions',...]
// via optimistic updates) never told the Dashboard/Sessions workout-range
// queries anything had changed. Those queries carry a 60s staleTime, and
// App.tsx unmounts/remounts the inactive tab's view on every switch, so a
// "fresh" (< 60s old) cache entry silently never refetches on remount. This
// test asserts the exact key set gets marked stale (query.isStale() flips
// true, which is what makes an already-mounted observer refetch and what
// makes the next mount's refetchOnMount actually hit the network).
function seedFreshQuery(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  queryClient.setQueryData(queryKey, [])
  // Give it a staleTime so isStale() reflects real "was this fetched recently"
  // semantics rather than defaulting to always-stale with no staleTime set.
  const query = queryClient.getQueryCache().find({ queryKey })
  query?.setState({ ...query.state, dataUpdatedAt: Date.now() })
}

describe('invalidateWorkoutViews', () => {
  it('marks the Sessions/Zone2/Gym workout-range queries stale', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } }
    })
    seedFreshQuery(queryClient, ['health', 'allWorkouts'])
    seedFreshQuery(queryClient, ['health', 'yearWorkouts', '2026-07-01'])
    seedFreshQuery(queryClient, ['health', 'monthWorkouts', 2026, 7])

    // Sanity check: freshly-seeded queries with a 60s staleTime start NOT stale
    // (this is the exact condition that hides new data across a tab switch).
    for (const key of [
      ['health', 'allWorkouts'],
      ['health', 'yearWorkouts', '2026-07-01'],
      ['health', 'monthWorkouts', 2026, 7]
    ]) {
      expect(queryClient.getQueryCache().find({ queryKey: key })?.isStale()).toBe(false)
    }

    invalidateWorkoutViews(queryClient)

    for (const key of [
      ['health', 'allWorkouts'],
      ['health', 'yearWorkouts', '2026-07-01'],
      ['health', 'monthWorkouts', 2026, 7]
    ]) {
      expect(queryClient.getQueryCache().find({ queryKey: key })?.isStale()).toBe(true)
    }
  })

  it('marks the Dashboard workout queries stale', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } }
    })
    seedFreshQuery(queryClient, [
      'dashboard',
      'workouts',
      '2026-04-01T00:00:00.000Z',
      '2026-07-16T23:59:59.999Z'
    ])
    seedFreshQuery(queryClient, [
      'dashboard',
      'workoutsRange',
      '2026-07-13T00:00:00.000Z',
      '2026-07-19T23:59:59.999Z'
    ])

    invalidateWorkoutViews(queryClient)

    expect(
      queryClient
        .getQueryCache()
        .find({
          queryKey: ['dashboard', 'workouts', '2026-04-01T00:00:00.000Z', '2026-07-16T23:59:59.999Z']
        })
        ?.isStale()
    ).toBe(true)
    expect(
      queryClient
        .getQueryCache()
        .find({
          queryKey: [
            'dashboard',
            'workoutsRange',
            '2026-07-13T00:00:00.000Z',
            '2026-07-19T23:59:59.999Z'
          ]
        })
        ?.isStale()
    ).toBe(true)
  })

  it('does not touch unrelated query families (e.g. gym sessions, exercises)', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } }
    })
    seedFreshQuery(queryClient, ['health', 'gym', 'sessions', '2026-01-01T00:00:00.000Z', '2026-07-16T00:00:00.000Z'])
    seedFreshQuery(queryClient, ['health', 'exercises'])

    invalidateWorkoutViews(queryClient)

    expect(
      queryClient
        .getQueryCache()
        .find({
          queryKey: ['health', 'gym', 'sessions', '2026-01-01T00:00:00.000Z', '2026-07-16T00:00:00.000Z']
        })
        ?.isStale()
    ).toBe(false)
    expect(queryClient.getQueryCache().find({ queryKey: ['health', 'exercises'] })?.isStale()).toBe(
      false
    )
  })
})

// resolveGymSessionLookupWindow backs useGymSessionForWorkout — the
// DayDetailDrawer's self-sufficient gym-log lookup (opening a strength day
// from Dashboard/Sessions now shows the same workout log the Gym tab shows).
// Extracted as a pure function because the hook itself calls useQuery and
// can't run outside a QueryClientProvider/DOM environment; this covers the
// windowing math directly.
describe('resolveGymSessionLookupWindow', () => {
  it('returns a window padded a day either side of the workout start when enabled', () => {
    const result = resolveGymSessionLookupWindow('2026-07-12T09:00:00.000Z', true)
    expect(result).toEqual({
      fromIso: '2026-07-11T09:00:00.000Z',
      toIso: '2026-07-13T09:00:00.000Z'
    })
  })

  it('returns null when disabled (e.g. a non-strength workout)', () => {
    expect(resolveGymSessionLookupWindow('2026-07-12T09:00:00.000Z', false)).toBeNull()
  })

  it('returns null for a null start time even when enabled', () => {
    expect(resolveGymSessionLookupWindow(null, true)).toBeNull()
  })

  it('returns null for an unparseable start time', () => {
    expect(resolveGymSessionLookupWindow('not-a-date', true)).toBeNull()
  })
})
