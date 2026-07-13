import { describe, expect, it, vi } from 'vitest'
import { publishMutationError, subscribeMutationErrors } from '../mutationFeedback'

describe('mutation feedback', () => {
  it('delivers one contextual message to current subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeMutationErrors(listener)

    publishMutationError('Could not save the session.')

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith('Could not save the session.')
    unsubscribe()
    publishMutationError('ignored')
    expect(listener).toHaveBeenCalledOnce()
  })
})
