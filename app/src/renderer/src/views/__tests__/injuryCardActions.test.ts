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

  it('does not render StatusControl inside the top action rows anymore', () => {
    // The old placement rendered <StatusControl /> immediately after the
    // flare form / inside the readOnly injury-actions div, above the
    // stat row and charts. Guard against reintroducing it there.
    const readOnlyActionsBlock = source.match(
      /\{readOnly && \(\s*<div className="injury-actions">([\s\S]*?)<\/div>\s*\)\}/
    )
    expect(readOnlyActionsBlock).not.toBeNull()
    expect(readOnlyActionsBlock?.[1] ?? '').not.toContain('StatusControl')
  })

  it('groups the footer as a flex row (lifecycle actions read as one group)', () => {
    expect(css).toMatch(/\.injury-lifecycle-footer\s*\{[^}]*display:\s*flex/s)
  })
})
