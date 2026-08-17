// Shared chrome for rich blocks: a fixed-height shimmer skeleton (rendered
// while a fence's JSON may still be mid-stream, or while a fully-parsed
// block is fetching its data) and a quiet inline error chip (fetch failure /
// unknown id) — used by all four block types instead of ever throwing.
import type { ReactElement } from 'react'
import './ChatBlocks.css'

export function BlockSkeleton({ label = 'Preparing…' }: { label?: string }): ReactElement {
  return (
    <div className="chat-block chat-block--skeleton" role="status" aria-label={label}>
      <span className="chat-block-skeleton-line" />
      <span className="chat-block-skeleton-line chat-block-skeleton-line--short" />
    </div>
  )
}

export function BlockErrorChip({ message }: { message: string }): ReactElement {
  return (
    <div className="chat-block-error-chip" role="status">
      {message}
    </div>
  )
}
