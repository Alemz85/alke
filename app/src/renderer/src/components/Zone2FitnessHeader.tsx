import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { scaleLinear } from 'd3-scale'
import type { Workout } from '@shared/types'
import { ZONE2_DURABLE_CEILING, ZONE2_FAST_CEILING } from '@shared/types'
import { BadgeDomain } from './BadgeDomain'
import { CalendarHeatmap } from './CalendarHeatmap'
import { DayDetailDrawer } from './DayDetailDrawer'
import { EmptyState } from './EmptyState'
import { SummaryCard } from './SummaryCard'
import type { StatTableRow } from './StatTable'
import { useMonthCalendar } from '../hooks/useMonthCalendar'
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { addDays, localDateKey, todayYMD, ymdKey } from '../hooks/sessionsDate'
import {
  useDailyMetricsRange,
  useMonthWorkouts,
  useUserConfig,
  useYearWorkouts,
  useZone2FitnessRange
} from '../hooks/useSessionsData'
import { cardioModalityOf } from '../lib/cardioModality'
import { formatWorkoutDuration } from '../lib/calendarDayLabel'
import { formatPerMonth, formatTrendPct } from '../lib/format'
import { rhrRecent, zoneRanges } from '../lib/hrZones'
import { isCardioType, monthSummary, yearSummary } from '../lib/periodSummary'
import type { SummaryItem } from '../lib/periodSummary'
import {
  ZONE2_MAINTAIN_DOSE,
  evidenceReason,
  hasMaintenanceFlag,
  indexBandHalfWidth,
  latestZone2Row,
  maintenanceMessage,
  stageLabel,
  zone2CalendarGuidance,
  zone2IndexValue,
  zone2Meters
} from '../lib/zone2Fitness'
import { HeroNumber } from './HeroNumber'
import { Zone2Trajectory } from './Zone2Trajectory'
import './Zone2FitnessHeader.css'

// What each zone is FOR — the label a glance needs, not physiology prose.
const ZONE_INTENT: Record<number, string> = {
  1: 'recovery',
  2: 'aerobic base',
  3: 'tempo',
  4: 'threshold',
  5: 'max'
}

/** Sum of computed time_in_zones.z2 seconds across the given workouts. */
function totalZ2Seconds(workouts: Workout[]): number {
  return workouts.reduce((sum, w) => {
    const tiz = w.computed?.time_in_zones as Record<string, unknown> | null | undefined
    const v = tiz?.z2
    return sum + (typeof v === 'number' ? v : 0)
  }, 0)
}

