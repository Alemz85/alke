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

  it('describes the actual calibration signals and keeps swim efficiency separate', () => {
    expect(source).toContain('Built from Zone 2 load')
    expect(source).toContain('swim efficiency stays separate because technique can dominate it')
    expect(source).not.toContain('Built from your swim and bike pace/HR')
  })

  it('does not claim uncertain rows are frozen at a last-known value', () => {
    expect(source).not.toContain('Showing last known value')
  })

  it('requires a real minimum aerobic dose before a workout counts as a session', () => {
    // The old `> 0` rule let a stroll with barely any Z2 time onto the calendar and
    // reset the +24-48h build-window anchor. Qualification now mirrors the
    // model: z2+z3 plus HALF the z1b easy-aerobic band, against a marked
    // chosen-prior floor of ten effective minutes.
    expect(source).toContain('const MIN_SESSION_EFFECTIVE_AEROBIC_S = 600')
    expect(source).toContain('[CHOSEN PRIOR]')
    expect(source).toContain(
      "zoneSeconds(w, 'z2') + zoneSeconds(w, 'z3') + 0.5 * zoneSeconds(w, 'z1b')"
    )
    expect(source).toContain('effective >= MIN_SESSION_EFFECTIVE_AEROBIC_S')
    expect(source).not.toMatch(/zoneSeconds\(w, 'z2'\) \+ zoneSeconds\(w, 'z3'\) > 0/)
  })
})
