import type { ReactElement } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ProposalDecisionState } from './useProposalDecision'
import './ChatBlocks.css'

const DECISION_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
})

function formatDecisionTime(iso: string): string {
  return DECISION_TIME_FORMATTER.format(new Date(iso))
}

/**
 * Confirm/Discard row shared by both proposal blocks, plus the three resolved
 * states: applied (chip + timestamp, buttons gone), discarded (chip, buttons
 * gone), failed (chip + detail, but Confirm stays — relabeled Retry).
 */
export function ProposalActions({
  state,
  confirmLabel
}: {
  state: ProposalDecisionState
  confirmLabel: string
}): ReactElement {
  const { decision, busy, disabled, disabledHint, confirm, discard } = state

  if (decision?.status === 'applied') {
    return (
      <div className="chat-block-decision chat-block-decision--applied">
        <span className="chat-block-decision-chip">Applied · {formatDecisionTime(decision.at)}</span>
        {decision.detail && <p className="chat-block-decision-detail">{decision.detail}</p>}
      </div>
    )
  }

  if (decision?.status === 'discarded') {
    return (
      <div className="chat-block-decision chat-block-decision--discarded">
        <span className="chat-block-decision-chip">Discarded</span>
      </div>
    )
  }

  const failed = decision?.status === 'failed'

  return (
    <div className="chat-block-actions">
      {failed && (
        <div className="chat-block-decision chat-block-decision--failed">
          <span className="chat-block-decision-chip">Failed</span>
          {decision.detail && <p className="chat-block-decision-detail">{decision.detail}</p>}
        </div>
      )}
      <div className="chat-block-actions-row">
        <button type="button" className="chat-block-confirm" disabled={disabled} onClick={confirm}>
          {failed && <RotateCcw size={13} strokeWidth={1.8} aria-hidden="true" />}
          {busy ? (failed ? 'Retrying…' : 'Applying…') : failed ? 'Retry' : confirmLabel}
        </button>
        <button type="button" className="chat-block-discard" disabled={disabled} onClick={discard}>
          Discard
        </button>
      </div>
      {disabledHint && <p className="chat-block-actions-hint">{disabledHint}</p>}
    </div>
  )
}
