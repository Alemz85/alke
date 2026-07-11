import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UserConfig, Workout, Zone2Fitness } from '@shared/types'
import { ZONE2_DURABLE_CEILING, ZONE2_FAST_CEILING } from '@shared/types'
import { BadgeDomain } from './BadgeDomain'
import { CalendarHeatmap } from './CalendarHeatmap'
import { DayDetailDrawer } from './DayDetailDrawer'
import { EmptyState } from './EmptyState'
import { StatTable } from './StatTable'
import type { StatTableRow } from './StatTable'
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { addDays, localDateKey, todayYMD, ymdKey, ymdToIsoStart } from '../hooks/sessionsDate'
import { cardioModalityOf } from '../lib/cardioModality'
import { formatWorkoutDuration } from '../lib/calendarDayLabel'
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
import './Zone2FitnessHeader.css'

const EM_DASH = '—'

// What each zone is FOR — the label a glance needs, not physiology prose.
const ZONE_INTENT: Record<number, string> = {
  1: 'recovery',
  2: 'aerobic base',
  3: 'tempo',
  4: 'threshold',
  5: 'max'
}

function fmtTrendPct(pct: number | null): string {
  if (pct === null) return EM_DASH
  const sign = pct > 0 ? '+' : ''
  return `${sign}${Math.round(pct)}%`
}

