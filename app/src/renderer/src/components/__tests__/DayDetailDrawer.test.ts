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
    expect(gymViewSource).toMatch(
      /<DayDetailDrawer[\s\S]*?showGymLog=\{false\}[\s\S]*?<GymWorkoutPanel/
    )
  })

  it('offers the universal editor from every strength workout, preserving the read-only log section', () => {
    expect(source).toMatch(
      /gymSessionQuery\.data\s*\? \{ kind: 'edit', session: gymSessionQuery\.data \}\s*: \{ kind: 'new-linked', workout \}/
    )
    expect(source).toMatch(/gymSessionQuery\.data\s*\? 'Edit log' : 'Log workout'/)
    expect(source).toContain('onEditorTarget')
    expect(source).toContain('<GymSessionEditorHost')
  })

  it('suppresses the universal action when the Gym view supplies its embedded editor', () => {
    expect(source).toMatch(/\{isStrength && showGymLog && \(\s*<button/)
  })

  it('suspends its Escape listener while the nested editor is active', () => {
    expect(source).toContain('if (editorTarget) return')
    expect(source).toContain('[onClose, editorTarget]')
  })

  it('makes the underlying drawer inert and hidden while the editor owns the active modal surface', () => {
    expect(source).toContain('inert={editorTarget ? true : undefined}')
    expect(source).toContain('aria-hidden={editorTarget ? true : undefined}')
  })

  it('captures and restores the nested editor trigger focus', () => {
    expect(source).toContain('editorTriggerRef.current = document.activeElement as HTMLElement')
    expect(source).toContain('editorTriggerRef.current?.focus()')
    expect(source).toContain('onEditorTarget={openEditor}')
    expect(source).toContain('onClose={closeEditor}')
  })

  it('shows a not-logged empty state instead of silently omitting the section', () => {
    expect(source).toContain('Not logged yet')
  })

  it('shows a loading state while the gym session lookup is in flight', () => {
    const gymLogSectionMatch = source.match(/function GymLogSection\(([\s\S]*?)\n\}\n/)
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

  it('keeps repeated body-part runs and disclosure ids distinct in logged order', () => {
    expect(source).toContain('exerciseGroups.map((group, groupIndex) =>')
    expect(source).toContain('`${groupIndex}-${group.bodyPart}-${block.exerciseId}-${blockIndex}`')
  })
})
