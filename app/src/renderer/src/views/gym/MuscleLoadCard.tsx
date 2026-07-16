import { useMemo, useState, type ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import { displayBodyPart } from '../../lib/gymLog'
import { fatigueStatus, type GroupFatigue, type MuscleFatigueResult, type MuscleGroup } from '../../lib/muscleFatigue'
import { fmtSets } from './gymFormat'

type Period = 'week' | 'month'

function dotOpacity(fatigue: number, lowData: boolean): number {
  return lowData ? 0.28 : 0.35 + fatigue * 0.65
}

function FatigueTag({ fatigue, lowData }: { fatigue: number; lowData: boolean }): ReactElement {
  const status = fatigueStatus(fatigue, lowData)
  return (
    <span className={`gym-mv-fatigue gym-mv-fatigue--${status.label.replace(' ', '-')}`}>
      <span className="gym-mv-fatigue-dot" style={{ opacity: dotOpacity(fatigue, lowData) }} />
      <span>{status.label}</span>
      {status.percent != null && <span className="gym-mv-fatigue-value tabular-nums">{status.percent}%</span>}
    </span>
  )
}

function GroupRow({
  group,
  period,
  expanded,
  onToggle
}: {
  group: GroupFatigue
  period: Period
  expanded: boolean
  onToggle: () => void
}): ReactElement {
  const vol = period === 'week' ? group.volumeWeekSets : group.volumeMonthSets
  const status = fatigueStatus(group.fatigue, group.lowData)
  const fatiguePct = Math.round(group.fatigue * 100)

  return (
    <div className={`gym-mv-group gym-mv-group--${status.label.replace(' ', '-')}`}>
      <button type="button" className="gym-mv-row" onClick={onToggle} aria-expanded={expanded}>
        <span className="gym-mv-name">
          <ChevronDown
            size={14}
            strokeWidth={2}
            className={`gym-mv-chevron${expanded ? ' gym-mv-chevron--open' : ''}`}
          />
          {displayBodyPart(group.group)}
        </span>
        <span className="gym-mv-bar-track" aria-label={`${fatiguePct} percent fatigue`}>
          <span className="gym-mv-bar" style={{ width: `${fatiguePct}%` }} />
        </span>
        <FatigueTag fatigue={group.fatigue} lowData={group.lowData} />
        <span className="gym-mv-sets tabular-nums">{fmtSets(vol)}</span>
      </button>

      {expanded && (
        <div className="gym-mv-muscles">
          {group.muscles.length === 0 ? (
            <p className="gym-mv-muscle-empty">No sets logged for this group yet.</p>
          ) : (
            group.muscles.map((m) => (
              <div key={m.muscle} className="gym-mv-muscle-row">
                <span className="gym-mv-muscle-name">{displayBodyPart(m.muscle)}</span>
                <FatigueTag fatigue={m.fatigue} lowData={m.lowData} />
                <span className="gym-mv-muscle-sets tabular-nums">{fmtSets(m.weekSets)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The Main-tab centerpiece: per body-part group, working-set volume (week/month
 * toggle) plus a current-fatigue estimate; click a group to expand its muscles.
 */
export function MuscleLoadCard({ result }: { result: MuscleFatigueResult }): ReactElement {
  const [period, setPeriod] = useState<Period>('week')
  const [expanded, setExpanded] = useState<MuscleGroup | null>(null)

  const volOf = (g: GroupFatigue): number =>
    period === 'week' ? g.volumeWeekSets : g.volumeMonthSets

  const groups = useMemo(
    () => [...result.groups].sort((a, b) => volOf(b) - volOf(a)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result.groups, period]
  )
  const hasAnyVolume = result.groups.some((g) => g.volumeMonthSets > 0)

  return (
    <div className="gym-muscle-card">
      <div className="gym-mv-head">
        <h2 className="gym-mv-title">Muscle load &amp; fatigue</h2>
        <div className="gym-mv-toggle" role="tablist" aria-label="Volume period">
          <button
            type="button"
            role="tab"
            aria-selected={period === 'week'}
            className={period === 'week' ? 'gym-mv-chip gym-mv-chip--active' : 'gym-mv-chip'}
            onClick={() => setPeriod('week')}
          >
            This week
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={period === 'month'}
            className={period === 'month' ? 'gym-mv-chip gym-mv-chip--active' : 'gym-mv-chip'}
            onClick={() => setPeriod('month')}
          >
            This month
          </button>
        </div>
      </div>

      {!hasAnyVolume ? (
        <p className="gym-muscle-footnote">
          No working sets logged yet — volume and fatigue build from the exercises you log.
        </p>
      ) : (
        <>
          <div className="gym-mv-rows">
            <div className="gym-mv-column-labels" aria-hidden="true">
              <span />
              <span>Fatigue now</span>
              <span>State</span>
              <span>Sets</span>
            </div>
            {groups.map((g) => (
              <GroupRow
                key={g.group}
                group={g}
                period={period}
                expanded={expanded === g.group}
                onToggle={() => setExpanded(expanded === g.group ? null : g.group)}
              />
            ))}
          </div>
          <p className="gym-muscle-footnote">
            Bar length and color: current fatigue estimate. Sets: working sets{' '}
            {period === 'week' ? 'this ISO week' : 'this month'} — 1 per primary muscle, ½ per
            secondary. Fatigue reflects lifting + cardio spillover, weighted by each exercise&apos;s
            load (a barbell compound taxes more than a band drill) and by how the weight compares to
            your recent norm; decays over days; literature-based, personalizes with your data.
          </p>
        </>
      )}
    </div>
  )
}
