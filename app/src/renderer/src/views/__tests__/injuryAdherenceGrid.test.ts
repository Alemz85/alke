import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../InjuriesView.css', import.meta.url), 'utf8')

describe('this-week adherence grid: future-phase muting vs recorded checks', () => {
  it('never mutes a cell that holds a recorded check, even in a not-yet-started phase', () => {
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''
    // Regression guard: a week-3 item completed early (e.g. via the gym→rehab
    // bridge) rendered its checkmark inside an opacity-muted "--future" cell,
    // reading as not-done next to a full-brightness accountable column.
    expect(thisWeek).toContain("!accountable && !on ? 'injury-adh-cell--future' : ''")
    expect(thisWeek).not.toContain("!accountable ? 'injury-adh-cell--future' : ''")
  })

  it('places a wrapping adherence summary before the horizontally scrollable daily table', () => {
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''
    const summaryIndex = thisWeek.indexOf('className="injury-current-week-summary"')
    const tableIndex = thisWeek.indexOf('className="injury-adh-wrap"')

    expect(summaryIndex).toBeGreaterThan(-1)
    expect(tableIndex).toBeGreaterThan(summaryIndex)
    expect(css).toMatch(/\.injury-current-week-summary\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(css).toMatch(/\.injury-adh-wrap\s*\{[^}]*overflow-x:\s*auto/s)
  })
})