// v2 honesty caption: the number is anchored to the user's own swim/bike signals now,
// with watch VO2max demoted to an occasional calibration check. Trend is trustworthy;
// absolute level keeps a real band.
const HONESTY_CAPTION =
  'Built from your swim and bike pace/HR plus RHR and HRV trends. Watch VO2max only calibrates it occasionally. Trust the trend; treat the level as a band.'

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
  const {
    today,
    todayKey,
    viewYear,
    viewMonth,
    handlePrevMonth,
    handleNextMonth,
    selectedDayKey,
    openDay,
    closeDay
  } = useMonthCalendar(timezone)

  // Trailing ~150-day window (mid of the spec's 120–180 d range).
  const { fromDate, toDate } = useMemo(() => {
    const from = addDays(today, -150)
    return {
      fromDate: `${from.year}-${String(from.month).padStart(2, '0')}-${String(from.day).padStart(2, '0')}`,
      toDate: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`
    }
  }, [today])

  const fitnessQuery = useZone2FitnessRange(fromDate, toDate)

  // Sessions for the calendar grid (reuses the Sessions month-workout pattern).
  const monthWorkoutsQuery = useMonthWorkouts(viewYear, viewMonth)

  // Trailing 12 months of workouts (mirrors SessionsView's year-window source)
  // so the Month/Year cardio stat tables have data even when the user pages
  // the calendar to a month outside the visible grid window.
  const yearWorkoutsQuery = useYearWorkouts(timezone)

  const rows = useMemo(() => fitnessQuery.data ?? [], [fitnessQuery.data])
  const latest = useMemo(() => latestZone2Row(rows), [rows])

  // Only Zone-2 cardio sessions belong on this tab's calendar — strength/gym days
  // are filtered out entirely, and a day is kept only when it had actual Zone-2 work.
  const zone2Workouts = useMemo(
    () => (monthWorkoutsQuery.data ?? []).filter(isZone2Session),
    [monthWorkoutsQuery.data]
  )
  const daysByKey = useMemo(
    () => groupWorkoutsByDay(zone2Workouts, timezone),
    [zone2Workouts, timezone]
  )

  // Full timestamps from trailing history anchor the literal +24h to +48h
  // build window. Do not derive this from the viewed month: paging the calendar
  // must not change what the most recent Zone-2 session was.
  const zone2SessionStarts = useMemo(() => {
    const byId = new Map<string, Workout>()
    for (const workout of yearWorkoutsQuery.data ?? []) byId.set(workout.id, workout)
    for (const workout of monthWorkoutsQuery.data ?? []) byId.set(workout.id, workout)
    return [...byId.values()].filter(isZone2Session).map((workout) => workout.start_at)
  }, [monthWorkoutsQuery.data, yearWorkoutsQuery.data])

  const guidance = useMemo(
    () =>
      zone2CalendarGuidance(
        latest,
        zone2SessionStarts,
        todayKey,
        timezone ?? 'UTC',
        new Date().toISOString()
      ),
    [latest, timezone, todayKey, zone2SessionStarts]
  )

  // Drawer needs a day bucket that still includes every CARDIO workout of the
  // day (isZone2Session above additionally requires actual Z2/Z3 seconds, so
  // a cardio session with no zone time yet would otherwise vanish from the
  // drawer) — but never gym/strength, so a mixed swim+gym day only shows the
  // swim here. Built from the raw month-workouts query, cardio-filtered.
  const allDaysByKey = useMemo(
    () =>
      groupWorkoutsByDay(
        (monthWorkoutsQuery.data ?? []).filter((w) => isCardioType(w.type)),
        timezone
      ),
    [monthWorkoutsQuery.data, timezone]
  )

  // Cardio-only stat tables beside the calendar (Sessions-style Month/Year
  // summary), sourced from the trailing-12-month window merged with the
  // viewed month (covers months the trailing year doesn't reach when the
  // user pages further back) — deduped by workout id.
  const cardioSummaryWorkouts = useMemo(() => {
    const byId = new Map<string, Workout>()
    for (const w of yearWorkoutsQuery.data ?? []) {
      if (isCardioType(w.type)) byId.set(w.id, w)
    }
    for (const w of monthWorkoutsQuery.data ?? []) {
      if (isCardioType(w.type)) byId.set(w.id, w)
    }
    return Array.from(byId.values())
  }, [yearWorkoutsQuery.data, monthWorkoutsQuery.data])

  const cardioSummaryItems: SummaryItem[] = useMemo(
    () =>
      cardioSummaryWorkouts.map((w) => {
        const startMs = Date.parse(w.start_at)
        // end_at is sometimes null (HAE didn't report it) — derive from duration_s
        // so back-to-back visit merging still works for those workouts.
        const endMs = w.end_at
          ? Date.parse(w.end_at)
          : w.duration_s !== null
            ? startMs + w.duration_s * 1000
            : undefined
        return {
          dateKey: localDateKey(w.start_at, timezone),
          durationS: w.duration_s ?? 0,
          type: w.type,
          startMs: Number.isNaN(startMs) ? undefined : startMs,
          endMs: endMs !== undefined && Number.isNaN(endMs) ? undefined : endMs
        }
      }),
    [cardioSummaryWorkouts, timezone]
  )

  const viewedYm = `${viewYear.toString().padStart(4, '0')}-${viewMonth.toString().padStart(2, '0')}`
  const cardioMonthSum = useMemo(
    () => monthSummary(cardioSummaryItems, viewedYm, todayKey),
    [cardioSummaryItems, viewedYm, todayKey]
  )
  const cardioYearSum = useMemo(
    () => yearSummary(cardioSummaryItems, viewYear),
    [cardioSummaryItems, viewYear]
  )

  const cardioZ2MinViewedMonth = useMemo(
    () =>
      Math.round(
        totalZ2Seconds(
          cardioSummaryWorkouts.filter(
            (w) => localDateKey(w.start_at, timezone).slice(0, 7) === viewedYm
          )
        ) / 60
      ),
    [cardioSummaryWorkouts, timezone, viewedYm]
  )

  // Year table's "Z2 min/mo": average Z2 minutes over months that have cardio
  // data in the viewed year (same divisor as yearSummary's other averages).
  const cardioZ2MinPerMonth = useMemo(() => {
    const byMonth = new Map<string, number>()
    for (const w of cardioSummaryWorkouts) {
      const ym = localDateKey(w.start_at, timezone).slice(0, 7)
      if (!ym.startsWith(`${viewYear}-`)) continue
      byMonth.set(ym, (byMonth.get(ym) ?? 0) + totalZ2Seconds([w]))
    }
    const monthsWithData = byMonth.size
    if (monthsWithData === 0) return 0
    const totalZ2Min = Array.from(byMonth.values()).reduce((s, v) => s + v, 0) / 60
    return totalZ2Min / monthsWithData
  }, [cardioSummaryWorkouts, timezone, viewYear])

  const cardioMonthStatRows: StatTableRow[] = [
    { label: 'Cardio sessions', value: cardioMonthSum.cardioSessions.toString() },
    { label: 'Total time', value: formatWorkoutDuration(cardioMonthSum.totalDurationS) },
    { label: 'Z2 minutes', value: cardioZ2MinViewedMonth.toString() },
    { label: 'Time trend', value: `${formatTrendPct(cardioMonthSum.timeTrendPct)} vs last month` }
  ]

  const cardioYearStatRows: StatTableRow[] = [
    { label: 'Sessions/mo', value: formatPerMonth(cardioYearSum.avgCardioPerMonth) },
    { label: 'Time/mo', value: formatWorkoutDuration(cardioYearSum.avgDurationSPerMonth) },
    { label: 'Z2 min/mo', value: formatPerMonth(cardioZ2MinPerMonth) }
  ]

  const selectedBucket = selectedDayKey
    ? (allDaysByKey.get(selectedDayKey) ?? daysByKey.get(selectedDayKey))
    : undefined
  const selectedDateLabel = selectedDayKey
    ? new Date(`${selectedDayKey}T12:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
      })
    : ''

  // Loading: reserve the panel's layout height so the rest of the tab doesn't jump
  // once the query resolves.
  if (fitnessQuery.isLoading) {
    return (
      <section className="z2f" aria-label="Zone 2 fitness level">
        <div className="z2f-row z2f-row--top" aria-hidden="true">
          <div className="z2f-panel z2f-panel--skeleton">
            <div className="z2f-skeleton-line z2f-skeleton-line--eyebrow" />
            <div className="z2f-skeleton-line z2f-skeleton-line--hero" />
            <div className="z2f-meters">
              <div className="z2f-skeleton-line z2f-skeleton-line--meter" />
              <div className="z2f-skeleton-line z2f-skeleton-line--meter" />
            </div>
          </div>
        </div>
        <div className="z2f-row z2f-row--cal">
          <div className="z2f-calendar-block z2f-calendar-block--skeleton" />
          <div className="z2f-summary z2f-summary--skeleton" />
        </div>
        <div className="z2f-coach z2f-coach--skeleton" />
      </section>
    )
  }

  // No rows yet → a muted note, never a crash.
  if (!latest || latest.durable_base == null) {
    return (
      <section className="z2f" aria-label="Zone 2 fitness level">
        <EmptyState message="Not enough data yet — your Zone 2 fitness bar appears here after the nightly model runs." />
      </section>
    )
  }

  const evidenceOk = latest.evidence_state === 'ok'
  const meters = zone2Meters(latest, ZONE2_DURABLE_CEILING, ZONE2_FAST_CEILING)
  const index = zone2IndexValue(latest)
  const indexRounded = index != null ? Math.round(index) : null
  const halfWidth = indexBandHalfWidth(latest)
  const indexRangeLabel =
    indexRounded != null && halfWidth != null
      ? `${Math.max(0, indexRounded - halfWidth)}–${Math.min(100, indexRounded + halfWidth)}`
      : 'Unavailable'

  const atRisk = hasMaintenanceFlag(latest)
  const reason = evidenceReason(latest.evidence_state)

  // Any guidance marker that falls outside the visible month is called out in the
  // summary line instead of the grid (dates are still shown, just not annotated).
  // A null marker (horizon column not yet populated) is simply absent — never off-month.
  const markerInMonth = (key: string | null): boolean => {
    if (key == null) return true
    const [y, m] = key.split('-').map(Number)
    return y === viewYear && m === viewMonth
  }
  const anyMarkerOffMonth =
    !markerInMonth(guidance.buildWindow?.start ?? null) ||
    !markerInMonth(guidance.buildWindow?.end ?? null) ||
    !markerInMonth(guidance.easesFrom) ||
    !markerInMonth(guidance.holdBy)

  return (
    <section className="z2f" aria-label="Cardio fitness">
      <div className="z2f-row z2f-row--top">
        <div className={evidenceOk ? 'z2f-panel' : 'z2f-panel z2f-panel--stale'}>
          <div className="z2f-panel-head">
            <h2 className="z2f-title">Cardio fitness index</h2>
            <span className="z2f-stage">
              <span className="z2f-stage-dot" aria-hidden="true" />
              {stageLabel(latest.stage)} stage
            </span>
          </div>

          <div className="z2f-instrument">
            <div className="z2f-score-block">
              <span className="z2f-field-label">Current index</span>
              <div className="z2f-score-line">
                <HeroNumber
                  value={indexRounded}
                  format={(n) => Math.round(n).toString()}
                  className={evidenceOk ? 'z2f-index' : 'z2f-index z2f-index--stale'}
                />
                <span className="z2f-index-total">/ 100</span>
              </div>
              <dl className="z2f-score-meta">
                <div>
                  <dt>Estimated range</dt>
                  <dd className="tabular-nums">{indexRangeLabel}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>{latest.evidence_state.replace('_', ' ')}</dd>
                </div>
              </dl>
            </div>

            <div className="z2f-composition">
              <div className="z2f-composition-head">
                <span className="z2f-field-label">Index composition</span>
              </div>
              <div className="z2f-meters">
                <div className="z2f-meter z2f-meter--durable">
                  <div className="z2f-meter-head">
                    <span className="z2f-meter-label">Durable base</span>
                  </div>
                  <div className="z2f-meter-row">
                    <span className="z2f-meter-value tabular-nums">
                      {meters.durableValue}
                      <span className="z2f-meter-ceil"> / {ZONE2_DURABLE_CEILING}</span>
                    </span>
                    <div
                      className="z2f-meter-track"
                      role="img"
                      aria-label={`Durable base ${meters.durableValue} of ${ZONE2_DURABLE_CEILING}`}
                    >
                      <div
                        className="z2f-meter-fill z2f-meter-fill--durable"
                        style={{ width: `${meters.durablePct}%` }}
                      />
                    </div>
                  </div>
                  <span className="z2f-meter-note">Slow-moving fitness you keep</span>
                </div>

                <div className="z2f-meter z2f-meter--fast">
                  <div className="z2f-meter-head">
                    <span className="z2f-meter-label">
                      Fast form
                      {atRisk && <span className="z2f-meter-chip">fading</span>}
                    </span>
                  </div>
                  <div className="z2f-meter-row">
                    <span className="z2f-meter-value tabular-nums">
                      {meters.fastValue}
                      <span className="z2f-meter-ceil"> / {ZONE2_FAST_CEILING}</span>
                    </span>
                    <div
                      className="z2f-meter-track"
                      role="img"
                      aria-label={`Fast layer ${meters.fastValue} of ${ZONE2_FAST_CEILING}`}
                    >
                      <div
                        className="z2f-meter-fill z2f-meter-fill--fast"
                        style={{ width: `${meters.fastPct}%` }}
                      />
                    </div>
                  </div>
                  <span className="z2f-meter-note">Responsive fitness that changes quickly</span>
                </div>
              </div>
            </div>
          </div>

          <div className="z2f-trend" aria-label="Cardio fitness index trajectory">
            <div className="z2f-trend-head">
              <span className="z2f-field-label">150-day trajectory</span>
              <span className="z2f-trend-key">
                <i aria-hidden="true" /> Index with confidence band
              </span>
            </div>
            <Zone2Trajectory timezone={timezone} compact />
          </div>

          {!evidenceOk && reason && (
            <p className="z2f-evidence-note">
              <span className="z2f-evidence-tag">{latest.evidence_state.replace('_', ' ')}</span>{' '}
              {reason} Showing last known value.
            </p>
          )}

          <p className="z2f-footnote">
            <span className="z2f-note-star" aria-hidden="true">
              *{' '}
            </span>
            {HONESTY_CAPTION}
          </p>
        </div>
      </div>

      {/* ── Session calendar + cardio Month/Year stat tables, Sessions-style split ── */}
      <div className="z2f-row z2f-row--cal">
        <div className="z2f-calendar-block">
          <CalendarHeatmap
            year={viewYear}
            month={viewMonth}
            today={today}
            daysByKey={daysByKey}
            onSelectDay={openDay}
            onPrevMonth={handlePrevMonth}
            onNextMonth={handleNextMonth}
            markers={guidance.markers}
            showDayLabel
          />
        </div>

        <div className="z2f-summary">
          <SummaryCard title="Month summary" rows={cardioMonthStatRows} />
          <SummaryCard title={`${viewYear} · monthly average`} rows={cardioYearStatRows} />
        </div>
      </div>

      {/* ── Coach card: guidance summary + legend + maintenance nudge, full width below. ── */}
      <div className="z2f-coach">
        {/* One-line actionable summary (real weekday/date formatting). */}
        <p className="z2f-guidance-summary">{guidance.summary}</p>
        {anyMarkerOffMonth && (
          <p className="z2f-guidance-offmonth">
            Some markers fall outside this month — use the arrows to see them.
          </p>
        )}

        {/* Compact legend. In the building phase only the build window shows — a
            thin base has nothing banked to protect yet. The eases/hold markers
            appear once the base is worth defending (maintenance phase). */}
        <div className="z2f-guidance-legend">
          {guidance.buildWindow != null && guidance.buildDose != null && (
            <span className="z2f-guidance-legend-item">
              <span className="z2f-guidance-swatch z2f-guidance-swatch--build" />
              <span>
                <strong>{guidance.buildOverdue ? 'Build (due now)' : 'Build window'}</strong> — the
                24–48h band to train in and keep climbing. {guidance.buildDose}
              </span>
            </span>
          )}
          {guidance.phase === 'building' && (
            <span className="z2f-guidance-legend-item z2f-guidance-legend-note">
              <span>
                Your base is still thin, so there’s no erosion window to defend yet — sessions build
                it. Hold/eases markers appear once you’ve banked a base.
              </span>
            </span>
          )}
          {guidance.holdBy != null && (
            <span className="z2f-guidance-legend-item">
              <span className="z2f-guidance-swatch z2f-guidance-swatch--maintain" />
              <span>
                <strong>Hold by</strong> — latest day one session still holds today’s level.{' '}
                {ZONE2_MAINTAIN_DOSE}
              </span>
            </span>
          )}
          {guidance.easesFrom != null && (
            <span className="z2f-guidance-legend-item">
              <span className="z2f-guidance-swatch z2f-guidance-swatch--decay" />
              <span>
                <strong>Eases</strong> — your durable base starts to erode (past the confidence
                band) without a Zone 2 session.
              </span>
            </span>
          )}
        </div>

        {/* Maintenance nudge (neutral inset, never the red flag banner). */}
        {atRisk && (
          <div className="z2f-maintenance" role="note">
            <span className="z2f-maintenance-badge">
              <BadgeDomain domain="aerobic" label="ZONE 2" />
            </span>
            <p className="z2f-maintenance-copy">{maintenanceMessage(latest) ?? MAINTENANCE_COPY}</p>
          </div>
        )}
      </div>

      {selectedDayKey && selectedBucket && (
        <DayDetailDrawer
          dateLabel={selectedDateLabel}
          workouts={selectedBucket.workouts}
          timezone={timezone}
          onClose={closeDay}
        />
      )}
    </section>
  )
}

