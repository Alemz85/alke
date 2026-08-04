// Compact Goals strip for the Dashboard — one metric card per ACTIVE goal,
// reusing the exact ['goals'] query key + per-goal ['goal-progress', id]
// fetches ProfileView uses (shared cache, no extra network) and the same
// metricProgress/timeProgress derivations so the "current vs target" framing
// is identical to Profile's cards. This is a summary strip, not the Profile
// deep-dive: no sparkline, no actions, no status controls — just enough to
// glance at and a click through to Profile for the rest.
import { type ReactElement } from 'react'
import { ArrowRight } from 'lucide-react'
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

  // The percentage is the card's actual answer ("how far along am I"), so it
  // leads the footer; the raw target and the change since baseline sit around
  // it as context. Previously all three were equal-weight numbers on one row
  // ("Target 7  +0  0%"), which read as a cryptic triplet.
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

      {/* One footer block, pinned to the card's bottom edge, so every goal card
          resolves at the same baseline however much it has to say. */}
      <div className="goal-strip-progress">
        {pctToTarget != null ? (
          <>
            <div className="goal-strip-progress-head">
              {/* Accent only once there is progress to report — a bright 0%
                  would make the emptiest number the loudest thing on screen. */}
              <span
                className={
                  pctToTarget > 0
                    ? 'goal-strip-progress-value tabular-nums'
                    : 'goal-strip-progress-value goal-strip-progress-value--zero tabular-nums'
                }
              >
                {pctToTarget}%
              </span>
              <span className="goal-strip-metric-range tabular-nums">
                {'Target '}
                {goal.metric_target?.toLocaleString()}
              </span>
            </div>
            <div
              className="goal-strip-bar"
              role="progressbar"
              aria-valuenow={pctToTarget}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="goal-strip-bar-fill" style={{ width: `${pctToTarget}%` }} />
            </div>
            {delta != null && (
              <span className={`goal-strip-delta ${deltaClass} tabular-nums`}>
                {delta >= 0 ? '+' : ''}
                {delta.toLocaleString()} vs start
              </span>
            )}
          </>
        ) : goal.metric_target != null ? (
          // A target exists but no baseline to measure from, so a percentage
          // would be invented. State the target and stop there.
          <span className="goal-strip-metric-range tabular-nums">
            {'Target '}
            {goal.metric_target.toLocaleString()}
          </span>
        ) : (
          <span className="goal-strip-empty">
            {points.length === 0 ? 'Metric building…' : 'Tracking only — no target set'}
          </span>
        )}
      </div>
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
      {/* Header mirrors the Recent sessions section above it: title on the
          canvas, a quiet link to the full view on the right. */}
      <div className="goal-strip-section-head">
        <h2 className="goal-strip-section-title">Goals</h2>
        <button type="button" className="goal-strip-all" onClick={onOpenProfile}>
          All goals
          <ArrowRight size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="goal-strip-grid">
        {active.map((g) => (
          <GoalStripCard key={g.id} goal={g} now={now} onOpen={onOpenProfile} />
        ))}
      </div>
    </section>
  )
}
