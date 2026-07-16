import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../InjuriesView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../InjuriesView.css', import.meta.url), 'utf8')

describe('active injury cards are user-reorderable', () => {
  it('persists order via the shared useCardOrder hook, scoped to the active list', () => {
    expect(source).toContain("import { useCardOrder } from '../hooks/useCardOrder'")
    expect(source).toContain("useCardOrder('injuries:active:order', activeIds)")
  })

  it('derives activeIds from the active (non-resolved) list, not all injuries', () => {
    const viewBody = source.match(/export function InjuriesView\(\): ReactElement \{[\s\S]*$/)?.[0] ?? ''
    expect(viewBody).toContain(
      "const active = injuries.filter((i) => i.status === 'active' || i.status === 'recovering')"
    )
    expect(viewBody).toContain('const activeIds = useMemo(() => active.map((i) => i.id)')
  })

  it('renders the active list from the reconciled order, not the raw active array', () => {
    const listMatch = source.match(/<div className="injury-list">([\s\S]*?)<\/div>\s*\)\s*\)\s*: history/)
    expect(listMatch).not.toBeNull()
    const body = listMatch?.[1] ?? ''
    expect(body).toContain('orderedActive.map((injury)')
  })

  it('history table is untouched by reordering (no ReorderHandle, no cardOrder wiring)', () => {
    const historySection = source.match(/history\.length === 0 \? \(([\s\S]*?)\n {6}\)/)?.[1] ?? ''
    expect(historySection).not.toContain('ReorderHandle')
    expect(historySection).not.toContain('cardOrder')
  })

  it('wires drag-and-drop plus an up/down keyboard fallback through ReorderHandle', () => {
    const handleFn = source.match(/function ReorderHandle\([\s\S]*?\n}\n\n\/\/ ── active injury card/)?.[0] ?? ''
    expect(handleFn).toContain('draggable')
    expect(handleFn).toContain('onDragStart')
    expect(handleFn).toContain('onDragEnd')
    expect(handleFn).toContain('onMoveUp')
    expect(handleFn).toContain('onMoveDown')
    expect(handleFn).toContain('aria-label="Move up"')
    expect(handleFn).toContain('aria-label="Move down"')
  })

  it('the grip and step buttons stop click propagation so they never trigger card navigation', () => {
    const handleFn = source.match(/function ReorderHandle\([\s\S]*?\n}\n\n\/\/ ── active injury card/)?.[0] ?? ''
    // three stopPropagation call sites: the grip's onClick, move-up, move-down
    const stops = handleFn.match(/e\.stopPropagation\(\)/g) ?? []
    expect(stops.length).toBeGreaterThanOrEqual(3)
  })

  it('drop reorders via moveBefore(draggedId, targetId), guarding a drop onto itself', () => {
    const cardMatch = source.match(/onDrop: \(e\) => \{[\s\S]*?\n {18}\},/)
    expect(cardMatch).not.toBeNull()
    const body = cardMatch?.[0] ?? ''
    expect(body).toContain('if (draggedId == null || draggedId === injury.id) return')
    expect(body).toContain('cardOrder.moveBefore(draggedId, injury.id)')
  })

  it('up/down buttons disable at the ends of the active list via isFirst/isLast', () => {
    expect(source).toContain('disableUp={reorder.isFirst}')
    expect(source).toContain('disableDown={reorder.isLast}')
    expect(source).toContain('isFirst: cardOrder.isFirst(injury.id)')
    expect(source).toContain('isLast: cardOrder.isLast(injury.id)')
  })

  it('the dragged card is visually de-emphasized', () => {
    expect(source).toContain("reorder.dragging ? ' injury-card--dragging' : ''")
    expect(css).toMatch(/\.injury-card--dragging\s*\{[^}]*opacity:/s)
  })

  it('the handle is quiet by default and reveals on card hover / its own focus', () => {
    expect(css).toMatch(/\.reorder-handle\s*\{[^}]*opacity:\s*0/s)
    expect(css).toMatch(/\.injury-card--clickable:hover \.reorder-handle\s*\{[^}]*opacity:\s*1/s)
    expect(css).toMatch(/\.reorder-handle:focus-within\s*\{[^}]*opacity:\s*1/s)
  })
})
