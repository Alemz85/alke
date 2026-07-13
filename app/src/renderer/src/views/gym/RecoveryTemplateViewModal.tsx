import { useEffect, type ReactElement } from 'react'
import type { RecoveryLogTemplate } from '../../lib/recoveryLogTemplates'
import { RecoveryPlanDetail } from '../../components/RecoveryPlanDetail'
import '../GymView.css'

export function RecoveryTemplateViewModal({
  template,
  onUse,
  onClose
}: {
  template: RecoveryLogTemplate
  onUse: () => void
  onClose: () => void
}): ReactElement {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="gym-modal-overlay" onClick={onClose}>
      <div
        className="gym-modal gym-modal--recovery"
        role="dialog"
        aria-modal="true"
        aria-label={`Recovery template ${template.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gym-modal-head">
          <div>
            <span className="gym-field-label">Recovery template</span>
            <h3 className="gym-modal-title gym-rpv-title">{template.name}</h3>
          </div>
          <div className="gym-tv-head-actions">
            <button
              type="button"
              className="gym-btn gym-btn--primary"
              disabled={template.rows.length === 0}
              onClick={onUse}
            >
              Use in log
            </button>
            <button type="button" className="gym-modal-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        <div className="gym-modal-body">
          <div className="gym-tv-meta">
            <span className="gym-tv-chip">
              {template.exerciseItems.length - template.unlinkedExerciseCount} ready
            </span>
            <span className="gym-tv-chip">{template.exerciseItems.length} exercise steps</span>
            <span className="gym-tv-chip">{template.guidance.length} guidance steps</span>
          </div>

          <RecoveryPlanDetail
            overview={template.summary}
            items={[...template.exerciseItems, ...template.guidance]}
            statusFor={(item) => item.kind === 'exercise'
              ? item.exercise_id
                ? 'Ready for Gym log'
                : item.steps && item.steps.length > 0
                  ? 'Structured routine'
                  : 'Needs catalog link'
              : null}
          />
        </div>
      </div>
    </div>
  )
}
