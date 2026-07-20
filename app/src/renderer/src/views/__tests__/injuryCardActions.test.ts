import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../InjuriesView.css', import.meta.url), 'utf8')

describe('injury full-view lifecycle actions placement', () => {
  it('renders Mark as healed / Reopen (StatusControl) in the bottom lifecycle footer with Delete', () => {
    // Regression guard: StatusControl used to render right after ActionRow,
    // near the top of the card. It must now live in the same footer as
    // InjuryDeleteControl, at the bottom of the full-view card.
    const footerMatch = source.match(
      /<div className="injury-lifecycle-footer">([\s\S]*?)<\/div>/
    )
    expect(footerMatch).not.toBeNull()
    const footerBody = footerMatch?.[1] ?? ''
    expect(footerBody).toContain('<StatusControl')
    expect(footerBody).toContain('<InjuryDeleteControl')
  })

  it('keeps routine logging to two actions in full view while previews retain plan access', () => {
    const preview = source.match(/function ActiveInjuryCard\([\s\S]*?\n\/\/ ── full injury view/)?.[0] ?? ''
    const full = source.match(/function InjuryFullView\([\s\S]*?\n\/\/ ── history row/)?.[0] ?? ''

    expect(preview).toContain('<ActionRow')
    expect(preview).not.toContain('showPlanAction={false}')
    expect(full).toContain('showPlanAction={false}')
  })

  it('groups the footer as a flex row (lifecycle actions read as one group)', () => {
    expect(css).toMatch(/\.injury-lifecycle-footer\s*\{[^}]*display:\s*flex/s)
  })

  it('keeps recovery plan access beside plan timing for every full-view lifecycle state', () => {
    const full = source.match(/function InjuryFullView\([\s\S]*?\n\/\/ ── history row/)?.[0] ?? ''
    const accessRow = full.match(/<div className="injury-plan-access-row">([\s\S]*?)<\/div>/)?.[1] ?? ''

    expect(accessRow).toContain('<PlanStartControl')
    expect(accessRow).toContain('View recovery plan')
    expect(full).not.toMatch(/\{readOnly && \(\s*<div className="injury-actions">/)
    expect(css).toMatch(/\.injury-plan-access-row\s*\{[^}]*flex-wrap:\s*wrap/s)
  })
})
