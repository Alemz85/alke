// Context threaded from ChatView down into every rich block: navigation
// callbacks (all optional — every view degrades gracefully without them) and,
// for proposal blocks, where to persist a Confirm/Discard decision.
import type { ChatBlockDecision } from '@shared/types'

export interface ChatBlockNav {
  onOpenSessions?: (activity?: string) => void
  onOpenGymTemplates?: () => void
  onOpenInjuries?: () => void
}

/**
 * Present only for blocks embedded in a PERSISTED assistant message
 * (MessageTurn) — a live-streaming runtime turn has no session row / message
 * index yet to write a decision onto, so RuntimeTurn omits this entirely.
 */
export interface ChatBlockMessageContext {
  sessionId: string
  messageIndex: number
  blockDecisions?: Record<string, ChatBlockDecision>
  /** True when a NEW chat generation is running in this same session right
   *  now — main serializes chatApplyProposal per session, so proposal actions
   *  on older messages stay disabled until it finishes. */
  generationActive: boolean
}