/** Zone fill: Z2 carries the domain accent, the rest use the qualitative zone tokens. */
const ZONE_FILL: Record<number, string> = {
  1: 'var(--color-zone1)',
  2: 'var(--color-aerobic)',
  3: 'var(--color-zone3)',
  4: 'var(--color-zone4)',
  5: 'var(--color-zone5)'
}

/**
 * HR-zones card (Karvonen Z1–Z5) — lives in Zone2View's main grid. Self-fetches
 * independently of Zone2FitnessHeader, same Karvonen inputs the nightly job
 * classifies with: max HR + Z2 band from user_config, resting HR as the 7-day
 * median.
 *
 * Pure REFERENCE, no time data: the five zones are drawn on one shared
 * horizontal bpm axis spanning [Z1 lower bound, max HR], each zone a colored
 * segment positioned at its actual [from, to] bpm — so segment position and
 * width genuinely encode where each zone sits on the HR scale, not an
 * arbitrary equal split. A few bpm ticks anchor the scale.
 */
export function Zone2HrZonesCard({ timezone }: Props): ReactElement {
  const today = useMemo(() => todayYMD(timezone), [timezone])
  const configQuery = useUserConfig()
  const rhrWindow = useMemo(() => {
    const from = addDays(today, -60)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${from.year}-${pad(from.month)}-${pad(from.day)}`
  }, [today])
  const restingQuery = useDailyMetricsRange(rhrWindow, ymdKey(today))

  const hrZones = useMemo(() => {
    const hrMax = configQuery.data?.hr_max
    if (hrMax == null) return null
    const restingByDate = new Map<string, number>()
    for (const d of restingQuery.data ?? []) {
      if (d.resting_hr != null) restingByDate.set(d.date, d.resting_hr)
    }
    const rhr = rhrRecent(restingByDate, ymdKey(today))
    return {
      hrMax,
      rhr: Math.round(rhr),
      ranges: zoneRanges(
        hrMax,
        rhr,
        configQuery.data?.zone2_low_frac ?? 0.6,
        configQuery.data?.zone2_high_frac ?? 0.7
      )
    }
  }, [configQuery.data, restingQuery.data, today])

  if (!hrZones) {
    return (
      <div className="z2hr" aria-label="Heart-rate zones">
        <p className="z2hr-empty">
          Set your max HR in Settings and your personalized Karvonen zone ranges appear here.
        </p>
      </div>
    )
  }

  const axisMin = hrZones.ranges[0].fromBpm
  const axisMax = hrZones.hrMax
  const bpmScale = scaleLinear().domain([axisMin, axisMax]).range([0, 100]).clamp(true)

  // Label the axis with the actual zone thresholds (each zone's upper bound plus
  // the resting-HR floor) rather than arbitrary round numbers — the ticks line
  // up exactly with the segment edges instead of scattering across them.
  const axisTicks = Array.from(
    new Set<number>([axisMin, ...hrZones.ranges.map((r) => r.toBpm ?? axisMax)])
  ).sort((a, b) => a - b)

  return (
    <div className="z2hr" aria-label="Heart-rate zone reference">
      <div
        className="z2hr-track"
        role="img"
        aria-label={`Heart-rate zones from ${axisMin} to ${axisMax} bpm`}
      >
        {hrZones.ranges.map((r) => {
          const to = r.toBpm ?? axisMax
          const left = bpmScale(r.fromBpm)
          const width = Math.max(bpmScale(to) - left, 0.5)
          return (
            <div
              key={r.zone}
              className="z2hr-segment"
              style={{ left: `${left}%`, width: `${width}%`, background: ZONE_FILL[r.zone] }}
              title={`Z${r.zone} ${ZONE_INTENT[r.zone]}: ${r.fromBpm}–${to} bpm`}
            />
          )
        })}
      </div>

      <div className="z2hr-axis" aria-hidden="true">
        {axisTicks.map((bpm) => {
          const pos = bpmScale(bpm)
          // Keep the endpoint labels inside the track instead of half-clipped.
          const transform =
            pos <= 1 ? 'translateX(0)' : pos >= 99 ? 'translateX(-100%)' : 'translateX(-50%)'
          return (
            <span key={bpm} className="z2hr-axis-tick" style={{ left: `${pos}%`, transform }}>
              {bpm}
            </span>
          )
        })}
      </div>

      <div className="z2hr-rows">
        {hrZones.ranges.map((r) => (
          <div className="z2hr-row" key={r.zone}>
            <span
              className="z2hr-zone-swatch"
              style={{ background: ZONE_FILL[r.zone] }}
              aria-hidden="true"
            />
            <span className="z2hr-zone-name">
              Z{r.zone}
              <span className="z2hr-zone-intent">{ZONE_INTENT[r.zone]}</span>
            </span>
            <span className="z2hr-zone-bpm tabular-nums">
              {r.fromBpm}–{r.toBpm ?? hrZones.hrMax} bpm
            </span>
          </div>
        ))}
      </div>

      <p className="z2hr-caption">
        Karvonen zones from max HR {hrZones.hrMax} and your 7-day resting median {hrZones.rhr} — the
        same math the nightly job classifies with. Swim readings are counted ~
        {Math.abs(configQuery.data?.swim_hr_offset ?? -10)} bpm higher (the wrist reads low in
        water).
      </p>
    </div>
  )
}
