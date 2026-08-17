import type { ReactElement } from 'react'
import type { InjuryLogEntry, RecoveryPlanItem, RecoveryPlanPhase } from '@shared/types'
import { formatRecoveryItemDose, formatRecoveryStepDose } from '../lib/recoveryPlan'
import { phaseEffectiveWeek, phaseGateStatus, resolveItemTargets } from '../lib/injuryStats'
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

/** "clean 8/14 d" · "eligible since Mar 12" · "flare Mar 20 — review" copy for
 *  a gated step's live state; null when no clock can be computed. */
function gateStatusText(
  phase: RecoveryPlanPhase,
  entries: InjuryLogEntry[] | undefined,
  todayYMD: string | undefined,
  planStartedAt: string | null
): { text: string; review: boolean } | null {
  if (!entries || !todayYMD) return null
  const status = phaseGateStatus(phase, entries, todayYMD, planStartedAt)
  if (status == null) return null
  if (status.state === 'applied') {
    return status.flareAfter
      ? { text: `flare ${status.flareAfter.slice(5)} — review`, review: true }
      : null
  }
  if (status.state === 'eligible') {
    return { text: `eligible since ${status.eligibleOn?.slice(5) ?? ''}`, review: false }
  }
  if (status.cleanDays == null) return null
  return { text: `clean ${status.cleanDays}/${status.clearDays} d`, review: false }
}

/**
 * The prescribed frequency, as a schedule rather than a sentence.
 *
 * A flat item has one frequency and shows just that. A ramped one ("3× in week
 * 1, then daily from week 2") renders one labelled row per step, so what's on
 * the card is visibly the prescription's own structure — week label plus dose —
 * instead of prose that reads like fixed copy. The step in force is marked;
 * later steps stay legible but recede. A symptom-gated step has no week until
 * it is applied: pending it renders under a "gate" marker with its condition
 * ("≤1/10 × 14 d") and live clock; applied it takes the week it started in,
 * and a flare above its gate after application surfaces a review flag — the
 * agreed reversion rule made visible.
 */
function FrequencySchedule({
  item,
  currentWeek,
  entries,
  todayYMD,
  planStartedAt = null
}: {
  item: RecoveryPlanItem
  currentWeek: number | null
  entries?: InjuryLogEntry[]
  todayYMD?: string
  planStartedAt?: string | null
}): ReactElement | null {
  const phases = item.phases ?? []
  const active = resolveItemTargets(item, currentWeek, planStartedAt)
  if (active.weekly_target == null) return null

  if (phases.length === 0) {
    return <span className="tabular-nums">{active.weekly_target}× / week</span>
  }

  interface ScheduleStep {
    key: string
    week: number
    phase: RecoveryPlanPhase | null
    target: number | null
  }
  const dated: ScheduleStep[] = [
    { key: 'base', week: item.start_week, phase: null, target: item.weekly_target },
    ...phases.flatMap((phase, index): ScheduleStep[] => {
      const week = phaseEffectiveWeek(phase, planStartedAt)
      return week == null
        ? []
        : [{ key: `phase-${index}`, week, phase, target: phase.weekly_target }]
    })
  ]
    .filter((step) => step.target != null)
    .sort((a, b) => a.week - b.week)
  const pending = phases
    .map((phase, index) => ({ key: `gate-${index}`, phase }))
    .filter(({ phase }) => phase.gate != null && !phase.applied_on)

  // The step in force is the last one that has started; with no plan start date
  // nothing has demonstrably begun, so none is marked current.
  const currentKey =
    currentWeek == null
      ? null
      : dated.reduce<string | null>(
          (found, step) => (step.week <= currentWeek ? step.key : found),
          null
        )

  return (
    <span className="recovery-detail-schedule" role="list" aria-label={`${item.name} frequency schedule`}>
      {dated.map((step) => {
        const isCurrent = step.key === currentKey
        const status = step.phase ? gateStatusText(step.phase, entries, todayYMD, planStartedAt) : null
        return (
          <span
            key={step.key}
            role="listitem"
            className={`recovery-detail-schedule-step${isCurrent ? ' recovery-detail-schedule-step--current' : ''}`}
          >
            <span className="recovery-detail-schedule-week tabular-nums">W{step.week}</span>
            <span className="recovery-detail-schedule-dose tabular-nums">
              {step.target}× / week
            </span>
            {status && (
              <span
                className={`recovery-detail-schedule-status${status.review ? ' recovery-detail-schedule-status--review' : ''}`}
              >
                {status.text}
              </span>
            )}
          </span>
        )
      })}
      {pending.map(({ key, phase }) => {
        const gate = phase.gate!
        const status = gateStatusText(phase, entries, todayYMD, planStartedAt)
        return (
          <span key={key} role="listitem" className="recovery-detail-schedule-step recovery-detail-schedule-step--gate">
            <span
              className="recovery-detail-schedule-week"
              title={gate.condition ?? undefined}
            >
              gate
            </span>
            <span className="recovery-detail-schedule-dose tabular-nums">
              {phase.weekly_target}× / week
            </span>
            <span className="recovery-detail-schedule-status">
              {`≤${gate.max_pain}/10 × ${gate.clear_days} d`}
              {status ? ` · ${status.text}` : ''}
            </span>
          </span>
        )
      })}
    </span>
  )
}

export function RecoveryPlanDetail({
  overview,
  items,
  statusFor,
  currentWeek,
  entries,
  todayYMD,
  planStartedAt = null,
  emptyText = 'No active plan items.'
}: {
  overview: string | null
  items: RecoveryPlanItem[]
  statusFor?: (item: RecoveryPlanItem) => string | null
  currentWeek?: number | null
  /** Injury log, for gated steps' live clean-day clocks; omit to render
   *  schedules without gate status. */
  entries?: InjuryLogEntry[]
  todayYMD?: string
  planStartedAt?: string | null
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
                    const itemDose = formatRecoveryItemDose(item)
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
                          <FrequencySchedule
                            item={item}
                            currentWeek={currentWeek ?? null}
                            entries={entries}
                            todayYMD={todayYMD}
                            planStartedAt={planStartedAt}
                          />
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
