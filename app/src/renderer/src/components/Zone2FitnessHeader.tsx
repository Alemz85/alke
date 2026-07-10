import { useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Workout, Zone2Fitness } from '@shared/types'
import { ZONE2_DURABLE_CEILING, ZONE2_FAST_CEILING } from '@shared/types'
import { CalendarHeatmap } from './CalendarHeatmap'
import { EmptyState } from './EmptyState'
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { addDays, localDateKey, todayYMD, ymdKey, ymdToIsoStart } from '../hooks/sessionsDate'
import { cardioModalityOf } from '../lib/cardioModality'
import {
  evidenceReason,
  hasMaintenanceFlag,
  indexBandHalfWidth,
  latestZone2Row,
  maintenanceMessage,
  stageLabel,
  zone2BarGeometry,
  zone2CalendarGuidance,
  zone2IndexValue
} from '../lib/zone2Fitness'
import './Zone2FitnessHeader.css'

// v2 honesty caption: the number is anchored to the user's own swim/bike signals now,
// with watch VO2max demoted to an occasional calibration check. Trend is trustworthy;
// absolute level keeps a real band.
const HONESTY_CAPTION =
  'Anchored to your own swim and bike signals (pace/HR, RHR, HRV trends); watch VO2max is only an occasional calibration check, never the daily anchor. Trustworthy on trend, banded on absolute level — the ± is real.'

// Fallback maintenance copy (spec §5c) if the row's flag carries no message.
const MAINTENANCE_COPY =
  "You're below the dose that holds your level. Two Zone-2 sessions at target intensity in the next few days keeps it. Miss that and your fast layer fades first (top of the bar); your durable base erodes more slowly."

interface Props {
  timezone: string | null
}

/** Seconds spent in a given HR zone for a workout, or 0 when unavailable. */
function zoneSeconds(w: Workout, key: 'z2' | 'z3'): number {
  const tiz = w.computed?.time_in_zones as Record<string, unknown> | null | undefined
  const v = tiz?.[key]
  return typeof v === 'number' ? v : 0
}

/**
 * A workout is a Zone-2 session for this tab iff it is a tracked cardio modality
 * (swim/bike/row/elliptical/walk) AND carries actual Zone-2 work — z2+z3 seconds > 0.
 * Strength/core/other modalities are excluded outright, so pure-gym days never
 * appear on the Zone-2 calendar. A cardio workout whose zones haven't been computed
 * yet (computed == null) is still shown — we can't yet rule out its aerobic minutes,
 * and dropping fresh swims/bikes would understate the calendar.
 */
function isZone2Session(w: Workout): boolean {
  if (cardioModalityOf(w.type) == null) return false
  if (w.computed?.time_in_zones == null) return true // not yet computed — keep cardio
  return zoneSeconds(w, 'z2') + zoneSeconds(w, 'z3') > 0
}

/**
 * The Zone-2 fitness model header (docs/zone2-fitness-model.md v2 "Visual"). Three parts:
 *
 *  1. A CLEAN vertical two-zone composition bar — solid "earned" durable base on the
 *     bottom [0,70], a lighter "provisional" fast cap on top [70,100], each with ONE
 *     quiet ghost tone for its headroom and a single divider tick at the 70 ceiling. A
 *     small legend labels the two tones; uncertainty shows only as the "±N" text and a
 *     single thin tick at the index level. Nothing else on the bar.
 *  2. The headline index D+F, composition line, stage pill, honesty caption (kept).
 *  3. The month calendar as a COACH — annotated with forward-looking build / maintain /
 *     decay-onset markers computed from the model window + recent Zone-2 session history,
 *     with a legend and a one-line actionable summary. No trend strip.
 *
 * Fetches its own data with react-query so it drops in above the existing tab content.
 */
