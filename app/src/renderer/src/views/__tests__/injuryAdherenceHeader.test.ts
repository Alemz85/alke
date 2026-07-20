import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('injury adherence column headers', () => {
  it('puts concise phase timing below an uncropped task name', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../InjuriesView.css', import.meta.url), 'utf8')

    expect(source).toContain('injury-adh-th-meta')
    expect(source).toContain('phaseStartYMD(item, planStartedAt)')
    expect(source).not.toContain('starts wk')
    expect(css).toMatch(/\.injury-adh-th-label\s*\{[^}]*white-space:\s*normal/s)
    expect(css).toMatch(/\.injury-adh-th-meta\s*\{[^}]*display:\s*block/s)
  })

  it('shows the accountable exercise dose thresholds and labels activities as unscored', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain('currentWeekAdherenceSummary(plan, checks, todayYMD, planStartedAt)')
    expect(thisWeek).toContain('acceptable')
    expect(thisWeek).toContain('minimum')
    expect(thisWeek).toContain('prescribed')
    expect(thisWeek).toContain('Unscored')
  })

  it('does not present future-phase items as owing current-week progress', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''
    const renderHeader =
      thisWeek.match(/const renderHeader = \([\s\S]*?\n  const renderCell =/)?.[0] ?? ''
    const futureBranch =
      renderHeader.match(/if \(!summaryRow\.accountable\) \{([\s\S]*?)\} else if \(!summaryRow\.scored\)/)?.[1] ?? ''

    expect(futureBranch).toContain("progressDetails.push('Unscored')")
    expect(futureBranch).toContain('`${summaryRow.done} done early`')
    expect(futureBranch).not.toContain('this week')
  })

  it('renders a threshold-colored week-to-date score or an honest unavailable state', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain('Week-to-date adherence')
    expect(thisWeek).toContain('Not yet scored')
    expect(thisWeek).toContain('adherenceRating(summary.pct, 100)')
  })
})
