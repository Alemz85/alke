import type { ReactElement } from 'react'
import { Timer } from 'lucide-react'
import type { ChatProposalRequest } from '@shared/types'
import type { TemplateBlockPayload, TemplateExercisePayload } from './chatBlockParse'
import type { ChatBlockMessageContext } from './chatBlockContext'
import { formatRest } from '../../../lib/gymLog'
import { useProposalDecision } from './useProposalDecision'
import { ProposalActions } from './ProposalActions'
import './ChatBlocks.css'

/** "3×8" for reps, "3×45s" for a timed hold, "3×—" when neither is set —
 *  mirrors views/gym/gymFormat.ts's formatTemplateDose idiom, adapted to the
 *  untrusted alke:template exercise payload (sets/reps/secs, not a DB row). */
function formatExerciseDose(exercise: TemplateExercisePayload): string {
  const dose = exercise.reps != null ? String(exercise.reps) : exercise.secs != null ? formatRest(exercise.secs) : '—'
  return `${exercise.sets}×${dose}`
}

const CONFIRM_LABEL: Record<TemplateBlockPayload['action'], string> = {
  apply: 'Apply to Gym',
  'create-version': 'Save as new version'
}

export function TemplateProposalBlock({
  payload,
  streaming,
  messageContext
}: {
  payload: TemplateBlockPayload
  streaming: boolean
  messageContext?: ChatBlockMessageContext
}): ReactElement {
  // Main rejects a baseTemplateId on 'apply' — drop a stray one at the source
  // so an agent slip degrades to nothing instead of a confusing Confirm error.
  const request: ChatProposalRequest = {
    kind: 'gym-template',
    action: payload.action,
    ...(payload.action === 'create-version'
      ? { baseTemplateId: payload.base_template_id }
      : {}),
    document: payload.document
  }

  const decisionState = useProposalDecision({
    blockId: payload.id,
    request,
    streaming,
    messageContext,
    invalidateOnApply: [
      ['health', 'gym', 'templates'],
      ['health', 'gym', 'templateVersions']
    ]
  })

  return (
    <div className="chat-block chat-block--proposal chat-block--template">
      {payload.document.templates.map((template, templateIndex) => (
        <section className="chat-block-template" key={`${payload.id}-${templateIndex}`}>
          <div className="chat-block-template-head">
            <h4 className="chat-block-template-name">{template.name}</h4>
            {template.default_rest_s != null && (
              <span className="chat-block-chip">
                <Timer size={12} strokeWidth={2} aria-hidden="true" />
                Rest {formatRest(template.default_rest_s)}
              </span>
            )}
          </div>
          {template.notes && <p className="chat-block-template-notes">{template.notes}</p>}

          <ol className="chat-block-exercise-list">
            {template.exercises.map((exercise, exerciseIndex) => (
              <li className="chat-block-exercise-row" key={exerciseIndex}>
                <span className="chat-block-exercise-index tabular-nums">{exerciseIndex + 1}</span>
                <span className="chat-block-exercise-main">
                  <span className="chat-block-exercise-name">{exercise.exercise}</span>
                  {exercise.note && <span className="chat-block-exercise-note">{exercise.note}</span>}
                </span>
                <span className="chat-block-exercise-dose tabular-nums">
                  {formatExerciseDose(exercise)}
                  {exercise.kg != null && <span className="chat-block-exercise-kg"> · {exercise.kg} kg</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}

      <ProposalActions state={decisionState} confirmLabel={CONFIRM_LABEL[payload.action]} />
    </div>
  )
}
