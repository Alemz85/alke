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

  it('keeps future-phase items OUT of the scored table and lists them beneath it', () => {
    // A later-phase row inside the scorecard read as work being missed this
    // week. It is not due yet, so it is not a scored row — but it stays
    // visible, and stays checkable in the daily grid below.
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain("summaryByItem.get(item.id)?.accountable !== false")
    expect(thisWeek).toContain("summaryByItem.get(item.id)?.accountable === false")
    expect(thisWeek).toContain('{accountableColumns.map((item) => {')
    expect(thisWeek).toContain('Starts later')
    expect(thisWeek).toContain('done early')
    // The daily checklist still renders every column, future ones included.
    expect(thisWeek).toContain('{columns.map((item, i) => (')
  })

  it('records early completions without calling them due', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain('isPlanItemAccountable(item, planStartedAt, ymd)')
    expect(thisWeek).toContain("!accountable && !on ? 'injury-adh-cell--future' : ''")
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

  it('color codes each scorecard row and status from those same adherence thresholds', () => {
    const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../InjuriesView.css', import.meta.url), 'utf8')
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''

    expect(thisWeek).toContain('scorecardRowRating(item)')
    expect(thisWeek).toContain('injury-current-week-scorecard-row--${scorecardRowRating(item)}')
    expect(css).toMatch(
      /\.injury-current-week-scorecard-row--met td\s*\{[^}]*background: var\(--color-aerobic-dim\)/
    )
    expect(css).toMatch(
      /\.injury-current-week-scorecard-row--low td\s*\{[^}]*background: var\(--color-sessions-dim\)/
    )
    expect(css).toMatch(
      /\.injury-current-week-scorecard-row--none td\s*\{[^}]*background: var\(--color-flag-dim\)/
    )
    expect(css).toMatch(/\.injury-scorecard-status--met\s*\{[^}]*var\(--color-aerobic-text\)/)
    expect(css).toMatch(/\.injury-scorecard-status--low\s*\{[^}]*var\(--color-sessions-text\)/)
    expect(css).toMatch(/\.injury-scorecard-status--none\s*\{[^}]*var\(--color-flag-text\)/)
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
    // Thresholds ascend in the order they are reached, so progress across the
    // row reads left to right instead of counting down from the full dose.
    expect(thisWeek).toMatch(
      /<th>Completed<\/th>[\s\S]*<th>Minimum<\/th>\s*<th>Acceptable<\/th>\s*<th>Prescribed<\/th>\s*<th>Status<\/th>/
    )
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

describe('completed-count meter', () => {
  const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../InjuriesView.css', import.meta.url), 'utf8')
  const meter = source.match(/function CompletedMeter\([\s\S]*?\n\}\n/)?.[0] ?? ''

  it('reads the week against the prescribed dose rather than showing a bare count', () => {
    expect(meter).toContain('injury-completed-meter-track')
    expect(meter).toContain('injury-completed-meter-fill')
    expect(meter).toContain('(value / prescribed) * 100')
    expect(meter).toContain('{done}')
    expect(meter).toContain('/ {prescribed}')
  })

  it('marks the minimum and acceptable thresholds on the track', () => {
    expect(meter).toContain('row.minimum != null && row.minimum < prescribed')
    expect(meter).toContain('row.acceptable != null && row.acceptable < prescribed')
    expect(meter).toContain('injury-completed-meter-tick')
  })

  it('clamps the fill so an over-delivered week cannot overflow the track', () => {
    expect(meter).toContain('Math.max(0, Math.min(100,')
  })

  it('shows the number alone when there is no dose to measure against', () => {
    // An activity, or an exercise with no weekly target: a full-looking bar
    // would invent a prescription that was never made.
    expect(meter).toContain('prescribed == null || prescribed <= 0')
    expect(meter).toContain('<span className="tabular-nums">{done}</span>')
  })

  it('is decorative — every number it encodes is already text in the row', () => {
    expect(meter).toContain('aria-hidden="true"')
  })

  it('takes its fill colour from the row rating, so bar and status cannot disagree', () => {
    expect(css).toMatch(
      /\.injury-current-week-scorecard-row--met \.injury-completed-meter-fill\s*\{[^}]*var\(--color-aerobic\)/
    )
    expect(css).toMatch(
      /\.injury-current-week-scorecard-row--low \.injury-completed-meter-fill\s*\{[^}]*var\(--color-sessions\)/
    )
    expect(css).toMatch(
      /\.injury-current-week-scorecard-row--none \.injury-completed-meter-fill\s*\{[^}]*var\(--color-flag\)/
    )
  })

  it('respects reduced-motion for the fill transition', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.injury-completed-meter-fill/)
  })
})