function fmtPerMonth(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(1)
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
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null)

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

  // Trailing 12 months of workouts (mirrors SessionsView's year-window source)
  // so the Month/Year cardio stat tables have data even when the user pages
  // the calendar to a month outside the visible grid window.
  const yearWorkoutsQuery = useQuery<Workout[]>({
    queryKey: ['zone2-fitness', 'yearWorkouts', ymdKey(today)],
    queryFn: () => {
      const fromIso = ymdToIsoStart(addDays(today, -365))
      const toIso = ymdToIsoStart(addDays(today, 1))
      return window.api.getWorkouts(fromIso, toIso)
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

  // Drawer needs a day bucket for the FULL day, independent of the isZone2Session
  // filter above (a strength day mixed with cardio should still show its cardio
  // session), so it's built from the raw month-workouts query.
  const allDaysByKey = useMemo(
    () => groupWorkoutsByDay(monthWorkoutsQuery.data ?? [], timezone),
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
      cardioSummaryWorkouts.map((w) => ({
        dateKey: localDateKey(w.start_at, timezone),
        durationS: w.duration_s ?? 0,
        type: w.type
      })),
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
        totalZ2Seconds(cardioSummaryWorkouts.filter((w) => localDateKey(w.start_at, timezone).slice(0, 7) === viewedYm)) /
          60
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
    { label: 'Time trend', value: `${fmtTrendPct(cardioMonthSum.timeTrendPct)} vs last month` }
  ]

  const cardioYearStatRows: StatTableRow[] = [
    { label: 'Sessions/mo', value: fmtPerMonth(cardioYearSum.avgCardioPerMonth) },
    { label: 'Time/mo', value: formatWorkoutDuration(cardioYearSum.avgDurationSPerMonth) },
    { label: 'Z2 min/mo', value: fmtPerMonth(cardioZ2MinPerMonth) }
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

  // HR-zone card data: the same Karvonen inputs the nightly job classifies
  // with — max HR + Z2 band from user_config, resting HR as the 7-day median.
  const configQuery = useQuery<UserConfig>({
    queryKey: ['zone2', 'config'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })
  const rhrWindow = useMemo(() => {
    const from = addDays(today, -60)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${from.year}-${pad(from.month)}-${pad(from.day)}`
  }, [today])
  const restingQuery = useQuery({
    queryKey: ['zone2-fitness', 'resting', rhrWindow, ymdKey(today)],
    queryFn: () => window.api.getDailyMetrics(rhrWindow, ymdKey(today)),
    staleTime: 60_000
  })

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

  // Share of classified training time per zone, last 90 days.
  const zoneShares = useMemo(() => {
    const cutoff = Date.now() - 90 * 86_400_000
    const totals = [0, 0, 0, 0, 0]
    for (const w of yearWorkoutsQuery.data ?? []) {
      if (new Date(w.start_at).getTime() < cutoff) continue
      const tiz = w.computed?.time_in_zones as Record<string, unknown> | null | undefined
      if (!tiz) continue
      for (let z = 1; z <= 5; z++) {
        const v = tiz[`z${z}`]
        if (typeof v === 'number') totals[z - 1] += v
      }
    }
    const sum = totals.reduce((a, b) => a + b, 0)
    return sum > 0 ? totals.map((t) => Math.round((t / sum) * 100)) : null
  }, [yearWorkoutsQuery.data])

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
          <div className="z2f-zones z2f-zones--skeleton" />
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
  const indexPct = index != null ? Math.max(0, Math.min(100, index)) : 0
  const halfWidth = indexBandHalfWidth(latest)

  // The two component tracks are drawn on ONE shared scale so their LENGTHS encode
  // their ceilings (70 vs 30): durable spans the full width, fast is 30/70 of it.
  const durableTrackPct = 100
  const fastTrackPct = (ZONE2_FAST_CEILING / ZONE2_DURABLE_CEILING) * 100

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

  // One plain-language reading of where the model says the user is, next to the
  // stage pill (the long honesty caption moves to the panel foot).
  const phaseLine =
    guidance.phase === 'building'
      ? 'Building: every quality Zone 2 session still adds level.'
      : atRisk
        ? 'Maintaining: sessions defend the base — the fast layer is fading first.'
        : 'Maintaining: sessions defend the base you have banked.'

  return (
    <section className="z2f" aria-label="Cardio fitness">
      <div className="z2f-row z2f-row--top">
      <div className={evidenceOk ? 'z2f-panel' : 'z2f-panel z2f-panel--stale'}>
        <div className="z2f-title">Cardio fitness</div>

        <div className="z2f-top">
          {/* ── The score + confidence. ── */}
          <div className="z2f-hero">
            <span className={evidenceOk ? 'z2f-index tabular-nums' : 'z2f-index z2f-index--stale tabular-nums'}>
              {indexRounded ?? '—'}
            </span>
            {halfWidth != null && <span className="z2f-index-band tabular-nums">± {halfWidth}</span>}
          </div>

          {/* ── The whole index as a fat iOS-Control-Center-style bar, out of 100. ── */}
          <div
            className="z2f-gauge"
            role="img"
            aria-label={`Cardio fitness index ${indexRounded ?? '—'} of 100`}
          >
            <div className="z2f-gauge-fill" style={{ height: `${indexPct}%` }} />
          </div>

          {/* ── Description, right of the gauge: stage pill + one-line phase reading.
              The long honesty caption lives at the panel foot. ── */}
          <div className="z2f-desc">
            <span className="z2f-stage-pill">
              {stageLabel(latest.stage)}
              <span className="z2f-note-star" aria-hidden="true">*</span>
            </span>
            <p className="z2f-phase-line">{phaseLine}</p>
          </div>
        </div>

        {/* ── Component breakdown below, the two tracks sized to their ceilings
            (durable 70 spans full width, fast 30 is 30/70 of it). ──────────── */}
        <div className="z2f-meters">
          <div className="z2f-meter" style={{ width: `${durableTrackPct}%` }}>
            <div className="z2f-meter-head">
              <span className="z2f-meter-label">Durable base</span>
              <span className="z2f-meter-value tabular-nums">
                {meters.durableValue}
                <span className="z2f-meter-ceil"> / {ZONE2_DURABLE_CEILING}</span>
              </span>
            </div>
            <div
              className="z2f-meter-track"
              role="img"
              aria-label={`Durable base ${meters.durableValue} of ${ZONE2_DURABLE_CEILING}`}
            >
              <div className="z2f-meter-fill z2f-meter-fill--durable" style={{ width: `${meters.durablePct}%` }} />
            </div>
          </div>

          <div className="z2f-meter" style={{ width: `${fastTrackPct}%` }}>
            <div className="z2f-meter-head">
              <span className="z2f-meter-label">
                Fast · form
                {atRisk && <span className="z2f-meter-chip">fading</span>}
              </span>
              <span className="z2f-meter-value tabular-nums">
                {meters.fastValue}
                <span className="z2f-meter-ceil"> / {ZONE2_FAST_CEILING}</span>
              </span>
            </div>
            <div
              className="z2f-meter-track"
              role="img"
              aria-label={`Fast layer ${meters.fastValue} of ${ZONE2_FAST_CEILING}`}
            >
              <div className="z2f-meter-fill z2f-meter-fill--fast" style={{ width: `${meters.fastPct}%` }} />
            </div>
          </div>
        </div>

        {!evidenceOk && reason && (
          <p className="z2f-evidence-note">
            <span className="z2f-evidence-tag">{latest.evidence_state.replace('_', ' ')}</span> {reason}
            {' '}Showing last known value.
          </p>
        )}

        <p className="z2f-footnote">
          <span className="z2f-note-star" aria-hidden="true">* </span>
          {HONESTY_CAPTION}
        </p>
      </div>

      {/* ── HR zones: the exact Karvonen ranges the nightly job classifies with,
          plus each zone's share of the last 90 days of training time. ── */}
      <div className="z2f-zones" aria-label="Heart-rate zones">
        <div className="z2f-zones-label">HR zones · Karvonen</div>
        {hrZones ? (
          <>
            <div className="z2f-zones-rows">
              {hrZones.ranges.map((r) => (
                <div className="z2f-zone-row" key={r.zone}>
                  <span
                    className="z2f-zone-swatch"
                    style={{ background: `var(--color-zone${r.zone})` }}
                    aria-hidden="true"
                  />
                  <span className="z2f-zone-name">
                    Z{r.zone}
                    <span className="z2f-zone-intent">{ZONE_INTENT[r.zone]}</span>
                  </span>
                  <span className="z2f-zone-range tabular-nums">
                    {r.fromBpm}–{r.toBpm ?? hrZones.hrMax} bpm
                  </span>
                  <div className="z2f-zone-share" aria-hidden="true">
                    {zoneShares && (
                      <div
                        className="z2f-zone-share-fill"
                        style={{
                          width: `${zoneShares[r.zone - 1]}%`,
                          background: `var(--color-zone${r.zone})`
                        }}
                      />
                    )}
                  </div>
                  <span className="z2f-zone-pct tabular-nums">
                    {zoneShares ? `${zoneShares[r.zone - 1]}%` : EM_DASH}
                  </span>
                </div>
              ))}
            </div>
            <p className="z2f-zones-caption">
              From max HR {hrZones.hrMax} and your 7-day resting median {hrZones.rhr}. Swim
              readings are counted ~{Math.abs(configQuery.data?.swim_hr_offset ?? -10)} bpm higher
              (the wrist reads low in water). Bars: share of your last 90 days of classified
              training time.
            </p>
          </>
        ) : (
          <p className="z2f-zones-empty">
            Set your max HR in Settings and the personalized zone ranges appear here.
          </p>
        )}
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
          onSelectDay={setSelectedDayKey}
          onPrevMonth={handlePrevMonth}
          onNextMonth={handleNextMonth}
          markers={guidance.markers}
          showDayLabel
        />
      </div>

      <div className="z2f-summary">
        <div className="z2f-summary-card">
          <h3 className="z2f-summary-title">Month summary</h3>
          <StatTable rows={cardioMonthStatRows} />
        </div>
        <div className="z2f-summary-card">
          <h3 className="z2f-summary-title">{viewYear} · monthly average</h3>
          <StatTable rows={cardioYearStatRows} />
        </div>
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
                Your base is still thin, so there’s no erosion window to defend yet — sessions
                build it. Hold/eases markers appear once you’ve banked a base.
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
          onClose={() => setSelectedDayKey(null)}
        />
      )}
    </section>
  )
}
