type MutationErrorListener = (message: string) => void

const listeners = new Set<MutationErrorListener>()

export function publishMutationError(message: string): void {
  for (const listener of listeners) listener(message)
}

export function subscribeMutationErrors(listener: MutationErrorListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
