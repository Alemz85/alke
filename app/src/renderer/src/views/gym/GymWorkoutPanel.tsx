import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ChevronDown, Pencil } from 'lucide-react'
import type { Exercise, GymSession, GymTemplate } from '@shared/types'
import { BadgeDomain } from '../../components/BadgeDomain'
import { ModalityIcon } from '../../components/ModalityIcon'
import {
  displayBodyPart,
  formatExerciseSetSummary,
  groupExerciseBlocksByBodyPart,
  groupSetsIntoBlocks,
  type ExerciseBlock,
  sessionBodyParts
} from '../../lib/gymLog'
import type { RecoveryLogTemplate } from '../../lib/recoveryLogTemplates'
import { SessionEditorModal, type EditorTarget } from './SessionEditorModal'
import type { GymSessionItem } from './gymSessionItem'

function sessionTitle(session: GymSession, templateNameById: Map<string, string>): string {
  if (session.title) return session.title
  const firstTemplate = session.template_ids[0]
  return (firstTemplate ? templateNameById.get(firstTemplate) : null) ?? 'Gym session'
}

export function ExerciseDisclosure({
  block,
  blockKey,
  muscleGroup,
  expanded,
  onToggle
}: {
  block: ExerciseBlock
  blockKey: string
  muscleGroup: string | null
  expanded: boolean
  onToggle: () => void
}): ReactElement {
  return (
    <div className={expanded ? 'gym-log-exercise gym-log-exercise--expanded' : 'gym-log-exercise'}>
      <button
        type="button"
        className="gym-log-exercise-toggle"
        aria-expanded={expanded}
        aria-controls={`gym-log-sets-${blockKey}`}
        onClick={onToggle}
      >
        <span className="gym-log-exercise-name">{block.exerciseName}</span>
        <span className="gym-log-exercise-summary tabular-nums">
          {formatExerciseSetSummary(block.sets)}
        </span>
        <ChevronDown
          className="gym-log-exercise-chevron"
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div id={`gym-log-sets-${blockKey}`} className="gym-log-set-table">
          <div className="gym-log-set-row gym-log-set-row--head">
            <span>Set</span>
            <span>Reps</span>
            <span>Load</span>
            <span>RPE</span>
            <span>Muscle group</span>
          </div>
          {block.sets.map((set, index) => (
            <div key={set.id} className="gym-log-set-row">
              <span className="tabular-nums">{index + 1}</span>
              <span className="tabular-nums">{set.reps ?? '—'}</span>
              <span className="tabular-nums">
                {set.weight_kg == null ? 'BW' : `${set.weight_kg} kg`}
              </span>
              <span className="tabular-nums">{set.rpe ?? '—'}</span>
              <span>{muscleGroup ? displayBodyPart(muscleGroup) : '—'}</span>
              {set.note && <span className="gym-log-set-note">{set.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GymSessionReadView({
  session,
  exercisesById,
  templateNameById,
  standalone,
  onEdit
}: {
  session: GymSession
  exercisesById: Map<string, Exercise>
  templateNameById: Map<string, string>
  standalone: boolean
  onEdit: () => void
}): ReactElement {
  const blocks = useMemo(() => groupSetsIntoBlocks(session.sets), [session.sets])
  const exerciseGroups = useMemo(
    () => groupExerciseBlocksByBodyPart(blocks, exercisesById),
    [blocks, exercisesById]
  )
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => new Set())
  const bodyParts = sessionBodyParts(session, exercisesById)
  const appliedTemplates = session.template_ids.flatMap((id) => {
    const name = templateNameById.get(id)
    return name ? [name] : []
  })

  return (
    <section
      className={standalone ? 'gym-log-view day-drawer-session' : 'gym-log-view'}
      aria-label="Logged workout exercises"
    >
      {standalone && (
        <div className="day-drawer-session-header">
          <div className="day-drawer-session-header-badge">
            <ModalityIcon type="Traditional Strength Training" size={16} />
            <BadgeDomain domain="load" label="Gym" />
          </div>
        </div>
      )}
      <div className="gym-log-view-toolbar">
        <div className="gym-log-view-heading">
          <span className="gym-log-view-eyebrow">Workout log</span>
          <h3 className="gym-log-view-title">{sessionTitle(session, templateNameById)}</h3>
        </div>
        <button type="button" className="gym-btn gym-log-edit-button" onClick={onEdit}>
          <Pencil size={14} strokeWidth={1.75} />
          Edit log
        </button>
      </div>

      {(bodyParts.length > 0 || appliedTemplates.length > 0) && (
        <div className="gym-log-view-chips">
          {bodyParts.map((part) => (
            <span key={part} className="gym-bodypart-chip gym-bodypart-chip--derived">
              {displayBodyPart(part)}
            </span>
          ))}
          {appliedTemplates.map((name) => (
            <span key={name} className="gym-template-chip">
              {name}
            </span>
          ))}
        </div>
      )}

      <div className="gym-log-view-section-head">
        <span className="gym-log-view-section-label">Exercises</span>
        <span className="gym-log-view-count tabular-nums">
          {session.sets.filter((set) => !set.is_warmup).length} working sets
        </span>
      </div>

      {blocks.length === 0 ? (
        <p className="gym-quicklog-hint">Quick log only. No exercise sets were recorded.</p>
      ) : (
        <div className="gym-log-exercises">
          {exerciseGroups.map((group) => (
            <section key={group.bodyPart} className="gym-log-muscle-group">
              <h5 className="gym-log-muscle-group-title">{displayBodyPart(group.bodyPart)}</h5>
              <div className="gym-log-muscle-group-list">
                {group.blocks.map((block, blockIndex) => {
                  const blockKey = `${group.bodyPart}-${block.exerciseId}-${blockIndex}`
                  return (
                    <ExerciseDisclosure
                      key={blockKey}
                      block={block}
                      blockKey={blockKey}
                      muscleGroup={group.bodyPart === 'other' ? null : group.bodyPart}
                      expanded={expandedBlocks.has(blockKey)}
                      onToggle={() =>
                        setExpandedBlocks((current) => {
                          const next = new Set(current)
                          if (next.has(blockKey)) next.delete(blockKey)
                          else next.add(blockKey)
                          return next
                        })
                      }
                    />
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {session.notes && (
        <div className="gym-log-notes">
          <span className="gym-log-notes-label">Notes</span>
          <p>{session.notes}</p>
        </div>
      )}
    </section>
  )
}

export function GymWorkoutPanel({
  item,
  templates,
  recoveryTemplates,
  sessions,
  exercisesById,
  templateNameById,
  timezone,
  onClose,
  initialRecoveryTemplateId
}: {
  item: GymSessionItem
  templates: GymTemplate[]
  recoveryTemplates: RecoveryLogTemplate[]
  sessions: GymSession[]
  exercisesById: Map<string, Exercise>
  templateNameById: Map<string, string>
  timezone: string | null | undefined
  onClose: () => void
  initialRecoveryTemplateId?: string
}): ReactElement {
  const [editing, setEditing] = useState(item.session == null)

  useEffect(() => {
    setEditing(item.session == null)
  }, [item.key, item.session?.id])

  if (item.session && !editing) {
    return (
      <GymSessionReadView
        session={item.session}
        exercisesById={exercisesById}
        templateNameById={templateNameById}
        standalone={item.workout == null}
        onEdit={() => setEditing(true)}
      />
    )
  }

  const target: EditorTarget = item.session
    ? { kind: 'edit', session: item.session }
    : item.workout
      ? {
          kind: 'new-linked',
          workout: item.workout,
          recoveryTemplateId: initialRecoveryTemplateId
        }
      : { kind: 'new-unlinked', recoveryTemplateId: initialRecoveryTemplateId }

  return (
    <SessionEditorModal
      embedded
      target={target}
      templates={templates}
      recoveryTemplates={recoveryTemplates}
      sessions={sessions}
      timezone={timezone}
      onClose={item.session ? () => setEditing(false) : onClose}
      onSaved={() => {
        if (!item.workout && !item.session) onClose()
        else setEditing(false)
      }}
    />
  )
}
