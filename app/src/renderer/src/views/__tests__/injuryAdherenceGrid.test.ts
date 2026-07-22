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

  it('places the weekly scorecard before the horizontally scrollable daily table', () => {
    const thisWeek = source.match(/function ThisWeekTable\([\s\S]*?\n\/\/ ── /)?.[0] ?? ''
    const summaryIndex = thisWeek.indexOf('className="injury-current-week-scorecard"')
    const tableIndex = thisWeek.indexOf('className="injury-adh-wrap"')

    expect(summaryIndex).toBeGreaterThan(-1)
    expect(tableIndex).toBeGreaterThan(summaryIndex)
    expect(css).toMatch(/\.injury-adh-wrap\s*\{[^}]*overflow-x:\s*auto/s)
    expect(css).toMatch(/\.injury-adh-table\s*\{[^}]*min-width:/s)
  })

  it('renders adherence as a dedicated D3-banded weekly strip below the daily pain chart', () => {
    expect(source).toContain("import { scaleBand } from 'd3-scale'")
    expect(source).toContain('function WeeklyAdherenceStrip')
    expect(source).toContain('scaleBand<string>()')
    expect(source).toContain('Adherence weekly')
    expect(source).toContain('Pain daily')
    expect(source).not.toContain('dataKey="adherence"')
    expect(source).not.toContain('yAxisId="adh"')
    expect(source).toContain('Not scored')
  })

  it('uses one explicit numeric UTC time scale with stable unique ticks for daily pain', () => {
    expect(source).toContain('buildPainTimeAxis')
    expect(source).toContain('const painTimeAxis = buildPainTimeAxis(data.map((point) => point.date))')
    expect(source).toContain('dataKey="timestamp"')
    expect(source).toContain('type="number"')
    expect(source).toContain('domain={painTimeAxis.domain}')
    expect(source).toContain('ticks={painTimeAxis.ticks}')
    expect(source).toContain('tickFormatter={formatPainAxisDate}')
    expect(source).not.toContain('tickFormatter={(d: string) => d.slice(5)}')
  })

  it('makes the fixed-width weekly strip a readable, keyboard-scrollable semantic list', () => {
    const weeklyStrip =
      source.match(/function WeeklyAdherenceStrip\([\s\S]*?\n\/\/ ── quick-log/)?.[0] ?? ''

    expect(weeklyStrip).toContain('const WEEK_STRIP_CELL_WIDTH = 80')
    expect(weeklyStrip).toContain('.range([0, stripWidth])')
    expect(weeklyStrip).toContain('className="injury-weekly-adherence-scroll"')
    expect(weeklyStrip).toContain('tabIndex={0}')
    expect(weeklyStrip).toContain('aria-label="Weekly adherence, oldest to newest"')
    expect(weeklyStrip).toContain('<ol')
    expect(weeklyStrip).toContain('<li')
    expect(weeklyStrip).toContain("week.pct == null ? '—' : `${week.pct}%`")
    expect(css).toMatch(/\.injury-weekly-adherence-scroll\s*\{[^}]*overflow-x:\s*auto/s)
    expect(css).toMatch(/\.injury-weekly-adherence-scroll:focus-visible\s*\{/)
  })

  it('gates the trend section on actual pain readings or scored adherence', () => {
    expect(source).toContain('series.some((point) => point.pain != null)')
    expect(source).toContain('weekly.some((week) => week.pct != null)')
    expect(source).not.toContain("log.length > 0 || weekly.some")
  })

  it('uses design typography tokens at a 12px minimum in the weekly strip', () => {
    const weeklyCss = css.match(/\.injury-weekly-adherence\s*\{[\s\S]*?\.injury-weekly-adherence-cell--zero\s*\{[^}]*\}/)?.[0] ?? ''

    expect(weeklyCss).toContain('var(--type-caption-size)')
    expect(weeklyCss).not.toMatch(/font-size:\s*(9|10|11)px/)
    expect(weeklyCss).not.toContain('letter-spacing: 0.1px')
  })

  it('reserves enough band height for a wrapped date, value and current pace', () => {
    expect(css).toMatch(/\.injury-weekly-adherence-strip\s*\{[^}]*height:\s*88px/s)
  })
})