export function Zone2FitnessHeader({ timezone }: Props): ReactElement | null {
  const today = useMemo(() => todayYMD(timezone), [timezone])
  const [viewYear, setViewYear] = useState(today.year)
  const [viewMonth, setViewMonth] = useState(today.month)

  // Trailing ~150-day window (mid of the spec's 120–180 d range).
  const { fromDate, toDate } = useMemo(() => {
    const from = addDays(today, -150)
    return {
      fromDate: `${from.year}-${String(from.month).padStart(2, '0')}-${String(from.day).padStart(2, '0')}`,
      toDate: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`
    }
  }, [today])

  const fitnessQuery = useQuery<Zone2Fitness[]>({
    queryKey: ['zone2-fitness', fromDate, toDate],
    queryFn: () => window.api.getZone2Fitness(fromDate, toDate),
    staleTime: 60_000
  })

  // Sessions for the calendar grid (reuses the Sessions month-workout pattern).
  const monthWorkoutsQuery = useQuery({
    queryKey: ['zone2-fitness', 'monthWorkouts', viewYear, viewMonth],
    queryFn: () => {
      const monthStart = { year: viewYear, month: viewMonth, day: 1 }
      const daysInMonth = new Date(Date.UTC(viewYear, viewMonth, 0)).getUTCDate()
      const monthEnd = { year: viewYear, month: viewMonth, day: daysInMonth }
      return window.api.getWorkouts(ymdToIsoStart(addDays(monthStart, -7)), ymdToIsoStart(addDays(monthEnd, 8)))
    },
    staleTime: 60_000
  })

  const rows = useMemo(() => fitnessQuery.data ?? [], [fitnessQuery.data])
  const latest = useMemo(() => latestZone2Row(rows), [rows])

  // Only Zone-2 cardio sessions belong on this tab's calendar — strength/gym days
  // are filtered out entirely, and a day is kept only when it had actual Zone-2 work.
  const zone2Workouts = useMemo(
    () => (monthWorkoutsQuery.data ?? []).filter(isZone2Session),
    [monthWorkoutsQuery.data]
  )
  const daysByKey = useMemo(() => groupWorkoutsByDay(zone2Workouts, timezone), [zone2Workouts, timezone])

  // Zone-2 session day keys for the cadence math (same filtered workouts as the grid).
  const zone2SessionDates = useMemo(
    () => zone2Workouts.map((w) => localDateKey(w.start_at, timezone)),
    [zone2Workouts, timezone]
  )

  const todayKey = ymdKey(today)
  const guidance = useMemo(
    () => zone2CalendarGuidance(latest, zone2SessionDates, todayKey),
    [latest, zone2SessionDates, todayKey]
  )

  function handlePrevMonth(): void {
    if (viewMonth === 1) {
      setViewMonth(12)
      setViewYear((y) => y - 1)
    } else {
      setViewMonth((m) => m - 1)
    }
  }
  function handleNextMonth(): void {
    if (viewMonth === 12) {
      setViewMonth(1)
      setViewYear((y) => y + 1)
    } else {
      setViewMonth((m) => m + 1)
    }
  }

  // Loading: render nothing (the rest of the tab still shows).
  if (fitnessQuery.isLoading) return null

  // No rows yet → a muted note, never a crash.
  if (!latest || latest.durable_base == null) {
    return (
      <section className="z2f" aria-label="Zone 2 fitness level">
        <EmptyState message="Not enough data yet — your Zone 2 fitness bar appears here after the nightly model runs." />
      </section>
    )
  }

  const evidenceOk = latest.evidence_state === 'ok'
  const geom = zone2BarGeometry(latest, ZONE2_DURABLE_CEILING, ZONE2_FAST_CEILING)
  const index = zone2IndexValue(latest)
  const indexRounded = index != null ? Math.round(index) : null
  const halfWidth = indexBandHalfWidth(latest)
  const durableRounded = Math.round(latest.durable_base)
  const fastRounded = latest.sharpness != null ? Math.round(latest.sharpness) : 0

  const atRisk = hasMaintenanceFlag(latest)
  const reason = evidenceReason(latest.evidence_state)

  // The durable ceiling divider sits at C_D / (C_D + C_F) of the height.
  const dividerPct = (ZONE2_DURABLE_CEILING / (ZONE2_DURABLE_CEILING + ZONE2_FAST_CEILING)) * 100

  // A single quiet 1px tick at the index level (top of the current combined fill) —
  // the ONLY on-bar uncertainty cue; the real band lives in the "±N" text.
  const indexTickPct = geom.durableFillPct + geom.fastFillPct
  const indexTickStyle: CSSProperties = { bottom: `${indexTickPct}%` }

  // Any guidance marker that falls outside the visible month is called out in the
  // summary line instead of the grid (dates are still shown, just not annotated).
  const markerInMonth = (key: string): boolean => {
    const [y, m] = key.split('-').map(Number)
    return y === viewYear && m === viewMonth
  }
  const anyMarkerOffMonth =
    !markerInMonth(guidance.buildBy) ||
    !markerInMonth(guidance.maintainBy) ||
    !markerInMonth(guidance.decayFrom)

  return (
    <section className="z2f" aria-label="Zone 2 fitness level">
      <div className={evidenceOk ? 'z2f-panel' : 'z2f-panel z2f-panel--stale'}>
        {/* ── Clean vertical two-zone composition bar ───────────────────── */}
        <div className="z2f-barwrap">
          <div
            className="z2f-bar"
            role="img"
            aria-label={`Zone 2 fitness index ${indexRounded ?? '—'} of 100${
              halfWidth != null ? `, plus or minus ${halfWidth}` : ''
            }. Durable base ${durableRounded} of ${ZONE2_DURABLE_CEILING}, fast layer ${fastRounded} of ${ZONE2_FAST_CEILING}.`}
          >
            {/* Stacked top→bottom in DOM order: fast ghost, fast fill, durable ghost,
                durable fill. Two fills, two faint ghosts — nothing else. */}
            <div className="z2f-bar-seg z2f-bar-seg--fast-ghost" style={{ height: `${geom.fastGhostPct}%` }} />
            <div className="z2f-bar-seg z2f-bar-seg--fast-fill" style={{ height: `${geom.fastFillPct}%` }} />
            <div className="z2f-bar-seg z2f-bar-seg--durable-ghost" style={{ height: `${geom.durableGhostPct}%` }} />
            <div className="z2f-bar-seg z2f-bar-seg--durable-fill" style={{ height: `${geom.durableFillPct}%` }} />

            {/* Single thin divider tick at the 70 ceiling (the seam). */}
            <div className="z2f-bar-divider" style={{ bottom: `${dividerPct}%` }} aria-hidden="true" />

            {/* One quiet 1px tick at the index level — the only on-bar uncertainty cue. */}
            <div className="z2f-bar-tick" style={indexTickStyle} aria-hidden="true" />
          </div>
        </div>

        {/* ── Headline index + honesty labels ───────────────────────────── */}
        <div className="z2f-readout">
          <div className="z2f-eyebrow">ZONE 2 FITNESS · INDEX</div>
          <div className="z2f-index-row">
            <span className={evidenceOk ? 'z2f-index tabular-nums' : 'z2f-index z2f-index--stale tabular-nums'}>
              {indexRounded ?? '—'}
            </span>
            {halfWidth != null && <span className="z2f-index-band tabular-nums">±{halfWidth}</span>}
            <span className="z2f-index-ceiling tabular-nums">/ 100</span>
          </div>

          <div className="z2f-compose tabular-nums">
            <span className="z2f-compose-item">
              <span className="z2f-swatch z2f-swatch--durable" /> Durable {durableRounded}
              <span className="z2f-compose-ceil">/ {ZONE2_DURABLE_CEILING}</span>
            </span>
            <span className="z2f-compose-plus">+</span>
            <span className="z2f-compose-item">
              <span className="z2f-swatch z2f-swatch--fast" /> Fast {fastRounded}
              <span className="z2f-compose-ceil">/ {ZONE2_FAST_CEILING}</span>
            </span>
          </div>

          {/* Quiet legend labelling the two bar tones (no text lives on the bar). */}
          <div className="z2f-bar-legend" aria-hidden="true">
            <span className="z2f-bar-legend-item">
              <span className="z2f-swatch z2f-swatch--durable" /> Durable
            </span>
            <span className="z2f-bar-legend-item">
              <span className="z2f-swatch z2f-swatch--fast" /> Fast
            </span>
          </div>

          <div className="z2f-pills">
            <span className="z2f-stage-pill">{stageLabel(latest.stage)}</span>
          </div>

          {!evidenceOk && reason && (
            <p className="z2f-evidence-note">
              <span className="z2f-evidence-tag">{latest.evidence_state.replace('_', ' ')}</span> {reason}
              {' '}Showing last known value.
            </p>
          )}

          <p className="z2f-honesty-caption">{HONESTY_CAPTION}</p>
        </div>
      </div>

      {/* ── Session calendar as a coach: forward-looking guidance markers ── */}
      <div className="z2f-calendar-block">
        <CalendarHeatmap
          year={viewYear}
          month={viewMonth}
          today={today}
          daysByKey={daysByKey}
          onSelectDay={() => {}}
          onPrevMonth={handlePrevMonth}
          onNextMonth={handleNextMonth}
          markers={guidance.markers}
        />

        {/* One-line actionable summary (real weekday/date formatting). */}
        <p className="z2f-guidance-summary">{guidance.summary}</p>
        {anyMarkerOffMonth && (
          <p className="z2f-guidance-offmonth">
            Some markers fall outside this month — use the arrows to see them.
          </p>
        )}

        {/* Compact legend explaining the three markers. */}
        <div className="z2f-guidance-legend">
          <span className="z2f-guidance-legend-item">
            <span className="z2f-guidance-swatch z2f-guidance-swatch--build" />
            <span>
              <strong>Build</strong> — next session to keep climbing. {guidance.doses.build}
            </span>
          </span>
          <span className="z2f-guidance-legend-item">
            <span className="z2f-guidance-swatch z2f-guidance-swatch--maintain" />
            <span>
              <strong>Maintain</strong> — latest day to hold. {guidance.doses.maintain}
            </span>
          </span>
          <span className="z2f-guidance-legend-item">
            <span className="z2f-guidance-swatch z2f-guidance-swatch--decay" />
            <span>
              <strong>Eases</strong> — the index starts to erode without a Zone 2 session.
            </span>
          </span>
        </div>
      </div>

      {/* ── Maintenance nudge (neutral inset, never the red flag banner) ── */}
      {atRisk && (
        <div className="z2f-maintenance" role="note">
          <span className="badge-domain badge-domain--aerobic z2f-maintenance-badge">
            <span className="tabular-nums">ZONE 2</span>
          </span>
          <p className="z2f-maintenance-copy">{maintenanceMessage(latest) ?? MAINTENANCE_COPY}</p>
        </div>
      )}
    </section>
  )
}
