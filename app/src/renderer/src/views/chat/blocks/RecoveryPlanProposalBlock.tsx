import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ChatProposalRequest, Injury } from '@shared/types'
import type { RecoveryPlanBlockPayload, RecoveryPlanItemPayload } from './chatBlockParse'
import type { ChatBlockMessageContext, ChatBlockNav } from './chatBlockContext'
import { useProposalDecision } from './useProposalDecision'
import { ProposalActions } from './ProposalActions'
import { BlockErrorChip, BlockSkeleton } from './BlockChrome'
import './ChatBlocks.css'

/** "3 × 12" / "3 sets" / "12 reps" — the untrusted-payload counterpart of
 *  lib/recoveryPlan.ts's formatRecoveryDose (that one types against the DB's
 *  RecoveryPlanItem; this payload has no id/injury_id/steps typing yet). */
function formatItemDose(item: RecoveryPlanItemPayload): string | null {
  if (item.target_sets != null && item.target_reps != null) return `${item.target_sets} × ${item.target_reps}`
  if (item.target_sets != null) return `${item.target_sets} sets`
  if (item.target_reps != null) return `${item.target_reps} reps`
  return null
}

/** "target 3/wk · green ≥3 · yellow ≥2" — only the pieces the model set. */
function formatTargetLine(item: RecoveryPlanItemPayload): string | null {
  const parts: string[] = []
  if (item.weekly_target != null) parts.push(`target ${item.weekly_target}/wk`)
  if (item.green_min != null) parts.push(`green ≥${item.green_min}`)
  if (item.yellow_min != null) parts.push(`yellow ≥${item.yellow_min}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function RecoveryItemRow({ item }: { item: RecoveryPlanItemPayload }): ReactElement {
  const dose = formatItemDose(item)
  const targetLine = formatTargetLine(item)
  return (
    <li className="chat-block-recovery-item">
      <div className="chat-block-recovery-item-main">
        <span className="chat-block-recovery-item-name">{item.name}</span>
        {item.start_week != null && item.start_week > 1 && (
          <span className="chat-block-chip chat-block-chip--week">Week {item.start_week}</span>
        )}
        {item.note && <span className="chat-block-exercise-note">{item.note}</span>}
      </div>
      <div className="chat-block-recovery-item-dose tabular-nums">
        {dose && <span>{dose}</span>}
        {targetLine && <span className="chat-block-recovery-item-target">{targetLine}</span>}
      </div>
    </li>
  )
}

export function RecoveryPlanProposalBlock({
  payload,
  streaming,
  messageContext,
  nav
}: {
  payload: RecoveryPlanBlockPayload
  streaming: boolean
  messageContext?: ChatBlockMessageContext
  nav: ChatBlockNav
}): ReactElement {
  const injuriesQuery = useQuery<Injury[]>({
    queryKey: ['health', 'injuries'],
    queryFn: () => window.api.getInjuries(),
    staleTime: 60_000
  })

  const request: ChatProposalRequest = {
    kind: 'recovery-plan',
    injuryId: payload.injury_id,
    document: payload.document
  }

  const decisionState = useProposalDecision({
    blockId: payload.id,
    request,
    streaming,
    messageContext,
    invalidateOnApply: [['injuries'], ['health', 'injuries']]
  })

  if (injuriesQuery.isLoading) return <BlockSkeleton label="Loading recovery plan…" />
  if (injuriesQuery.isError) return <BlockErrorChip message="Couldn't load that recovery plan" />

  const injury = (injuriesQuery.data ?? []).find((candidate) => candidate.id === payload.injury_id)
  if (!injury) return <BlockErrorChip message="Couldn't find that injury" />

  const exerciseItems = payload.document.items.filter((item) => item.kind !== 'constraint')
  const constraintItems = payload.document.items.filter((item) => item.kind === 'constraint')

  return (
    <div className="chat-block chat-block--proposal chat-block--recovery-plan">
      <h4 className="chat-block-recovery-title">Recovery plan — {injury.name}</h4>
      <p className="chat-block-recovery-approach">{payload.document.approach}</p>

      {exerciseItems.length > 0 && (
        <ul className="chat-block-recovery-list">
          {exerciseItems.map((item, index) => (
            <RecoveryItemRow key={index} item={item} />
          ))}
        </ul>
      )}

      {constraintItems.length > 0 && (
        <div className="chat-block-recovery-avoid">
          <span className="chat-block-recovery-avoid-label">Avoid</span>
          <ul className="chat-block-recovery-list chat-block-recovery-list--constraints">
            {constraintItems.map((item, index) => (
              <li key={index} className="chat-block-recovery-item chat-block-recovery-item--constraint">
                <div className="chat-block-recovery-item-main">
                  <span className="chat-block-recovery-item-name">{item.name}</span>
                  {item.note && <span className="chat-block-exercise-note">{item.note}</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ProposalActions state={decisionState} confirmLabel="Apply to recovery plan" />

      {nav.onOpenInjuries && (
        <button type="button" className="chat-block-footer-link" onClick={nav.onOpenInjuries}>
          View in Injuries →
        </button>
      )}
    </div>
  )
}
