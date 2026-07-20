import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../DashboardView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../DashboardView.css', import.meta.url), 'utf8')

describe('Dashboard card layout', () => {
  it('groups the glance and 12-column grids in a card stack before the calendar', () => {
    const stack =
      source.match(
        /<div className="dashboard-card-stack">([\s\S]*?)\n {6}<\/div>\n\n {6}\{\/\* Calendar \+ period summaries/
      )?.[1] ?? ''

    expect(stack).toContain('<div className="dashboard-glance-grid">')
    expect(stack).toContain('<div className="dashboard-grid">')
    expect(stack.indexOf('dashboard-glance-grid')).toBeLessThan(stack.indexOf('dashboard-grid'))
    expect(stack).not.toContain('dashboard-calendar-grid')
  })

  it('spaces the grouped card grids with the dashboard spacing token', () => {
    const rule = styles.match(/\.dashboard-card-stack\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(rule).toMatch(/display:\s*flex;/)
    expect(rule).toMatch(/flex-direction:\s*column;/)
    expect(rule).toMatch(/gap:\s*var\(--space-md\);/)
  })
})
