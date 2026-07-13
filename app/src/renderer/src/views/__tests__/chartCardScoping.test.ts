import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('chart-card view styling', () => {
  it('keeps Insights chart spacing scoped to Insights', () => {
    const css = readFileSync(new URL('../InsightsView.css', import.meta.url), 'utf8')

    expect(css).not.toMatch(/\.view\s+\.chart-card/)
    expect(css).toContain('.insights-view .chart-card')
  })

  it('does not add a visible expand control to the clickable Dashboard chart', () => {
    const source = readFileSync(new URL('../DashboardView.tsx', import.meta.url), 'utf8')

    expect(source).not.toContain('dashboard-load-chart-expand')
    expect(source).not.toContain('Maximize2')
  })
})
