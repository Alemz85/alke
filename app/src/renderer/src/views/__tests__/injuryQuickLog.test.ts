import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')

describe('quick-log "Feeling fine" reflects logged-today state', () => {
  it('derives loggedFineToday from the actual log via todayUserEntry, not a timer', () => {
    const actionRow = source.match(/function ActionRow\([\s\S]*?\n\/\/ ── recovery plan modal/)?.[0] ?? ''
    expect(actionRow).toContain('todayUserEntry(log, todayYMD)')
    expect(actionRow).toContain("loggedFineToday = todaysEntry != null && todaysEntry.note === 'Feeling fine'")
    // The old timer-based justLogged/setTimeout approach must be gone: it
    // let the button re-enable after 2s regardless of whether today's entry
    // still existed, which is what allowed repeat clicks to append dupes.
    expect(actionRow).not.toContain('justLogged')
    expect(actionRow).not.toContain('window.setTimeout')
  })

  it('disables the Feeling fine button and relabels it once logged today', () => {
    const actionRow = source.match(/function ActionRow\([\s\S]*?\n\/\/ ── recovery plan modal/)?.[0] ?? ''
    expect(actionRow).toContain('disabled={fineMutation.isPending || loggedFineToday}')
    expect(actionRow).toContain("loggedFineToday ? '✓ Logged today' : 'Feeling fine'")
  })

  it('logFeelingFine is a no-op once already logged today (guards races around the disabled prop)', () => {
    const actionRow = source.match(/function ActionRow\([\s\S]*?\n\/\/ ── recovery plan modal/)?.[0] ?? ''
    const fnMatch = actionRow.match(/const logFeelingFine = \(\): void => \{[\s\S]*?\n  \}/)
    expect(fnMatch).not.toBeNull()
    expect(fnMatch?.[0]).toContain('if (loggedFineToday || fineMutation.isPending) return')
  })

  it('the optimistic update replaces an existing same-day entry instead of always prepending', () => {
    const actionRow = source.match(/function ActionRow\([\s\S]*?\n\/\/ ── recovery plan modal/)?.[0] ?? ''
    const onMutateMatch = actionRow.match(/onMutate: async \(\) => \{[\s\S]*?\n    \},/)
    expect(onMutateMatch).not.toBeNull()
    const body = onMutateMatch?.[0] ?? ''
    expect(body).toContain('todayUserEntry(rows, todayYMD)')
    expect(body).toContain('rows.map((row) => (row.id === existing.id ? temporary : row))')
  })
})

describe('per-entry log delete does not serialize behind unrelated deletes', () => {
  it('scopes the delete mutation per entryId, not a single shared scope string', () => {
    const logRowDelete = source.match(/function LogRowDelete\([\s\S]*?\n}\n/)?.[0] ?? ''
    // Regression guard for the "delete looks stuck until the card is
    // reopened" bug: a single shared scope.id serialized every delete
    // mutation in the app behind whichever one was already in flight.
    expect(logRowDelete).toContain('scope: { id: `injury-log-delete:${entryId}` }')
    expect(logRowDelete).not.toContain("scope: { id: 'injury-log-deletes' }")
  })
})
