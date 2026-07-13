import type { ReactElement } from 'react'
import type { RecoveryPlanItem } from '@shared/types'
import { formatRecoveryDose, formatRecoveryStepDose } from '../lib/recoveryPlan'
import './RecoveryPlanDetail.css'

const GUIDANCE_LABEL: Record<Exclude<RecoveryPlanItem['kind'], 'exercise'>, string> = {
  activity: 'Allowed activity', habit: 'Habit', constraint: 'Constraint'
}

export function RecoveryRoutineTable({ item }: { item: RecoveryPlanItem }): ReactElement | null {
  if (!item.steps || item.steps.length === 0) return null
  return (
    <div className="recovery-detail-steps" role="table" aria-label={`${item.name} routine`}>
      <div className="recovery-detail-step recovery-detail-step--head" role="row">
        <span role="columnheader">Movement</span><span role="columnheader">Dose</span>
      </div>
      {item.steps.map((step, stepIndex) => (
        <div className="recovery-detail-step" role="row" key={`${step.name}-${stepIndex}`}>
          <span role="cell"><strong>{step.name}</strong>{step.note && <small>{step.note}</small>}</span>
          <span role="cell" className="tabular-nums">{formatRecoveryStepDose(step)}</span>
        </div>
      ))}
    </div>
  )
}

export function RecoveryPlanDetail({
  overview,
  items,
  statusFor,
  currentWeek,
  emptyText = 'No active plan items.'
}: {
  overview: string | null
  items: RecoveryPlanItem[]
  statusFor?: (item: RecoveryPlanItem) => string | null
  currentWeek?: number | null
  emptyText?: string
}): ReactElement {
  const active = items.filter((item) => item.active)
  const exercises = active
    .filter((item) => item.kind === 'exercise')
    .sort((a, b) => a.start_week - b.start_week)
  const guidance = active
    .filter((item) => item.kind !== 'exercise')
    .sort((a, b) => a.start_week - b.start_week)
  const exercisePhases = Map.groupBy(exercises, (item) => item.start_week)
  const guidancePhases = Map.groupBy(guidance, (item) => item.start_week)

  const phaseStatus = (week: number): string | null => {
    if (currentWeek == null || currentWeek <= 0) return null
    if (week === currentWeek) return 'Current phase'
    if (week > currentWeek) return 'Starts later'
    return 'In progress'
  }
  if (active.length === 0) return <p className="recovery-detail-empty">{emptyText}</p>

  return (
    <div className="recovery-detail">
      <section className="recovery-detail-main" aria-labelledby="recovery-detail-exercises">
        <div className="recovery-detail-heading">
          <div><span className="recovery-detail-eyebrow">Plan structure</span><h4 id="recovery-detail-exercises">Exercises</h4></div>
          <span>{exercises.length} prescribed</span>
        </div>
        {exercises.length === 0 ? <p className="recovery-detail-empty">No active rehab exercises.</p> : (
          <div className="recovery-detail-phases">
            {[...exercisePhases.entries()].map(([week, phaseItems]) => (
              <section className="recovery-detail-phase" key={week} aria-label={`Week ${week} exercises`}>
                <div className="recovery-detail-phase-head">
                  <strong>Week {week}</strong>
                  {phaseStatus(week) && <span>{phaseStatus(week)}</span>}
                </div>
                <ol className="recovery-detail-list">
                  {phaseItems.map((item, index) => {
                    const itemDose = formatRecoveryDose(item.target_sets, item.target_reps)
                    return (
                      <li key={item.id} className="recovery-detail-row">
                        <span className="recovery-detail-index tabular-nums">{index + 1}</span>
                        <div className="recovery-detail-copy">
                          <strong className="recovery-detail-name">{item.name}</strong>
                          {itemDose && <span className="recovery-detail-dose tabular-nums">{itemDose}</span>}
                          {item.note && <p className="recovery-detail-note">{item.note}</p>}
                          <RecoveryRoutineTable item={item} />
                        </div>
                        <span className="recovery-detail-prescription">
                          {statusFor?.(item) && <span>{statusFor(item)}</span>}
                          {item.weekly_target != null && <span className="tabular-nums">{item.weekly_target}× / week</span>}
                        </span>
                      </li>
                    )
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
      </section>
      {overview && <section className="recovery-detail-overview"><span className="recovery-detail-eyebrow">Plan overview</span><p>{overview}</p></section>}
      {guidance.length > 0 && <section className="recovery-detail-guidance"><span className="recovery-detail-eyebrow">Guidance</span><ul>
          {[...guidancePhases.entries()].flatMap(([week, phaseItems]) => phaseItems.map((item) => <li key={item.id}><span className="recovery-detail-kind">Week {week} · {GUIDANCE_LABEL[item.kind as Exclude<RecoveryPlanItem['kind'], 'exercise'>]}</span><strong>{item.name}</strong>{item.note && <p>{item.note}</p>}{statusFor?.(item) && <small>{statusFor(item)}</small>}</li>))}
        </ul></section>}
    </div>
  )
}
