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
})
