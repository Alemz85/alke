// Shared Confirm/Discard/decision-state machinery for the two PROPOSAL blocks
// (alke:template, alke:recovery-plan). Both route through window.api's
// chatApplyProposal / chatSetBlockDecision — the shape of `request` is the
// only thing that differs between callers.
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { ChatBlockDecision, ChatProposalRequest, ChatProposalResult } from '@shared/types'
import type { ChatBlockMessageContext } from './chatBlockContext'

export const PROPOSAL_DISABLED_HINT = 'Available when the response finishes.'

export interface UseProposalDecisionOptions {
  blockId: string
  request: ChatProposalRequest
  streaming: boolean
  messageContext?: ChatBlockMessageContext
  /** Extra query-key prefixes to invalidate after a SUCCESSFUL apply (e.g. gym
   *  templates, injuries) — the chat session query is always invalidated. */
  invalidateOnApply?: QueryKey[]
}

export interface ProposalDecisionState {
  decision: ChatBlockDecision | null
  busy: boolean
  /** True when Confirm/Discard must be disabled: streaming, no persisted
   *  message context yet, a live generation running in this session, or an
   *  apply/discard call already in flight (main serializes; never double-fire). */
  disabled: boolean
  disabledHint: string | null
  confirm(): void
  discard(): void
}

export function useProposalDecision({
  blockId,
  request,
  streaming,
  messageContext,
  invalidateOnApply = []
}: UseProposalDecisionOptions): ProposalDecisionState {
  const queryClient = useQueryClient()
  const decision = messageContext?.blockDecisions?.[blockId] ?? null
  const gated = streaming || !messageContext || messageContext.generationActive === true

  const applyMutation = useMutation({
    mutationFn: async (): Promise<ChatProposalResult> => {
      if (!messageContext) throw new Error('chat block: no persisted message context')
      const result = await window.api.chatApplyProposal(request)
      const nextDecision: ChatBlockDecision = result.ok
        ? { status: 'applied', at: new Date().toISOString(), detail: result.output?.slice(-500) }
        : { status: 'failed', at: new Date().toISOString(), detail: result.error }
      await window.api.chatSetBlockDecision(
        messageContext.sessionId,
        messageContext.messageIndex,
        blockId,
        nextDecision
      )
      return result
    },
    onSuccess: (result) => {
      if (!messageContext) return
      queryClient.invalidateQueries({ queryKey: ['chat', 'session', messageContext.sessionId] })
      if (result.ok) {
        for (const queryKey of invalidateOnApply) queryClient.invalidateQueries({ queryKey })
      }
    }
  })

  const discardMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!messageContext) throw new Error('chat block: no persisted message context')
      const nextDecision: ChatBlockDecision = { status: 'discarded', at: new Date().toISOString() }
      await window.api.chatSetBlockDecision(
        messageContext.sessionId,
        messageContext.messageIndex,
        blockId,
        nextDecision
      )
    },
    onSuccess: () => {
      if (!messageContext) return
      queryClient.invalidateQueries({ queryKey: ['chat', 'session', messageContext.sessionId] })
    }
  })

  const busy = applyMutation.isPending || discardMutation.isPending
  const disabled = gated || busy

  return {
    decision,
    busy,
    disabled,
    disabledHint: gated && !busy ? PROPOSAL_DISABLED_HINT : null,
    confirm: () => {
      if (disabled) return
      applyMutation.mutate()
    },
    discard: () => {
      if (disabled) return
      discardMutation.mutate()
    }
  }
}
