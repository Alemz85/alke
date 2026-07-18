// Compact Goals strip for the Dashboard — one metric card per ACTIVE goal,
// reusing the exact ['goals'] query key + per-goal ['goal-progress', id]
// fetches ProfileView uses (shared cache, no extra network) and the same
// metricProgress/timeProgress derivations so the "current vs target" framing
// is identical to Profile's cards. This is a summary strip, not the Profile
// deep-dive: no sparkline, no actions, no status controls — just enough to
// glance at and a click through to Profile for the rest.
import { type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Goal } from '@shared/types'
import { metricProgress, timeProgress } from '../lib/profileStats'
import './GoalStrip.css'

export interface GoalStripProps {
  /** Deep-link to the Profile tab (mirrors App.tsx's onOpenSessions pattern). */
  onOpenProfile: () => void
}

/** One goal's compact metric readout + thin progress bar. Mirrors ProfileView's
 *  GoalMetricBlock framing (latest value, baseline → target, direction-aware
 *  delta, % bar) but removes verbose metric metadata — no chart, no build-metric
 *  action (that stays a Profile-only affordance). */
function GoalStripMetric({ goal }: { goal: Goal }): ReactElement {
  const progressQuery = useQuery({
    queryKey: ['goal-progress', goal.id],
    queryFn: () => window.api.getGoalProgress(goal.id),
    staleTime: 60_000,
    enabled: goal.metric_sql != null
  })

  if (goal.metric_sql == null) {
    return <p className="goal-strip-empty">No progress metric yet — metric building…</p>
  }

  const points = progressQuery.data ?? []
  const { latest, delta, pctToTarget } = metricProgress(goal, points)

  let deltaClass = 'goal-strip-delta--neutral'
  if (delta != null && goal.metric_direction != null && delta !== 0) {
    const improving = goal.metric_direction === 'up' ? delta > 0 : delta < 0
    deltaClass = improving ? 'goal-strip-delta--improving' : 'goal-strip-delta--regressing'
  }

  return (
    <>
      <div className="goal-strip-metric-row">
        {latest != null && (
          <span
            className="goal-strip-metric-value tabular-nums"
            aria-label={`${latest.toLocaleString()}${goal.metric_unit ? ` ${goal.metric_unit}` : ''}`}
          >
            <span className="goal-strip-metric-number">{latest.toLocaleString()}</span>
            {goal.metric_unit && <span className="goal-strip-metric-unit">{goal.metric_unit}</span>}
          </span>
        )}
      </div>

      {goal.metric_target != null && (
        <div className="goal-strip-footer">
          <div className="goal-strip-metric-range tabular-nums">
            {'Target '}
            {goal.metric_target.toLocaleString()}
          </div>
          {delta != null && (
            <span
              className={`goal-strip-delta ${deltaClass} tabular-nums`}
              aria-label={`${delta >= 0 ? '+' : ''}${delta.toLocaleString()} vs start`}
            >
              {delta >= 0 ? '+' : ''}
              {delta.toLocaleString()}
            </span>
          )}
          {pctToTarget != null && (
            <span className="goal-strip-progress-value tabular-nums">{pctToTarget}%</span>
          )}
        </div>
      )}

      {pctToTarget != null ? (
        <div
          className="goal-strip-bar"
          role="progressbar"
          aria-valuenow={pctToTarget}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="goal-strip-bar-fill" style={{ width: `${pctToTarget}%` }} />
        </div>
      ) : (
        !progressQuery.isLoading &&
        points.length === 0 && <p className="goal-strip-empty">Metric building…</p>
      )}
    </>
  )
}

function GoalStripCard({ goal, now, onOpen }: { goal: Goal; now: Date; onOpen: () => void }): ReactElement {
  const tp = timeProgress(goal, now)
  return (
    <button type="button" className="goal-strip-card" onClick={onOpen}>
      <div className="goal-strip-head">
        <h3 className="goal-strip-title">{goal.title}</h3>
        {goal.duration_days != null && tp.pct != null && (
          <span className="goal-strip-day tabular-nums">
            day {Math.min(tp.elapsedDays + 1, goal.duration_days)} of {goal.duration_days}
          </span>
        )}
      </div>
      <GoalStripMetric goal={goal} />
    </button>
  )
}

/**
 * Dashboard Goals strip: renders nothing when there are no active goals (no
 * empty shell on the dashboard — the Goals section only exists to surface
 * live progress). Shares the ['goals'] query key with ProfileView so the
 * cache is warm either way the app was opened.
 */
export function GoalStrip({ onOpenProfile }: GoalStripProps): ReactElement | null {
  const goalsQuery = useQuery({
    queryKey: ['goals'],
    queryFn: () => window.api.getGoals(),
    staleTime: 60_000
  })

  const now = new Date()
  const active = (goalsQuery.data ?? []).filter((g) => g.status === 'active')

  if (active.length === 0) return null

  return (
    <section className="goal-strip-section">
      <h2 className="goal-strip-section-title">Goals</h2>
      <div className="goal-strip-grid">
        {active.map((g) => (
          <GoalStripCard key={g.id} goal={g} now={now} onOpen={onOpenProfile} />
        ))}
      </div>
    </section>
  )
}
