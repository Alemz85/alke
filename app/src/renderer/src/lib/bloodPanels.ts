// Pure display logic for the Profile tab's blood-panel section. Kept out of the
// component so the staleness labelling and value formatting are unit-testable
// without dragging in the component barrel (and Leaflet with it).
//
// Nothing here interprets a result. Range comparison happens once, in
// scripts/import_blood_panel.py, against the range the report itself printed;
// this file only formats what was stored.
import type { BloodMarker } from '@shared/types'

/** Years between a panel and today, for the staleness caption. */
export function panelAgeYears(collectedOn: string, now: Date): number {
  const [y, m, d] = collectedOn.split('-').map(Number)
  const then = Date.UTC(y, (m || 1) - 1, d || 1)
  return (now.getTime() - then) / (365.25 * 24 * 60 * 60 * 1000)
}

/**
 * How a panel's date should be framed. Lab values age: a three-year-old panel
 * describes a body that has since changed, and presenting it flat invites the
 * reader (or the chat agent) to treat it as current. Anything past two years is
 * explicitly labelled historical.
 */
export function panelAgeLabel(collectedOn: string, now: Date): string | null {
  const years = panelAgeYears(collectedOn, now)
  if (years < 1) return null
  // ROUND, don't floor: a panel 2.98 years old reading "2 years ago" understates
  // its staleness, and understating staleness is the exact failure this label
  // exists to prevent. Floored at 1 so a rounded value can never contradict the
  // under-a-year check above.
  const rounded = Math.max(1, Math.round(years))
  return `${rounded} year${rounded === 1 ? '' : 's'} ago — historical, not current`
}

/** Display value: the printed text when the result wasn't a plain number ("< 0.4"). */
export function markerValue(marker: BloodMarker): string {
  if (marker.value_text) return marker.value_text
  if (marker.value_num == null) return '—'
  // Large counts (millions per mm³) are unreadable unseparated.
  return marker.value_num.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** Markers grouped by the report's own section, preserving report order. */
export function groupByCategory(markers: BloodMarker[]): [string, BloodMarker[]][] {
  const groups = new Map<string, BloodMarker[]>()
  for (const m of [...markers].sort((a, b) => a.position - b.position)) {
    const key = m.category ?? 'altro'
    const list = groups.get(key)
    if (list) list.push(m)
    else groups.set(key, [m])
  }
  return [...groups.entries()]
}
