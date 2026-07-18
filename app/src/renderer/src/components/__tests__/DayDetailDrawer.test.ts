import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// DayDetailDrawer.tsx imports RouteMap, which imports react-leaflet/leaflet —
// leaflet touches `window` at module-evaluation time, so it can't be
// imported live under this suite's `node` test environment (no jsdom is
// installed in this repo). Every other leaflet-tainted regression guard here
// (e.g. views/__tests__/ChatView.test.ts) uses the same source-text-contract
// approach for exactly this reason — assert against the file's text instead
// of executing it. The gym-log section's actual data logic (grouping sets
// into blocks, deriving body parts, the lookup-window math) is pure and
// tested directly: lib/gymLog.test.ts already covers the shared helpers,
// and hooks/__tests__/useGymData.test.ts covers resolveGymSessionLookupWindow.
const source = readFileSync(new URL('../DayDetailDrawer.tsx', import.meta.url), 'utf8')
const gymViewSource = readFileSync(new URL('../../views/GymView.tsx', import.meta.url), 'utf8')

describe('DayDetailDrawer gym log wiring (source contract)', () => {
  it('gates the gym log section on strength type and the caller display contract', () => {
    expect(source).toMatch(/\{isStrength && showGymLog && \(\s*<GymLogSection/)
  })

  it('skips the gym-session lookup when the caller supplies its own log panel', () => {
    expect(source).toMatch(
      /useGymSessionForWorkout\(\s*workout\.id,\s*workout\.start_at,\s*isStrength && showGymLog\s*\)/
    )
  })

  it('keeps one shared read-only call site for ordinary drawer callers', () => {
    const occurrences = source.match(/<GymLogSection/g) ?? []
    expect(occurrences).toHaveLength(1)
  })

  it('has the Gym view suppress the read-only copy when it injects GymWorkoutPanel', () => {
    expect(source).toContain('showGymLog = true')
    expect(gymViewSource).toMatch(/<DayDetailDrawer[\s\S]*?showGymLog=\{false\}[\s\S]*?<GymWorkoutPanel/)
  })

  it('has no "Edit log" affordance — the section is read-only outside the Gym tab', () => {
    // Strip line comments first: the code deliberately explains the omission
    // in prose ("No 'Edit log' button here...") — this asserts there is no
    // actual button/handler, not that the phrase never appears in a comment.
    const codeOnly = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    expect(codeOnly).not.toContain('Edit log')
    expect(codeOnly).not.toContain('gym-log-edit-button')
    expect(codeOnly).not.toContain('onEdit')
  })

  it('shows a not-logged empty state instead of silently omitting the section', () => {
    expect(source).toContain('Not logged yet')
  })

  it('shows a loading state while the gym session lookup is in flight', () => {
    const gymLogSectionMatch = source.match(
      /function GymLogSection\(([\s\S]*?)\n\}\n/
    )
    expect(gymLogSectionMatch).not.toBeNull()
    const [, body] = gymLogSectionMatch as RegExpMatchArray
    expect(body).toContain('isLoading')
    expect(body).toContain('Loading...')
  })

  it('reuses the shared gymLog helpers instead of re-deriving grouping/body-part logic', () => {
    expect(source).toContain('groupSetsIntoBlocks')
    expect(source).toContain('groupExerciseBlocksByBodyPart')
    expect(source).toContain('sessionBodyParts')
    expect(source).toContain('formatExerciseSetSummary')
  })
})
