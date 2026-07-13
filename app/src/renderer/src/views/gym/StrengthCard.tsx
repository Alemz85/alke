import { useState, type ReactElement } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { displayBodyPart } from '../../lib/gymLog'
import { GROUP_MEMBERSHIP, type MuscleGroup } from '../../lib/muscleFatigue'
import type { StrengthGroup, StrengthResult } from '../../lib/strengthLevel'

function fmtKg(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)} kg`
}

function fmtPct(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}%`
}

function levelLabel(percent: number | null): string {
  if (percent == null) return 'No reference'
  if (percent < 50) return 'Foundation'
  if (percent < 75) return 'Building'
  if (percent < 100) return 'Near reference'
  if (percent < 125) return 'Benchmark met'
  return 'Above reference'
}

/** Keep a little headroom above the 100% reference marker without letting an outlier flatten the scale. */
function benchmarkScaleWidth(percent: number | null): number {
  if (percent == null) return 0
  return Math.max(0, Math.min(100, (percent / 125) * 100))
}

function musclesForGroup(group: MuscleGroup): string[] {
  return Object.keys(GROUP_MEMBERSHIP[group]).map(displayBodyPart)
}

function GroupTile({
  group,
  selected,
  onSelect
}: {
  group: StrengthGroup
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const comparable = group.benchmarkExercise != null
  return (
    <button
      type="button"
      className={selected ? 'gym-str-tile gym-str-tile--selected' : 'gym-str-tile'}
      onClick={onSelect}
      aria-expanded={selected}
    >
      <span className="gym-str-tile-head">
        <span className="gym-str-tile-name">{displayBodyPart(group.group)}</span>
        <ArrowUpRight size={15} strokeWidth={1.75} aria-hidden="true" />
      </span>

      {comparable ? (
        <>
          <span className="gym-str-score tabular-nums">{fmtPct(group.benchmarkPct)}</span>
          <span className="gym-str-reference">of {group.benchmarkName} reference</span>
          <span
            className="gym-str-level-bar"
            aria-label={`This month ${fmtPct(group.benchmarkPct)}; personal high ${fmtPct(
              group.peakBenchmarkPct
            )}; benchmark reference at 100 percent`}
          >
            <span
              className="gym-str-level-peak"
              style={{ width: `${benchmarkScaleWidth(group.peakBenchmarkPct)}%` }}
            />
            <span
              className="gym-str-level-current"
              style={{ width: `${benchmarkScaleWidth(group.benchmarkPct)}%` }}
            />
            <span className="gym-str-level-reference" aria-hidden="true" />
          </span>
          <span className="gym-str-level-key" aria-hidden="true">
            <span>0</span>
            <span>100 ref</span>
            <span>125+</span>
          </span>
          <span className="gym-str-pills">
            <span className="gym-str-pill gym-str-pill--current">{levelLabel(group.benchmarkPct)}</span>
            <span className="gym-str-pill gym-str-pill--peak">
              Personal high {fmtPct(group.peakBenchmarkPct)}
            </span>
          </span>
        </>
      ) : (
        <>
          <span className="gym-str-no-reference">
            {group.lowData ? 'No weighted lift logged' : 'No standardized reference lift logged'}
          </span>
          <span className="gym-str-tile-note">Open to see the exercises behind this group.</span>
        </>
      )}
    </button>
  )
}

function StrengthDetail({ group }: { group: StrengthGroup }): ReactElement {
  return (
    <div className="gym-str-detail">
      <div className="gym-str-detail-head">
        <div>
          <span className="gym-field-label">{displayBodyPart(group.group)} benchmark</span>
          <h3 className="gym-str-detail-title">
            {group.benchmarkExercise ? group.benchmarkName : 'Logged exercise detail'}
          </h3>
        </div>
        {group.benchmarkExercise && (
          <span className="gym-str-detail-score tabular-nums">
            {fmtKg(group.benchmarkExercise.currentE1RM)} / {fmtKg(group.benchmarkE1RM)}
          </span>
        )}
      </div>

      <div className="gym-str-muscles" aria-label={`${displayBodyPart(group.group)} constituent muscles`}>
        {musclesForGroup(group.group).map((muscle) => (
          <span key={muscle} className="gym-str-muscle-chip">
            {muscle}
          </span>
        ))}
      </div>

      <div className="gym-str-detail-table">
        {group.exercises.map((exercise) => (
          <div key={exercise.exerciseId} className="gym-str-detail-row">
            <span className="gym-str-detail-exercise">{exercise.name}</span>
            {exercise.benchmarkE1RM != null ? (
              <span className="gym-str-detail-value tabular-nums">
                {fmtKg(exercise.currentE1RM)} this month · {fmtPct(exercise.benchmarkPct)} reference
              </span>
            ) : (
              <span className="gym-str-detail-value tabular-nums">
                {fmtKg(exercise.currentE1RM)} this month · no comparable reference
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Benchmark-based strength atlas. Its main score is a bodyweight-indexed
 * reference for standardised lifts, while a personal high is deliberately
 * secondary context. Group tiles open a focused breakdown of muscles and
 * logged lifts, instead of duplicating the muscle-load bar chart.
 */
export function StrengthCard({ result }: { result: StrengthResult }): ReactElement {
  const [expanded, setExpanded] = useState<MuscleGroup | null>(null)
  const hasAny = result.groups.some((group) => !group.lowData)
  const selected = result.groups.find((group) => group.group === expanded) ?? null

  return (
    <section className="gym-muscle-card gym-strength-card" aria-label="Strength benchmarks">
      <div className="gym-mv-head">
        <div>
          <h2 className="gym-mv-title">Strength benchmarks</h2>
          <p className="gym-str-subtitle">This month&apos;s estimated max against a bodyweight-indexed reference.</p>
        </div>
        <span className="gym-str-key">100% = reference standard</span>
      </div>

      {!hasAny ? (
        <p className="gym-muscle-footnote">
          No weighted lifts logged yet. Add a standardized free-weight lift to see a reference level.
        </p>
      ) : (
        <>
          <div className="gym-str-atlas">
            {result.groups.map((group) => (
              <GroupTile
                key={group.group}
                group={group}
                selected={expanded === group.group}
                onSelect={() => setExpanded(expanded === group.group ? null : group.group)}
              />
            ))}
          </div>
          {selected && <StrengthDetail group={selected} />}
          <p className="gym-muscle-footnote">
            Reference scores only use standardized free-weight lifts. Machine stacks and bodyweight work stay in
            the exercise detail because their loads are not comparable enough for a single benchmark.
          </p>
        </>
      )}
    </section>
  )
}
