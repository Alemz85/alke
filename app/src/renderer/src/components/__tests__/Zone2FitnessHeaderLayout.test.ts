import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../Zone2FitnessHeader.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../Zone2FitnessHeader.css', import.meta.url), 'utf8')

describe('Zone2FitnessHeader layout', () => {
  it('uses Cardio fitness index as the single card title', () => {
    expect(source).toContain('<h2 className="z2f-title">Cardio fitness index</h2>')
    expect(source).not.toContain('Aerobic base and fast form')
  })

  it('places the proportional composition before the full-width trajectory', () => {
    expect(source.indexOf('className="z2f-composition"')).toBeLessThan(
      source.indexOf('className="z2f-trend"')
    )
    expect(source).toContain('className="z2f-meter z2f-meter--durable"')
    expect(source).toContain('className="z2f-meter z2f-meter--fast"')
    expect(styles).toContain('.z2f-meter--durable')
    expect(styles).toContain('.z2f-meter--fast')
  })

  it('uses an inset plot surface and a full-width footnote', () => {
    expect(styles).toMatch(/\.z2f-trend \.z2traj-plot\s*{[^}]*background: var\(--color-surface\)/s)
    expect(styles).toMatch(/\.z2f-footnote\s*{[^}]*max-width: none/s)
  })
})
