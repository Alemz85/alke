import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BloodMarker } from '@shared/types'
import { groupByCategory, markerValue, panelAgeLabel } from '../../../lib/bloodPanels'

function marker(overrides: Partial<BloodMarker> = {}): BloodMarker {
  return {
    id: 'm1',
    panel_id: 'p1',
    code: 'hemoglobin',
    label_raw: 'EMOGLOBINA',
    category: 'ematologia',
    value_num: 15.2,
    value_text: null,
    unit: 'g%',
    ref_low: 14,
    ref_high: 18,
    ref_text: '14-18',
    flag: 'normal',
    method: null,
    position: 0,
    ...overrides
  }
}

describe('markerValue', () => {
  it('prefers the printed text when the result was not a plain number', () => {
    // "< 0.4" cannot be stored as a number without asserting something the
    // report did not say, so the text is what must be shown.
    expect(markerValue(marker({ value_num: null, value_text: '< 0.4' }))).toBe('< 0.4')
  })

  it('separates thousands so large counts stay readable', () => {
    const shown = markerValue(marker({ value_num: 5_120_000, value_text: null }))
    expect(shown).not.toBe('5120000')
    expect(shown.replace(/[^0-9]/g, '')).toBe('5120000')
  })

  it('renders an em dash when there is no value at all', () => {
    expect(markerValue(marker({ value_num: null, value_text: null }))).toBe('—')
  })
})

describe('panelAgeLabel', () => {
  const now = new Date('2026-08-05T00:00:00Z')

  it('labels an old panel as historical, so a stale value is never read as current', () => {
    const label = panelAgeLabel('2023-09-01', now)
    expect(label).toContain('3 years ago')
    expect(label).toContain('historical, not current')
  })

  it('says nothing for a panel under a year old', () => {
    expect(panelAgeLabel('2026-03-01', now)).toBeNull()
  })

  it('uses the singular at exactly one year', () => {
    expect(panelAgeLabel('2025-06-01', now)).toContain('1 year ago')
  })
})

describe('groupByCategory', () => {
  it("keeps the report's own ordering inside each group", () => {
    const groups = groupByCategory([
      marker({ id: 'b', code: 'mcv', category: 'ematologia', position: 2 }),
      marker({ id: 'a', code: 'wbc', category: 'ematologia', position: 1 }),
      marker({ id: 'c', code: 'tsh', category: 'tiroide', position: 3 })
    ])
    expect(groups.map(([name]) => name)).toEqual(['ematologia', 'tiroide'])
    expect(groups[0][1].map((m) => m.code)).toEqual(['wbc', 'mcv'])
  })

  it('buckets uncategorised markers rather than dropping them', () => {
    const groups = groupByCategory([marker({ category: null })])
    expect(groups).toHaveLength(1)
    expect(groups[0][0]).toBe('altro')
  })
})

describe('the section never interprets results', () => {
  const source = readFileSync(new URL('../BloodPanelsSection.tsx', import.meta.url), 'utf8')

  it('shows the reference range exactly as the report printed it', () => {
    expect(source).toContain('marker.ref_text')
  })

  it('marks a row only from the stored flag, never from its own judgement', () => {
    // A flag is set by the importer from the report or its printed range. The UI
    // must not re-derive one — a null flag means "no comparison was possible",
    // which is not the same as normal.
    expect(source).toContain("marker.flag === 'low' || marker.flag === 'high'")
    expect(source).not.toMatch(/value_num\s*[<>]\s*(ref_low|ref_high)/)
  })

  it('carries the not-diagnostic disclaimer', () => {
    expect(source).toContain('nothing here is interpreted or diagnostic')
    expect(source).toContain('doctor')
  })
})
