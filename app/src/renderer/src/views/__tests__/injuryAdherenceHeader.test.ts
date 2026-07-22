import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('injury weekly scorecard and daily checklist', () => {
  it('puts the recovery-plan section title directly before the plan access controls', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')

    expect(source).toMatch(
      /<SectionTitle eyebrow="Plan" title="Recovery plan"\s*\/>\s*<div className="injury-plan-access-row">/
    )
  })

  it('shows exercise thresholds and leaves activities or untargeted items unscored', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain('currentWeekAdherenceSummary(plan, checks, todayYMD, planStartedAt)')
    expect(thisWeek).toContain('acceptable')
    expect(thisWeek).toContain('minimum')
    expect(thisWeek).toContain('prescribed')
    expect(thisWeek).toContain('Unscored')
  })

  it('shows future-phase start timing and records early completions without calling them due', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain('Starts {formatDateShort(phaseStart)}')
    expect(thisWeek).toContain('`${row.done} done early`')
    expect(thisWeek).not.toContain('injury-adh-th-meta')
  })

  it('renders a threshold-colored pace chip or an honest unavailable state', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain('Current week adherence')
    expect(thisWeek).toContain('Not scored')
    expect(thisWeek).toContain('adherenceRating(summary.pct, 100)')
  })

  it('derives row status from the same acceptable and minimum thresholds it displays', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''
    const renderStatus = thisWeek.match(/const renderStatus = \([\s\S]*?\n\s*const renderCell =/)?.[0] ?? ''

    expect(renderStatus).toContain('row.done >= row.acceptable')
    expect(renderStatus).toContain('row.done >= row.minimum')
    expect(renderStatus).toContain('>Below minimum</span>')
    expect(renderStatus).toContain('>In progress</span>')
    expect(renderStatus).not.toContain('itemAdherenceRating')
  })

  it('separates the weekly scorecard from the simplified daily checklist', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain('className="injury-current-week-scorecard"')
    expect(thisWeek).toContain('<th>Completed</th>')
    expect(thisWeek).toContain('<th>Prescribed</th>')
    expect(thisWeek).toContain('<th>Acceptable</th>')
    expect(thisWeek).toContain('<th>Minimum</th>')
    expect(thisWeek).toContain('<th>Status</th>')
    expect(thisWeek).toMatch(/injury-current-week-scorecard[\s\S]*injury-adh-wrap/)
    expect(thisWeek).not.toContain('injury-adh-th-meta')
    expect(thisWeek).not.toContain('injury-adh-th-progress')
  })

  it('makes the compact scorecard overflow region keyboard accessible', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../InjuriesView.css', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toMatch(
      /className="injury-current-week-scorecard-wrap"\s+tabIndex=\{0\}\s+aria-label="Current week adherence details"/
    )
    expect(css).toMatch(/\.injury-current-week-scorecard-wrap:focus-visible\s*\{/)
  })
})
