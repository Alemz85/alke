// Manual protein tracker card (Gym > Main). Owns its own data: fetches the
// current ISO week's protein_log rows and derives both the selected-day
// total and the weekly table from proteinWeekTable (lib/proteinWeek.ts) —
// same one-card-owns-its-queries shape as MuscleLoadCard. Not wired into
// GymMainTab here; the caller places <ProteinCard timezone={...} />.
//
// Also reads user_config (same ['userConfig'] query IdentityCard/ProteinPill
// use) for an optional daily target: when set, a "target 120 g" caption sits
// under the daily total, and the weekly grid marks days that met it with a
// small quiet dot (title text spells it out for a11y/tooltip).
import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { UserConfig } from '@shared/types'
import { fmtNum } from '../../lib/format'
import { proteinWeekTable } from '../../lib/proteinWeek'
import { useAddProtein, useProteinLog } from '../../hooks/useProteinData'
import {
  addDays,
  isoWeekStart,
  todayYMD,
  WEEKDAY_LABELS,
  ymdKey,
  type YMD
} from '../../hooks/sessionsDate'
import './ProteinCard.css'

/** "Jul 12" — short label for the day navigator. */
function formatDayLabel(ymd: YMD): string {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day))
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d)
}

function ymdEquals(a: YMD, b: YMD): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
}

export function ProteinCard({
  timezone
}: {
  timezone: string | null | undefined
}): ReactElement {
  const today = useMemo(() => todayYMD(timezone), [timezone])
  const [selectedDate, setSelectedDate] = useState<YMD>(today)
  const [input, setInput] = useState('')

  // The day navigator owns the shown week, too. A prior-day entry therefore
  // remains visible immediately even when it crosses an ISO-week boundary.
  const weekStart = useMemo(() => isoWeekStart(selectedDate), [selectedDate])
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart])
  const fromKey = ymdKey(weekStart)
  const toKey = ymdKey(weekEnd)

  const proteinLogQuery = useProteinLog(fromKey, toKey)

  const configQuery = useQuery<UserConfig>({
    queryKey: ['userConfig'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })
  const target = configQuery.data?.protein_target_g ?? null

  const week = useMemo(
    () => proteinWeekTable(proteinLogQuery.data ?? [], weekStart),
    [proteinLogQuery.data, weekStart]
  )

  const selectedKey = ymdKey(selectedDate)
  // Scoped to the currently-selected day (see useProteinData.ts) — this hook
  // call is re-created whenever selectedKey changes, which is fine since the
  // Add button only ever targets the day currently shown.
  const addProtein = useAddProtein(selectedKey)
  const selectedGrams = week.days.find((d) => d.dateKey === selectedKey)?.grams ?? 0
  const isToday = ymdEquals(selectedDate, today)

  function goPrevDay(): void {
    setSelectedDate((d) => addDays(d, -1))
  }

  function goNextDay(): void {
    if (isToday) return
    setSelectedDate((d) => addDays(d, 1))
  }

  function handleAdd(): void {
    const grams = Number(input)
    if (!Number.isFinite(grams) || grams <= 0) return
    addProtein.mutate({ date: selectedKey, grams })
    setInput('')
  }

  return (
    <div className="protein-card">
      <div className="protein-head">
        <h2 className="protein-title">Protein</h2>
        <div className="protein-daynav">
          <button
            type="button"
            className="protein-daynav-arrow"
            aria-label="Previous day"
            onClick={goPrevDay}
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
          <span className="protein-daynav-label">
            {isToday ? 'Today' : formatDayLabel(selectedDate)}
          </span>
          <button
            type="button"
            className="protein-daynav-arrow"
            aria-label="Next day"
            onClick={goNextDay}
            disabled={isToday}
          >
            <ChevronRight size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="protein-total-row">
        <div className="protein-total">
          <span className="protein-eyebrow">
            {isToday ? "Today's protein" : `${formatDayLabel(selectedDate)} protein`}
          </span>
          <span className="protein-total-value tabular-nums">
            {fmtNum(selectedGrams, 0)}
            <span className="protein-total-unit">g</span>
          </span>
          {target != null && (
            <span className="protein-target-caption tabular-nums">target {fmtNum(target, 0)} g</span>
          )}
        </div>
        <div className="protein-entry">
        <input
          type="text"
          inputMode="decimal"
          className="gym-input protein-input"
          placeholder="Add grams"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
          aria-label="Grams of protein to add"
        />
        <button
          type="button"
          className="gym-btn gym-btn--primary"
          onClick={handleAdd}
          disabled={addProtein.isPending}
        >
          Add
        </button>
        </div>
      </div>

      <div className="protein-week">
        <div className="protein-week-row protein-week-row--head">
          {WEEKDAY_LABELS.map((label) => (
            <span key={label} className="protein-week-cell protein-week-label">
              {label}
            </span>
          ))}
          <span className="protein-week-cell protein-week-label">Avg</span>
        </div>
        <div className="protein-week-row">
          {week.days.map((d) => {
            const metTarget = target != null && d.grams >= target
            return (
              <span
                key={d.dateKey}
                className={
                  d.dateKey === selectedKey
                    ? 'protein-week-cell protein-week-value tabular-nums protein-week-value--selected'
                    : 'protein-week-cell protein-week-value tabular-nums'
                }
                title={metTarget ? `Met the ${fmtNum(target as number, 0)}g target` : undefined}
              >
                {d.grams > 0 ? fmtNum(d.grams, 0) : '—'}
                {metTarget && <span className="protein-week-target-met" aria-hidden="true" />}
              </span>
            )
          })}
          <span className="protein-week-cell protein-week-value protein-week-avg tabular-nums">
            {fmtNum(week.avg, 0)}
          </span>
        </div>
      </div>
    </div>
  )
}
