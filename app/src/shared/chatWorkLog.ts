import type { ChatWorkLogEntry } from './types'

/**
 * Size contract for a chat runtime's work log.
 *
 * Main persists the log and the renderer folds the same envelopes into its own
 * copy, so both sides have to trim by the identical rule — a bound applied on
 * one side only makes a reattach replace the log the user is reading. Kept
 * free of node built-ins (TextEncoder, not Buffer) so the renderer bundle can
 * import it.
 */

export const MAX_CHAT_WORK_ENTRIES = 200
export const MAX_CHAT_WORK_LOG_BYTES = 256 * 1024
export const MAX_CHAT_WORK_LABEL_BYTES = 512
export const MAX_CHAT_WORK_DETAIL_BYTES = 2 * 1024

const ENCODER = new TextEncoder()

export function utf8Length(value: string): number {
  return ENCODER.encode(value).length
}

/** Trim by entry count first, then by serialized size — oldest entries out. */
export function boundWorkLog(entries: ChatWorkLogEntry[]): ChatWorkLogEntry[] {
  const bounded = entries.slice(-MAX_CHAT_WORK_ENTRIES)
  while (bounded.length > 0 && utf8Length(JSON.stringify(bounded)) > MAX_CHAT_WORK_LOG_BYTES) {
    bounded.shift()
  }
  return bounded
}
