import { useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { Zone2Fitness } from '@shared/types'
import { ZONE2_DURABLE_CEILING, ZONE2_FAST_CEILING } from '@shared/types'
import { CalendarHeatmap } from './CalendarHeatmap'
import { EmptyState } from './EmptyState'
import { groupWorkoutsByDay } from '../hooks/sessionsCompute'
import { addDays, todayYMD, ymdToIsoStart } from '../hooks/sessionsDate'
import {
  evidenceReason,
  hasMaintenanceFlag,
  indexBandHalfWidth,
  latestZone2Row,
  maintenanceMessage,
  stageLabel,
  zone2BarGeometry,
  zone2IndexValue,
  zone2ProjectionSeries
} from '../lib/zone2Fitness'
import './Zone2FitnessHeader.css'

// Chart geometry keeps the base accent; teal = aerobic, everywhere (DESIGN.md law).
const AEROBIC = 'var(--color-aerobic)'
const TERTIARY = 'var(--color-text-tertiary)'

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

const stripTooltipStyle = {
  backgroundColor: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 12,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums' as const
}

/**
 * The Zone-2 fitness model header (docs/zone2-fitness-model.md v2 "Visual"): a single
 * VERTICAL two-zone bar for the composition — a solid "earned" durable foundation on the
 * bottom [0,70] and a lighter "provisional" fast cap on top [70,100], each ghosting to its
 * ceiling so headroom is honest. The headline number is the index D+F with its ± band; a
 * soft error zone across the top of the current fill keeps the crisp bar from implying false
 * precision. Below: the session calendar and the "if you stop from today" projection trail
 * (a dimmed dashed forward tail, never conflated with the solid current fill). Fetches its
 * own data with react-query so it drops in above the existing tab content.
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
  const projection = useMemo(() => zone2ProjectionSeries(rows), [rows])
  const daysByKey = useMemo(
    () => groupWorkoutsByDay(monthWorkoutsQuery.data ?? [], timezone),
    [monthWorkoutsQuery.data, timezone]
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

  // The soft error zone: a faint band centred on the top of the CURRENT fill (the index),
  // spanning the confidence interval. Positioned bottom-up so 0% == bottom of the bar.
  const bandStyle: CSSProperties = geom.hasBand
    ? { bottom: `${geom.bandLoPct}%`, height: `${Math.max(0, geom.bandHiPct - geom.bandLoPct)}%` }
    : { display: 'none' }

  // The durable ceiling divider sits at C_D / (C_D + C_F) of the height.
  const dividerPct = (ZONE2_DURABLE_CEILING / (ZONE2_DURABLE_CEILING + ZONE2_FAST_CEILING)) * 100

  return (
    <section className="z2f" aria-label="Zone 2 fitness level">
      <div className={evidenceOk ? 'z2f-panel' : 'z2f-panel z2f-panel--stale'}>
        {/* ── Vertical two-zone composition bar ─────────────────────────── */}
        <div className="z2f-barwrap">
          <div
            className="z2f-bar"
            role="img"
            aria-label={`Zone 2 fitness index ${indexRounded ?? '—'} of 100${
              halfWidth != null ? `, plus or minus ${halfWidth}` : ''
            }. Durable base ${durableRounded} of ${ZONE2_DURABLE_CEILING}, fast layer ${fastRounded} of ${ZONE2_FAST_CEILING}.`}
          >
            {/* Stacked bottom→top: durable fill, durable ghost, fast fill, fast ghost.
                Flex column-reverse would invert; we render top→bottom in DOM order so
                the fast ghost (top of bar) is first. */}
            <div className="z2f-bar-seg z2f-bar-seg--fast-ghost" style={{ height: `${geom.fastGhostPct}%` }} />
            <div className="z2f-bar-seg z2f-bar-seg--fast-fill" style={{ height: `${geom.fastFillPct}%` }} />
            <div className="z2f-bar-seg z2f-bar-seg--durable-ghost" style={{ height: `${geom.durableGhostPct}%` }} />
            <div className="z2f-bar-seg z2f-bar-seg--durable-fill" style={{ height: `${geom.durableFillPct}%` }} />

            {/* Subtle divider at the 70 ceiling (from the TOP, so it lands on the seam). */}
            <div className="z2f-bar-divider" style={{ bottom: `${dividerPct}%` }} aria-hidden="true" />

            {/* Soft confidence error zone across the top of the current fill. */}
            <div className="z2f-bar-band" style={bandStyle} aria-hidden="true" />
          </div>

          {/* Zone labels flanking the bar. */}
          <div className="z2f-bar-axis" aria-hidden="true">
            <span className="z2f-bar-axis-top">FAST · provisional</span>
            <span className="z2f-bar-axis-mid">70</span>
            <span className="z2f-bar-axis-bottom">DURABLE · earned</span>
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

      {/* ── Session calendar with the "if you stop" projection trail ─────── */}
      <div className="z2f-calendar-block">
        <CalendarHeatmap
          year={viewYear}
          month={viewMonth}
          today={today}
          daysByKey={daysByKey}
          onSelectDay={() => {}}
          onPrevMonth={handlePrevMonth}
          onNextMonth={handleNextMonth}
        />

        <div className="z2f-strip">
          <ResponsiveContainer width="100%" height={96}>
            <ComposedChart data={projection} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <XAxis dataKey="date" tick={{ fill: TERTIARY, fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={40} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis domain={[0, 100]} tick={{ fill: TERTIARY, fontSize: 11 }} axisLine={false} tickLine={false} width={28} />
              <Tooltip contentStyle={stripTooltipStyle} labelFormatter={(v) => String(v)} />
              {/* CURRENT STATE — solid historical lines. */}
              <Line dataKey="durable" name="Durable base" stroke={AEROBIC} strokeWidth={1.5} dot={false} type="monotone" isAnimationActive={false} connectNulls={false} />
              <Line dataKey="sharpness" name="Fast layer" stroke={AEROBIC} strokeOpacity={0.45} strokeWidth={1.5} dot={false} type="monotone" isAnimationActive={false} connectNulls={false} />
              {/* PROJECTION — dimmed dashed "if you stop from today" forward trail, unmistakable from the solid fill. */}
              <Line dataKey="durableProjected" name="projected if you stop" stroke={AEROBIC} strokeOpacity={0.4} strokeWidth={1.5} strokeDasharray="2 3" dot={false} type="monotone" isAnimationActive={false} connectNulls={false} legendType="none" />
              <Line dataKey="sharpnessProjected" name="projected if you stop" stroke={AEROBIC} strokeOpacity={0.25} strokeWidth={1.5} strokeDasharray="2 3" dot={false} type="monotone" isAnimationActive={false} connectNulls={false} legendType="none" />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="z2f-strip-legend">
            <span className="z2f-legend-item"><span className="z2f-legend-swatch z2f-legend-swatch--durable" /> Durable base</span>
            <span className="z2f-legend-item"><span className="z2f-legend-swatch z2f-legend-swatch--sharpness" /> Fast layer</span>
            <span className="z2f-legend-item z2f-legend-item--projected"><span className="z2f-legend-swatch z2f-legend-swatch--projected" /> Projected if you stop</span>
          </div>
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
