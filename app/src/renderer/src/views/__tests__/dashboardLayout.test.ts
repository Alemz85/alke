import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../DashboardView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../DashboardView.css', import.meta.url), 'utf8')

describe('Dashboard card layout', () => {
  it('leads the card stack with the hero metric, then the glance row', () => {
    const stackStart = source.indexOf('<div className="dashboard-card-stack">')
    const stack = source.slice(stackStart, source.indexOf('<GymTemplatesBox'))

    expect(stackStart).toBeGreaterThan(-1)
    expect(stack).toContain('<div className="dashboard-hero-card">')
    expect(stack).toContain('<div className="dashboard-glance-grid">')
    // The one hero number owns the top of the view; the standing figures follow.
    expect(stack.indexOf('dashboard-hero-card')).toBeLessThan(
      stack.indexOf('dashboard-glance-grid')
    )
    expect(stack).not.toContain('dashboard-calendar-grid')
  })

  it('orders the sections forward-looking first: templates, calendar, then recent', () => {
    // What to train next, then the month's shape, then what was just done
    // (user's ordering, 2026-08-17).
    const templatesStart = source.indexOf('<GymTemplatesBox')
    const calendarStart = source.indexOf('<div className="dashboard-calendar-grid">')
    const recentStart = source.indexOf('<RecentSessionsBox')

    expect(templatesStart).toBeGreaterThan(-1)
    expect(calendarStart).toBeGreaterThan(templatesStart)
    expect(recentStart).toBeGreaterThan(calendarStart)
  })

  it('keeps phone pairing out of the overview — it belongs with the templates', () => {
    expect(source).not.toContain('PhoneCardButton')
  })

  it('spaces the grouped card grids with the dashboard spacing token', () => {
    const rule = styles.match(/\.dashboard-card-stack\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(rule).toMatch(/display:\s*flex;/)
    expect(rule).toMatch(/flex-direction:\s*column;/)
    expect(rule).toMatch(/gap:\s*var\(--space-md\);/)
  })

  it('gives the hero card the reserved hero padding and the shared card edge', () => {
    const rule = styles.match(/\.dashboard-hero-card\s*\{([\s\S]*?)\}/)?.[1] ?? ''

    // DESIGN.md reserves 32px padding for hero-metric cards; everything else is 24px.
    expect(rule).toContain('padding: var(--space-xl)')
    expect(rule).toContain('background: var(--color-surface-elevated)')
    expect(rule).toContain('border: 1px solid var(--card-border)')
    expect(rule).toContain('border-radius: var(--radius-lg)')
  })

  it('runs the glance row three-up at desktop widths', () => {
    const rule = styles.match(/\.dashboard-glance-grid\s*\{([\s\S]*?)\}/)?.[1] ?? ''

    expect(rule).toContain('repeat(3, minmax(0, 1fr))')
    expect(rule).toContain('gap: var(--space-md)')
  })

  it('splits the lead row 8/4 between the hero card and the RHR tile', () => {
    const leadRow = source.slice(
      source.indexOf('<div className="dashboard-grid">'),
      source.indexOf('dashboard-glance-grid')
    )

    expect(leadRow).toContain('dashboard-grid--span-8')
    expect(leadRow).toContain('dashboard-grid--span-4')
    expect(leadRow.indexOf('dashboard-hero-card')).toBeLessThan(leadRow.indexOf('StatSquare'))
  })

  it('keeps the adherence bar on the sessions accent, never the flag colour', () => {
    const rule = styles.match(/\.dashboard-sessions-bar-fill\s*\{([\s\S]*?)\}/)?.[1] ?? ''

    // Missing a weekly minimum is information, not a warning.
    expect(rule).toContain('var(--color-sessions)')
    expect(rule).not.toContain('flag')
  })
})
