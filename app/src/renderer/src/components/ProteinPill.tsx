// Compact protein glance for the Dashboard (top row, next to Body weight).
// Owns its own query (one-card-owns-its-queries, mirroring ProteinCard): it
// pulls the current ISO week's protein_log and derives today's grams plus the
// week's daily average via proteinWeekTable.
//
// Design note — no live "add" here, and no numeric target:
//   * The schema carries NO protein target (UserConfig has none, ProteinDay is
//     just {log_date, grams}), so "today vs target" would be an invented number.
//     Instead the pill compares today against the week's own daily average — a
//     real, honest reference the data already supports.
//   * A one-tap add is deliberately NOT reused here. The full ProteinCard is a
//     day-navigator + weekly table; a bare "+g" on the dashboard would fork that
//     flow and confuse which day gets the grams. The pill instead points the eye
//     to the Gym tab (plain copy, since wiring a live tab-jump would need a new
//     Dashboard prop and a change to App.tsx — outside this view's surface).
import { useMemo, type ReactElement } from 'react'
import type { ProteinDay } from '@shared/types'
import { fmtNum } from '../lib/format'
import { proteinWeekTable } from '../lib/proteinWeek'
import { useProteinLog } from '../hooks/useProteinData'
import { isoWeekStart, todayYMD, ymdKey } from '../hooks/sessionsDate'
import './ProteinPill.css'

export interface ProteinPillProps {
  timezone: string | null | undefined
}

/** Pure: today's grams + the week's daily average, from the week's log rows. */
export function deriveProteinGlance(
  days: ProteinDay[],
  weekStart: ReturnType<typeof isoWeekStart>,
  todayKey: string
): { todayGrams: number; weekAvg: number } {
  const table = proteinWeekTable(days, weekStart)
  const todayGrams = table.days.find((d) => d.dateKey === todayKey)?.grams ?? 0
  return { todayGrams, weekAvg: table.avg }
}

export function ProteinPill({ timezone }: ProteinPillProps): ReactElement {
  const today = useMemo(() => todayYMD(timezone), [timezone])
  const weekStart = useMemo(() => isoWeekStart(today), [today])
  const fromKey = ymdKey(weekStart)
  const todayKey = ymdKey(today)

  // Fetch the ISO week so far (Monday → today). proteinWeekTable fills the rest
  // of the Mon–Sun week with 0g, so the average keeps its full 7-day denominator.
  const proteinLogQuery = useProteinLog(fromKey, todayKey)

  const { todayGrams, weekAvg } = useMemo(
    () => deriveProteinGlance(proteinLogQuery.data ?? [], weekStart, todayKey),
    [proteinLogQuery.data, weekStart, todayKey]
  )

  const hasToday = todayGrams > 0
  const deltaVsAvg = weekAvg > 0 ? todayGrams - weekAvg : null

  return (
    <div className="protein-pill">
      <span className="protein-pill-eyebrow">Protein · today</span>
      <div className="protein-pill-figure">
        <span className="protein-pill-value tabular-nums">
          {fmtNum(todayGrams, 0)}
          <span className="protein-pill-unit">g</span>
        </span>
        {weekAvg > 0 && (
          <span className="protein-pill-avg tabular-nums">
            {fmtNum(weekAvg, 0)}g wk avg
          </span>
        )}
      </div>
      <span className="protein-pill-meta">
        {hasToday
          ? deltaVsAvg !== null
            ? `${deltaVsAvg >= 0 ? '+' : '−'}${Math.abs(Math.round(deltaVsAvg))}g vs week avg · log in Gym`
            : 'Log protein in the Gym tab'
          : 'Nothing logged today — track it in the Gym tab'}
      </span>
    </div>
  )
}
