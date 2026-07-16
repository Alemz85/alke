// Compact protein glance for the Dashboard (top row, next to Body weight).
// Owns its own queries (one-card-owns-its-queries, mirroring ProteinCard): it
// pulls the current ISO week's protein_log and derives today's grams plus the
// week's daily average via proteinWeekTable, plus user_config for an optional
// daily target.
//
// Design note — dual framing:
//   * When the owner has set a protein_target_g in Settings, the pill switches
//     to "today vs target" ("84 / 120 g") with a quiet fraction bar — the same
//     --color-load "achievement" accent ProfileView's goal bars and
//     ProteinCard's total already use. Falling short is NOT a warning state
//     (no --color-flag), so the bar never reads as alarming.
//   * When unset, it keeps the original today-vs-week-average framing exactly
//     — that comparison is still the more honest one when there's no target.
//
// Design note — inline add:
//   * A compact grams input + Add button writes straight to TODAY, reusing
//     useAddProtein(todayKey) — the exact same mutation/optimistic pattern
//     ProteinCard uses (hooks/useProteinData.ts), just scoped to today instead
//     of a navigable day. This keeps both views consistent: an add here and an
//     add in the Gym tab both flow through the same per-date-scoped mutation,
//     optimistic cache patch, and error rollback.
//   * The full day-navigator + weekly table stay Gym-only — the pill only
//     ever targets today, so there's no ambiguity about which day the grams
//     land on. The meta line still points to the Gym tab for backfills/corrections.
import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ProteinDay, UserConfig } from '@shared/types'
import { fmtNum } from '../lib/format'
import { proteinWeekTable } from '../lib/proteinWeek'
import { useAddProtein, useProteinLog } from '../hooks/useProteinData'
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

export interface ProteinTargetFraction {
  /** 0–1, clamped — how far into the daily target today's grams reach. */
  fraction: number
  /** Remaining grams to hit the target, floored at 0 (never negative/alarming). */
  remainingG: number
}

/**
 * Pure: today's grams vs a daily target, when one is set. Returns null when
 * there's no target (unset) or it isn't a usable positive number — callers
 * fall back to the week-average framing in that case.
 */
export function deriveProteinTargetFraction(
  todayGrams: number,
  target: number | null
): ProteinTargetFraction | null {
  if (target == null || target <= 0) return null
  return {
    fraction: Math.min(todayGrams / target, 1),
    remainingG: Math.max(Math.round(target - todayGrams), 0)
  }
}

/**
 * Pure: parses the compact add-grams input, mirroring ProteinCard's inline
 * `Number(input) > 0` guard. Returns null for empty/non-numeric/non-positive
 * input so callers can no-op instead of firing a zero/NaN mutation.
 */
export function parseGramsInput(raw: string): number | null {
  const grams = Number(raw)
  if (!Number.isFinite(grams) || grams <= 0) return null
  return grams
}

export function ProteinPill({ timezone }: ProteinPillProps): ReactElement {
  const today = useMemo(() => todayYMD(timezone), [timezone])
  const weekStart = useMemo(() => isoWeekStart(today), [today])
  const fromKey = ymdKey(weekStart)
  const todayKey = ymdKey(today)

  const [input, setInput] = useState('')

  // Fetch the ISO week so far (Monday → today). proteinWeekTable fills the rest
  // of the Mon–Sun week with 0g, so the average keeps its full 7-day denominator.
  const proteinLogQuery = useProteinLog(fromKey, todayKey)

  // Scoped to today, same as ProteinCard scopes to its selected day — see the
  // per-date scope rationale in useProteinData.ts.
  const addProtein = useAddProtein(todayKey)

  // Same query key/shape as ProfileView's IdentityCard — cheap, cached, and
  // picks up a Settings save via that view's broad invalidateQueries().
  const configQuery = useQuery<UserConfig>({
    queryKey: ['userConfig'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })

  const { todayGrams, weekAvg } = useMemo(
    () => deriveProteinGlance(proteinLogQuery.data ?? [], weekStart, todayKey),
    [proteinLogQuery.data, weekStart, todayKey]
  )

  const target = configQuery.data?.protein_target_g ?? null
  const hasToday = todayGrams > 0
  const deltaVsAvg = weekAvg > 0 ? todayGrams - weekAvg : null
  const targetGlance = useMemo(
    () => deriveProteinTargetFraction(todayGrams, target),
    [todayGrams, target]
  )

  function handleAdd(): void {
    const grams = parseGramsInput(input)
    if (grams === null) return
    addProtein.mutate({ date: todayKey, grams })
    setInput('')
  }

  return (
    <div className="protein-pill">
      <div className="protein-pill-head">
        <span className="protein-pill-eyebrow">Protein · today</span>
        <div className="protein-pill-add">
          <input
            type="text"
            inputMode="decimal"
            className="protein-pill-input"
            placeholder="g"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd()
            }}
            aria-label="Grams of protein to add to today"
          />
          <button
            type="button"
            className="protein-pill-add-btn"
            onClick={handleAdd}
            disabled={addProtein.isPending}
            aria-label="Add protein to today"
          >
            Add
          </button>
        </div>
      </div>
      <div className="protein-pill-figure">
        <span className="protein-pill-value tabular-nums">
          {fmtNum(todayGrams, 0)}
          {targetGlance != null ? (
            <span className="protein-pill-unit">
              {' '}
              / {fmtNum(target as number, 0)}
              <span className="protein-pill-unit-g">g</span>
            </span>
          ) : (
            <span className="protein-pill-unit">g</span>
          )}
        </span>
        {targetGlance == null && weekAvg > 0 && (
          <span className="protein-pill-avg tabular-nums">
            {fmtNum(weekAvg, 0)}g wk avg
          </span>
        )}
      </div>
      {targetGlance != null && (
        <div
          className="protein-pill-bar"
          role="progressbar"
          aria-label="Today's protein vs target"
          aria-valuenow={Math.round(todayGrams)}
          aria-valuemin={0}
          aria-valuemax={target ?? undefined}
        >
          <div
            className="protein-pill-bar-fill"
            style={{ width: `${targetGlance.fraction * 100}%` }}
          />
        </div>
      )}
      <span className="protein-pill-meta">
        {targetGlance != null
          ? hasToday
            ? `${targetGlance.remainingG}g to go`
            : 'Nothing logged today'
          : hasToday
            ? deltaVsAvg !== null
              ? `${deltaVsAvg >= 0 ? '+' : '−'}${Math.abs(Math.round(deltaVsAvg))}g vs week avg`
              : 'Logged today'
            : 'Nothing logged today'}
        {' · full log in Gym'}
      </span>
    </div>
  )
}
