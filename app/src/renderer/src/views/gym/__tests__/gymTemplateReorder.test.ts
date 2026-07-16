import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../GymTemplatesTab.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../GymView.css', import.meta.url), 'utf8')

describe('active template cards are user-reorderable', () => {
  it('persists order via the shared useCardOrder hook, scoped to the active grid', () => {
    expect(source).toContain("import { useCardOrder } from '../../hooks/useCardOrder'")
    expect(source).toContain("useCardOrder('gym:templates:active:order', activeIds)")
  })

  it('derives activeIds from the non-archived templates, not the full templates prop', () => {
    const tabBody = source.match(/export function GymTemplatesTab\(\{[\s\S]*$/)?.[0] ?? ''
    expect(tabBody).toContain('const active = templates.filter((t) => !t.archived)')
    expect(tabBody).toContain('const activeIds = useMemo(() => active.map((t) => t.id)')
  })

  it('renders the active grid from the reconciled order, not the raw active array', () => {
    const gridMatch = source.match(/<div className="gym-tpl-grid">([\s\S]*?)<\/div>\s*\)\s*\}/)
    expect(gridMatch).not.toBeNull()
    expect(gridMatch?.[1] ?? '').toContain('orderedActive.map((t)')
  })

  it('the Archive section has no reorder wiring (only active templates reorder)', () => {
    const archiveFn = source.match(/function ArchiveSection\([\s\S]*?\n\}/)?.[0] ?? ''
    expect(archiveFn).not.toContain('ReorderHandle')
    expect(archiveFn).not.toContain('cardOrder')
    expect(archiveFn).not.toContain('reorder=')
  })

  it('the Recovery plans section has no reorder wiring', () => {
    const recoveryFn = source.match(/function RecoveryPlansSection\([\s\S]*?\n\}/)?.[0] ?? ''
    expect(recoveryFn).not.toContain('ReorderHandle')
    expect(recoveryFn).not.toContain('cardOrder')
  })

  it('ArchivedTemplateCard and RecoveryTemplateCard component definitions take no reorder prop', () => {
    const archivedCardFn = source.match(/function ArchivedTemplateCard\([\s\S]*?\n\}\)/)?.[0] ?? ''
    const recoveryCardFn = source.match(/function RecoveryTemplateCard\([\s\S]*?\n\}\)/)?.[0] ?? ''
    expect(archivedCardFn).not.toContain('reorder')
    expect(recoveryCardFn).not.toContain('reorder')
  })

  it('wires drag-and-drop plus an up/down keyboard fallback through ReorderHandle', () => {
    const handleFn = source.match(/function ReorderHandle\([\s\S]*?\n}\n\nfunction TemplateCard/)?.[0] ?? ''
    expect(handleFn).toContain('draggable')
    expect(handleFn).toContain('onDragStart')
    expect(handleFn).toContain('onDragEnd')
    expect(handleFn).toContain('onMoveUp')
    expect(handleFn).toContain('onMoveDown')
    expect(handleFn).toContain('aria-label="Move up"')
    expect(handleFn).toContain('aria-label="Move down"')
  })

  it('the grip and step buttons stop click propagation so they never trigger onView', () => {
    const handleFn = source.match(/function ReorderHandle\([\s\S]*?\n}\n\nfunction TemplateCard/)?.[0] ?? ''
    const stops = handleFn.match(/e\.stopPropagation\(\)/g) ?? []
    expect(stops.length).toBeGreaterThanOrEqual(3)
  })

  it('drop reorders via moveBefore(draggedId, targetId), guarding a drop onto itself', () => {
    const dropMatch = source.match(/onDrop: \(e\) => \{[\s\S]*?\n {18}\},/)
    expect(dropMatch).not.toBeNull()
    const body = dropMatch?.[0] ?? ''
    expect(body).toContain('if (draggedId == null || draggedId === t.id) return')
    expect(body).toContain('cardOrder.moveBefore(draggedId, t.id)')
  })

  it('up/down buttons disable at the ends of the active grid via isFirst/isLast', () => {
    expect(source).toContain('disableUp={reorder.isFirst}')
    expect(source).toContain('disableDown={reorder.isLast}')
    expect(source).toContain('isFirst: cardOrder.isFirst(t.id)')
    expect(source).toContain('isLast: cardOrder.isLast(t.id)')
  })

  it('the dragged card is visually de-emphasized', () => {
    expect(source).toContain("reorder.dragging ? ' gym-tpl-card--dragging' : ''")
    expect(css).toMatch(/\.gym-tpl-card--dragging\s*\{[^}]*opacity:/s)
  })

  it('the handle is quiet by default and reveals on card hover / its own focus', () => {
    expect(css).toMatch(/\.reorder-handle\s*\{[^}]*opacity:\s*0/s)
    expect(css).toMatch(/\.gym-tpl-card:hover \.reorder-handle\s*\{[^}]*opacity:\s*1/s)
    expect(css).toMatch(/\.reorder-handle:focus-within\s*\{[^}]*opacity:\s*1/s)
  })
})
