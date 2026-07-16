import { describe, expect, it } from 'vitest'
import { moveBefore, moveByOffset, reconcileOrder } from '../useCardOrder'

describe('reconcileOrder', () => {
  it('keeps the saved order when the id set is unchanged', () => {
    expect(reconcileOrder(['b', 'a', 'c'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
  })

  it('prunes saved ids that no longer exist', () => {
    expect(reconcileOrder(['b', 'a', 'c'], ['a', 'c'])).toEqual(['a', 'c'])
  })

  it('appends new ids at the end in their natural order', () => {
    expect(reconcileOrder(['b', 'a'], ['a', 'b', 'c', 'd'])).toEqual(['b', 'a', 'c', 'd'])
  })

  it('handles an empty saved order by falling back to natural order', () => {
    expect(reconcileOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('handles all ids being removed', () => {
    expect(reconcileOrder(['a', 'b'], [])).toEqual([])
  })

  it('prunes and appends in the same pass', () => {
    // 'x' was saved but is gone; 'c' is new and should land at the end.
    expect(reconcileOrder(['x', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('is stable across repeated calls with the same inputs', () => {
    const first = reconcileOrder(['b', 'a'], ['a', 'b', 'c'])
    const second = reconcileOrder(first, ['a', 'b', 'c'])
    expect(second).toEqual(first)
  })
})

describe('moveBefore', () => {
  it('moves an item earlier in the list', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves an item later in the list', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], 'a', 'd')).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moving an item before itself is a no-op', () => {
    const order = ['a', 'b', 'c']
    expect(moveBefore(order, 'b', 'b')).toBe(order)
  })

  it('is a no-op when the dragged id is unknown', () => {
    const order = ['a', 'b', 'c']
    expect(moveBefore(order, 'z', 'b')).toBe(order)
  })

  it('is a no-op when the target id is unknown', () => {
    const order = ['a', 'b', 'c']
    expect(moveBefore(order, 'a', 'z')).toBe(order)
  })

  it('moving to the position right after itself is a no-op net of order', () => {
    expect(moveBefore(['a', 'b', 'c'], 'a', 'b')).toEqual(['a', 'b', 'c'])
  })
})

describe('moveByOffset', () => {
  it('moves an item up one slot', () => {
    expect(moveByOffset(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
  })

  it('moves an item down one slot', () => {
    expect(moveByOffset(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c'])
  })

  it('clamps at the top: moving the first item up is a no-op', () => {
    const order = ['a', 'b', 'c']
    expect(moveByOffset(order, 'a', -1)).toBe(order)
  })

  it('clamps at the bottom: moving the last item down is a no-op', () => {
    const order = ['a', 'b', 'c']
    expect(moveByOffset(order, 'c', 1)).toBe(order)
  })

  it('is a no-op for an unknown id', () => {
    const order = ['a', 'b', 'c']
    expect(moveByOffset(order, 'z', 1)).toBe(order)
  })

  it('round-trips: moving up then down returns to the original order', () => {
    const order = ['a', 'b', 'c', 'd']
    const up = moveByOffset(order, 'c', -1)
    const back = moveByOffset(up, 'c', 1)
    expect(back).toEqual(order)
  })
})
