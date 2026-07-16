import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source-contract test (no rendering — App.tsx pulls in every view + IPC,
// matching this repo's convention for wiring checks, e.g.
// views/__tests__/chartCardScoping.test.ts, injuryCardActions.test.ts).
//
// Regression guard for the bug where switching tabs never refetched the
// workout-range queries (useAllWorkouts/useYearWorkouts/useMonthWorkouts/
// useRecentWorkouts/useWorkoutsInRange): App.tsx renders exactly one tab's
// view at a time, so navigating is always a fresh mount, but a query fetched
// within the last staleTime (60s) doesn't refetch just because it remounted.
// The fix invalidates those keys on activation of any workout-consuming tab.
const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

describe('App tab-activation workout invalidation', () => {
  it('imports invalidateWorkoutViews from the gym data hooks module', () => {
    expect(source).toMatch(/import\s*\{\s*invalidateWorkoutViews\s*\}\s*from\s*'\.\/hooks\/useGymData'/)
  })

  it('lists dashboard, sessions, zone2, and gym as workout-view tabs', () => {
    const match = source.match(/WORKOUT_VIEW_TABS[^=]*=\s*new Set\(\[([^\]]*)\]\)/)
    expect(match).not.toBeNull()
    const members = match?.[1] ?? ''
    for (const tab of ['dashboard', 'sessions', 'zone2', 'gym']) {
      expect(members).toContain(`'${tab}'`)
    }
  })

  it('invalidates workout views whenever handleSelectTab lands on a workout-view tab', () => {
    const fnMatch = source.match(
      /const handleSelectTab = useCallback\(\s*\(tab: TabId\): void => \{([\s\S]*?)\},\s*\[queryClient\]/
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch?.[1] ?? ''
    expect(body).toContain('setActiveTab(tab)')
    expect(body).toMatch(/if \(WORKOUT_VIEW_TABS\.has\(tab\)\) invalidateWorkoutViews\(queryClient\)/)
  })

  it('invalidates workout views when openSessions navigates to Sessions', () => {
    const fnMatch = source.match(
      /const openSessions = useCallback\(\s*\(activity\?: string\): void => \{([\s\S]*?)\},\s*\[queryClient\]/
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch?.[1] ?? ''
    expect(body).toContain("setActiveTab('sessions')")
    expect(body).toContain('invalidateWorkoutViews(queryClient)')
  })
})
