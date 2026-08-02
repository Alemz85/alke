import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { InsightCorrelation } from '@shared/types'
import { TabHeader } from './TabHeader'
import { ChartCard, EmptyState } from '../components'
import {
  buildInsightScatter,
  insightAxis,
  insightWindowStart,
  priorTrainingDensity,
  rollingCalendarMedianDeviation,
  rollingCalendarMedianDelta,
  rollingWeightTrend,
  sleepAwakeFraction,
  sleepMidpointHours
} from '../lib/insightSeries'
import {
  addDays,
  localDateKey,
  todayYMD,
  ymdKey,
  ymdToZonedIsoEnd,
  ymdToZonedIsoStart
} from '../hooks/sessionsDate'
import './InsightsView.css'

const DRIVERS = [
  { key: 'sleep_shortfall', label: 'Sleep shortfall' },
  { key: 'sleep_midpoint_dev', label: 'Sleep timing drift' },
  { key: 'sleep_awake_fraction', label: 'Sleep awake fraction' },
  { key: 'rhr_dev', label: 'RHR deviation' },
  { key: 'hrv_dev', label: 'HRV deviation' },
  { key: 'respiratory_rate_dev', label: 'Breathing-rate deviation' },
  { key: 'trimp_prior', label: 'Prior-day load' },
  { key: 'steps_prior', label: 'Prior-day steps' },
  { key: 'flights_prior', label: 'Prior-day flights' },
  { key: 'training_density_7d_prior', label: 'Prior-week training-time spread' }
]
const PERFS = [
  { key: 'decoupling', label: 'Decoupling' },
  { key: 'hrr60', label: 'HRR60' },
  { key: 'trimp_total', label: 'Workout-day load' },
  { key: 'weight_7d_slope', label: '7-day weight trend' }
]
const LAGS = [0, 1, 2, 3]
const RETIRED_FINDER_CANDIDATES = new Set(['rhr_to_load', 'hrv_to_load'])
const FINALIZED_DAILY_DRIVERS = new Set(['rhr_dev', 'hrv_dev'])

function cellColor(r: number): string {
  const alpha = 0.06 + Math.min(Math.abs(r), 1) * 0.8
  // Positive = aerobic teal, negative = violet. Sign is direction, not judgement.
  // RGB triplets come from tokens so the poles track the theme's accent palette.
  const triplet = r >= 0 ? 'var(--color-corr-positive)' : 'var(--color-corr-negative)'
  return `rgba(${triplet}, ${alpha})`
}

const tooltipStyle = {
  backgroundColor: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 12,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums' as const
}

interface FinderCandidate {
  name: string
  label: string
  outcome?: string
  status:
    | 'signal'
    | 'watch'
    | 'no_clear_signal'
    | 'insufficient'
    | 'suppressed_collinear'
    | 'suppressed_placebo'
  direction?: string
  n: number
  n_days?: number
  required_n?: number
  partial_r?: number
  effect_size?: number
  peak_hour?: number
  kind?: 'scalar' | 'cyclic'
  q_value?: number
  stable?: boolean
  suppressed_by?: string
}

interface FinderDiagnostics {
  model_version?: number
  signal_count?: number
  watch_count?: number
  candidates?: FinderCandidate[]
  caveat?: string
  placebo?: {
    tested?: number
    signal_count?: number
    watch_count?: number
  }
}

function formatClockHour(hour: number | undefined): string {
  if (hour === undefined || !Number.isFinite(hour)) return '—'
  const totalMinutes = Math.round(hour * 60) % (24 * 60)
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`
}

function candidateInterpretation(candidate: FinderCandidate): string {
  if (candidate.direction === 'co-measured') {
    if (FINALIZED_DAILY_DRIVERS.has(candidate.outcome ?? '')) {
      return 'Same-date association with a finalized daily aggregate; causal direction and within-day order are unresolved.'
    }
    return 'Same night/morning association; causal direction is unresolved.'
  }
  if (candidate.direction === 'circadian') {
    return `24-hour adjusted curve${candidate.peak_hour === undefined ? '' : `; fitted peak ${formatClockHour(candidate.peak_hour)}`}. Scheduling can still confound it.`
  }
  if (candidate.direction === 'morning-to-workout') {
    return 'Morning context precedes the workout; this is recorded behavior, not a capacity test.'
  }
  if (candidate.direction === 'prior-day-to-workout') {
    return "The previous day's finalized daily aggregate predates the workout; this is recorded behavior, not a capacity test."
  }
  if (candidate.direction === 'pre-workout-state') {
    return 'Accumulated load or recovery interval precedes the workout; this is recorded behavior, not a capacity test.'
  }
  if (candidate.direction === 'same-day-context') {
    return 'Position in the waking day precedes the workout; still observational.'
  }
  if (candidate.direction === 'workout-day-dose') {
    return 'Workout days only; estimates dose conditional on training.'
  }
  return 'Temporally ordered candidate; still observational.'
}

/** Rebuild the daily analysis series in the renderer so a clicked cell can
 * show its underlying scatter — mirrors metrics/compute.py's frame. */
function useAnalysisSeries(): {
  series: Record<string, Map<string, number>>
  timezone: string | null
  workoutContextCount: number
} {
  const config = useQuery({
    queryKey: ['insights', 'config'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })
  const timezone = config.data?.timezone ?? null
  const range = useMemo(() => {
    const today = todayYMD(timezone)
    const fromDay = addDays(today, -365)
    return {
      fromDate: ymdKey(fromDay),
      toDate: ymdKey(today),
      fromIso: ymdToZonedIsoStart(fromDay, timezone),
      toIso: ymdToZonedIsoEnd(today, timezone)
    }
  }, [timezone])
  const daily = useQuery({
    queryKey: ['insights', 'dailyMetrics', range.fromDate, range.toDate],
    queryFn: () => window.api.getDailyMetrics(range.fromDate, range.toDate),
    staleTime: 60_000
  })
  const computed = useQuery({
    queryKey: ['insights', 'computedDaily', range.fromDate, range.toDate],
    queryFn: () => window.api.getComputedDaily(range.fromDate, range.toDate),
    staleTime: 60_000
  })
  const workouts = useQuery({
    queryKey: ['insights', 'workouts', range.fromIso, range.toIso],
    queryFn: () => window.api.getWorkouts(range.fromIso, range.toIso),
    staleTime: 60_000
  })

  return useMemo(() => {
    const tz = config.data?.timezone ?? null
    const series: Record<string, Map<string, number>> = {}
    const put = (name: string, date: string, value: number | null | undefined): void => {
      if (value === null || value === undefined || Number.isNaN(value)) return
      ;(series[name] ??= new Map()).set(date, value)
    }
    const dailyRows = [...(daily.data ?? [])].sort((a, b) => a.date.localeCompare(b.date))
    const dailyByDate = new Map(dailyRows.map((row) => [row.date, row]))
    for (const m of dailyRows) {
      put('sleep_duration', m.date, m.sleep_duration_min)
      put('sleep_awake_fraction', m.date, sleepAwakeFraction(m.sleep_stages))
      put('respiratory_rate', m.date, m.respiratory_rate)
      put('steps', m.date, m.steps)
      put('flights', m.date, m.flights_climbed)
      if (m.sleep_start && m.sleep_end) {
        const recordedOffset = m.sleep_stages?.['_sleep_end_timezone_offset_min']
        put(
          'sleep_midpoint',
          m.date,
          sleepMidpointHours(
            m.sleep_start,
            m.sleep_end,
            tz,
            typeof recordedOffset === 'number' ? recordedOffset : null
          )
        )
      }
    }
    const computedRows = [...(computed.data ?? [])].sort((a, b) => a.date.localeCompare(b.date))
    computedRows.forEach((r, i) => {
      const measured = dailyByDate.get(r.date)
      if (measured?.resting_hr != null) put('rhr_dev', r.date, r.rhr_dev)
      if (measured?.hrv_sdnn_ms != null) put('hrv_dev', r.date, r.hrv_dev)
      put('trimp_total', r.date, r.trimp_total)
      if (i > 0) put('trimp_prior', r.date, computedRows[i - 1].trimp_total)
      const prior = new Date(`${r.date}T00:00:00Z`)
      prior.setUTCDate(prior.getUTCDate() - 1)
      put('steps_prior', r.date, series.steps?.get(prior.toISOString().slice(0, 10)))
      put('flights_prior', r.date, series.flights?.get(prior.toISOString().slice(0, 10)))
    })
    // Personal baselines use the prior 28 calendar days; current values cannot
    // pull their own baseline toward themselves.
    for (const [date, delta] of rollingCalendarMedianDelta(
      series.sleep_duration ?? new Map(),
      28,
      14
    )) {
      put('sleep_shortfall', date, -delta)
    }
    for (const [date, deviation] of rollingCalendarMedianDeviation(
      series.sleep_midpoint ?? new Map(),
      28,
      14
    )) {
      put('sleep_midpoint_dev', date, deviation)
    }
    for (const [date, delta] of rollingCalendarMedianDelta(
      series.respiratory_rate ?? new Map(),
      28,
      14
    )) {
      put('respiratory_rate_dev', date, delta)
    }
    for (const [date, slope] of rollingWeightTrend(
      dailyRows.map((row) => ({ date: row.date, value: row.weight_kg }))
    )) {
      put('weight_7d_slope', date, slope)
    }
    // per-day workout performance means
    const perfAcc: Record<string, Map<string, number[]>> = {
      decoupling: new Map(),
      hrr60: new Map()
    }
    const trainingDurationByDate = new Map<string, number>()
    let workoutContextCount = 0
    for (const w of workouts.data ?? []) {
      const day = localDateKey(w.start_at, tz)
      if (w.duration_s !== null && w.duration_s > 0) {
        trainingDurationByDate.set(
          day,
          (trainingDurationByDate.get(day) ?? 0) + w.duration_s / 60
        )
      }
      if (!w.computed) continue
      const zoneSeconds = ['z1', 'z2', 'z3', 'z4', 'z5'].reduce(
        (sum, zone) => sum + Number(w.computed?.time_in_zones?.[zone] ?? 0),
        0
      )
      const durationSeconds = w.duration_s ?? 0
      const hrCoverage = durationSeconds > 0 ? zoneSeconds / durationSeconds : 0
      if (
        (w.computed.trimp ?? 0) > 0 &&
        zoneSeconds >= 300 &&
        hrCoverage >= 0.9 &&
        hrCoverage <= 1.05
      ) {
        workoutContextCount++
      }
      const pairs: [string, number | null][] = [
        ['decoupling', w.computed.decoupling_pct],
        ['hrr60', w.computed.hrr60]
      ]
      for (const [name, value] of pairs) {
        if (value === null) continue
        const list = perfAcc[name].get(day) ?? []
        list.push(value)
        perfAcc[name].set(day, list)
      }
    }
    for (const [date, density] of priorTrainingDensity(
      computedRows.map((row) => ({
        date: row.date,
        value: trainingDurationByDate.get(row.date) ?? 0
      }))
    )) {
      put('training_density_7d_prior', date, density)
    }
    for (const [name, byDay] of Object.entries(perfAcc)) {
      for (const [day, values] of byDay) {
        put(name, day, values.reduce((a, b) => a + b, 0) / values.length)
      }
    }
    return { series, timezone: tz, workoutContextCount }
  }, [daily.data, computed.data, workouts.data, config.data])
}

export function InsightsView(): ReactElement {
  const [lag, setLag] = useState(0)
  const [selected, setSelected] = useState<InsightCorrelation | null>(null)

  const correlationsQuery = useQuery({
    queryKey: ['insights', 'correlations'],
    queryFn: () => window.api.getInsightCorrelations(),
    staleTime: 60_000
  })
  const modelsQuery = useQuery({
    queryKey: ['insights', 'models'],
    queryFn: () => window.api.getInsightModels(),
    staleTime: 60_000
  })
  const { series, timezone, workoutContextCount } = useAnalysisSeries()

  const storedCorrelations = (correlationsQuery.data ?? []).filter(
    (correlation) =>
      correlation.var_y !== 'ef' &&
      !(
        correlation.lag_days === 0 && FINALIZED_DAILY_DRIVERS.has(correlation.var_x)
      )
  )
  const correlationSchemaCurrent = storedCorrelations.some(
    (correlation) => correlation.var_x === 'training_density_7d_prior'
  )
  const correlations = (correlationSchemaCurrent ? storedCorrelations : []).filter((correlation) => {
    if (correlation.var_y !== 'trimp_total') return true
    const xs = series[correlation.var_x]
    const ys = series[correlation.var_y]
    if (!xs || !ys) return false
    const fromDate = insightWindowStart(correlation.computed_at, timezone)
    return (
      buildInsightScatter(xs, ys, correlation.lag_days, fromDate, true).length === correlation.n
    )
  })
  const waitingForLoadRecompute =
    correlationSchemaCurrent &&
    storedCorrelations.some((correlation) => correlation.var_y === 'trimp_total') &&
    !correlations.some((correlation) => correlation.var_y === 'trimp_total')
  const waitingForExpandedRecompute = storedCorrelations.length > 0 && !correlationSchemaCurrent
  const byKey = new Map(correlations.map((c) => [`${c.var_x}|${c.var_y}|${c.lag_days}`, c]))

  const scatterPoints = useMemo(() => {
    if (!selected) return []
    const xs = series[selected.var_x]
    const ys = series[selected.var_y]
    if (!xs || !ys) return []
    const correlationFromDate = insightWindowStart(selected.computed_at, timezone)
    return buildInsightScatter(
      xs,
      ys,
      selected.lag_days,
      correlationFromDate,
      selected.var_y === 'trimp_total'
    )
  }, [selected, series, timezone])
  const scatterAxes = useMemo(
    () => ({
      x: insightAxis(scatterPoints.map((point) => point.x)),
      y: insightAxis(scatterPoints.map((point) => point.y))
    }),
    [scatterPoints]
  )

  const models = (modelsQuery.data ?? []).filter((m) => m.coefficients)
  const finderFamilies = [
    {
      key: 'daily',
      title: 'Daily physiology',
      detail: 'Prior-day behavior, sleep, and finalized daily aggregates',
      expectedVersion: 8,
      model: (modelsQuery.data ?? []).find((model) => model.name === 'daily_adjusted_finder')
    },
    {
      key: 'workout',
      title: 'Workout context',
      detail: 'Sleep, finalized prior-day physiology, accumulated load, and workout timing',
      expectedVersion: 13,
      model: (modelsQuery.data ?? []).find((model) => model.name === 'workout_context_finder')
    }
  ].map((family) => {
    const diagnostics = family.model?.diagnostics as unknown as FinderDiagnostics | null
    const currentModel = diagnostics?.model_version === family.expectedVersion ? family.model : undefined
    const currentDiagnostics = currentModel ? diagnostics : null
    const candidates = (currentDiagnostics?.candidates ?? []).filter(
      (candidate) =>
        candidate.outcome !== 'ef' && !RETIRED_FINDER_CANDIDATES.has(candidate.name)
    )
    return {
      ...family,
      model: currentModel,
      diagnostics: currentDiagnostics,
      candidates,
      surfaced: candidates.filter(
        (candidate) => candidate.status === 'signal' || candidate.status === 'watch'
      ),
      collectingCount: candidates.filter((candidate) => candidate.status === 'insufficient').length
    }
  })
  const screenedCount = finderFamilies.reduce((sum, family) => sum + family.candidates.length, 0)
  const hasFinderModel = finderFamilies.some((family) => family.model)
  const readiness = [
    {
      label: 'Sleep context',
      value: series.sleep_duration?.size ?? 0,
      detail: 'duration and timing days'
    },
    {
      label: 'Physiology context',
      value: Math.max(series.rhr_dev?.size ?? 0, series.hrv_dev?.size ?? 0),
      detail: 'finalized RHR or HRV days'
    },
    {
      label: 'HR-derived outcomes',
      value: workoutContextCount,
      detail: 'sessions with ≥90% HR coverage'
    }
  ]
  const genericModels = models.filter(
    (model) =>
      model.name !== 'daily_adjusted_finder' &&
      model.name !== 'workout_context_finder' &&
      model.name !== 'ef_on_sleep_dlm'
  )

  return (
    <div className="view insights-view">
      <TabHeader eyebrow="Analysis" title="Insights" />

      <section className="insights-readiness" aria-labelledby="insights-readiness-title">
        <div className="insights-section-head">
          <div>
            <span className="insights-kicker">Evidence inventory · last year</span>
            <h2 id="insights-readiness-title">What the data can answer</h2>
          </div>
          <span className="insights-section-note">Coverage, not a score</span>
        </div>
        <div className="insights-readiness-rows">
          {readiness.map((item) => (
            <div className="insights-readiness-row" key={item.label}>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              <span className="tabular-nums">{item.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="insights-finder" aria-labelledby="insights-finder-title">
        <div className="insights-section-head">
          <div>
            <span className="insights-kicker">Automated finder</span>
            <h2 id="insights-finder-title">Relationships that survive the checks</h2>
          </div>
          {hasFinderModel && (
            <span className="insights-finder-count tabular-nums">
              {screenedCount} screened
            </span>
          )}
        </div>

        <div className="insights-gates" aria-label="Insight screening stages">
          <span>Temporal ordering</span>
          <span>Context controls</span>
          <span>HAC + effective n</span>
          <span>False-discovery control</span>
          <span>Block-bootstrap stability</span>
          <span>Seven-night persistence</span>
        </div>

        <div className="insights-finder-families">
          {finderFamilies.map((family) => (
            <section className="insights-finder-family" key={family.key}>
              <div className="insights-finder-family-head">
                <span>
                  <strong>{family.title}</strong>
                  <small>{family.detail}</small>
                </span>
                {family.model && (
                  <span className="tabular-nums">{family.candidates.length} candidates</span>
                )}
              </div>
              {!family.model ? (
                <p className="insights-finder-empty">
                  This family will populate on the next nightly metrics run. Candidates remain
                  dormant until they have at least 60 usable observations.
                  {family.key === 'workout' &&
                    ' Workout inference specifically needs 60 distinct workout dates; same-day sessions share recovery context.'}
                </p>
              ) : family.surfaced.length === 0 ? (
                <div className="insights-finder-empty">
                  <strong>No relationship has cleared every gate yet.</strong>
                  <span>
                    {family.collectingCount > 0
                      ? `${family.collectingCount} candidates are still collecting data. `
                      : ''}
                    A quiet result is evidence too; this family surfaces only repeatable effects.
                  </span>
                </div>
              ) : (
                <div className="insights-finder-results">
                  {family.surfaced.map((candidate) => (
                    <article key={candidate.name} className="insights-finder-result">
                      <div>
                        <span
                          className={`insights-finder-status insights-finder-status--${candidate.status}`}
                        >
                          {candidate.status === 'signal' ? 'Cleared' : 'Watch'}
                        </span>
                        <h3>{candidate.label}</h3>
                        <p>{candidateInterpretation(candidate)}</p>
                      </div>
                      <dl>
                        <div>
                          <dt>{candidate.kind === 'cyclic' ? 'Timing effect' : 'Adjusted r'}</dt>
                          <dd className="tabular-nums">
                            {(candidate.kind === 'cyclic'
                              ? candidate.effect_size
                              : candidate.partial_r
                            )?.toFixed(2) ?? '—'}
                          </dd>
                        </div>
                        <div>
                          <dt>FDR q</dt>
                          <dd className="tabular-nums">
                            {candidate.q_value?.toFixed(3) ?? '—'}
                          </dd>
                        </div>
                        <div>
                          <dt>{candidate.n_days === undefined ? 'n' : 'sessions / dates'}</dt>
                          <dd className="tabular-nums">
                            {candidate.n}
                            {candidate.n_days !== undefined && ` / ${candidate.n_days}`}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              )}
              <p className="insights-caption">
                {family.diagnostics?.caveat ??
                  'Single-person observational data. Screening reduces common false positives; it cannot establish causality.'}
              </p>
              {(family.diagnostics?.placebo?.tested ?? 0) > 0 && (
                <p className="insights-calibration">
                  Null calibration:{' '}
                  <strong>
                    {family.diagnostics?.placebo?.signal_count ?? 0}/
                    {family.diagnostics?.placebo?.tested ?? 0}
                  </strong>{' '}
                  shifted candidates fired. Any matching real candidate is suppressed.
                </p>
              )}
            </section>
          ))}
        </div>
      </section>

      {correlations.length === 0 ? (
        <EmptyState
          message={
            waitingForLoadRecompute
              ? 'Load relationships are waiting for the next metrics recompute so rest-day zeroes can be excluded.'
              : waitingForExpandedRecompute
                ? 'Expanded recovery and workout-context relationships are waiting for the next nightly metrics recompute.'
              : 'Keep training — this tab switches on at ~20 observations (~5–6 weeks) and gets honest at ~3 months.'
          }
        />
      ) : (
        <>
          <div className="insights-matrix-head">
            <span className="insights-kicker">Exploratory matrix</span>
            <h2>Unadjusted relationships to inspect</h2>
          </div>
          <div className="insights-lag-row">
            <span className="insights-lag-label">Driver lead time</span>
            <div className="chip-filter" role="tablist" aria-label="Lag selector">
              {LAGS.map((l) => (
                <button
                  key={l}
                  role="tab"
                  aria-selected={lag === l}
                  className={lag === l ? 'chip chip--active' : 'chip'}
                  onClick={() => {
                    setLag(l)
                    setSelected(null)
                  }}
                >
                  {l === 0 ? 'Same day' : `${l}d before`}
                </button>
              ))}
            </div>
          </div>

          <div className="insights-heatmap" role="table" aria-label="Correlation grid">
            <div className="insights-heatmap-row insights-heatmap-header">
              <div className="insights-heatmap-corner" />
              {PERFS.map((p) => (
                <div key={p.key} className="insights-heatmap-col-label">
                  {p.label}
                </div>
              ))}
            </div>
            {DRIVERS.map((d) => (
              <div key={d.key} className="insights-heatmap-row">
                <div className="insights-heatmap-row-label">{d.label}</div>
                {PERFS.map((p) => {
                  const cell = byKey.get(`${d.key}|${p.key}|${lag}`)
                  if (!cell) {
                    return (
                      <div
                        key={p.key}
                        className="insights-cell insights-cell--empty"
                        title="Fewer than 20 paired observations"
                      >
                        ·
                      </div>
                    )
                  }
                  const isSelected =
                    selected?.var_x === cell.var_x &&
                    selected?.var_y === cell.var_y &&
                    selected?.lag_days === cell.lag_days
                  return (
                    <button
                      key={p.key}
                      className={
                        [
                          'insights-cell',
                          isSelected ? 'insights-cell--selected' : '',
                          cell.rank_disagree ? 'insights-cell--rank-disagree' : ''
                        ]
                          .filter(Boolean)
                          .join(' ')
                      }
                      style={{ background: cellColor(cell.r) }}
                      title={
                        cell.rank_disagree
                          ? 'Pearson and rank correlation disagree; inspect for outliers or nonlinearity.'
                          : `Pearson r ${cell.r.toFixed(2)}`
                      }
                      onClick={() => setSelected(cell)}
                    >
                      {cell.r.toFixed(2)}
                      {cell.rank_disagree && <span aria-label="rank robustness warning">†</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <p className="insights-caption">
            Pearson r, teal positive / violet negative. Cells need ≥20 paired days; single-person
            data — read as hypotheses, not conclusions. p is autocorrelation-corrected (these are
            smoothed daily series — the effective sample is far smaller than the day count); q is
            the false-discovery rate across the whole grid, the number to trust before believing
            any single cell. A † marks Pearson/rank disagreement, often an outlier or nonlinear
            relationship. Workout-day load excludes rest-day zeroes; lag moves the driver back from
            each measured workout day. RHR and HRV are finalized full-day aggregates, so their
            same-day cells are withheld; only prior-day values can precede performance.
          </p>

          {selected && (
            <ChartCard
              title={`${DRIVERS.find((d) => d.key === selected.var_x)?.label} → ${PERFS.find((p) => p.key === selected.var_y)?.label}`}
              span={12}
              headerRight={
                <span className="insights-scatter-meta tabular-nums">
                  r {selected.r.toFixed(2)} · n {selected.n}
                  {selected.n_eff != null && ` (eff ${Math.round(selected.n_eff)})`} · p{' '}
                  {selected.p_value < 0.001 ? '<0.001' : selected.p_value.toFixed(3)}
                  {selected.q_value != null &&
                    ` · q ${selected.q_value < 0.001 ? '<0.001' : selected.q_value.toFixed(3)}`}
                  {selected.spearman_r != null && ` · ρ ${selected.spearman_r.toFixed(2)}`}
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={260}>
                <ScatterChart margin={{ top: 12, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke="var(--color-divider-soft)" />
                  <XAxis
                    dataKey="x"
                    type="number"
                    domain={scatterAxes.x.domain}
                    ticks={scatterAxes.x.ticks}
                    tick={{ fill: 'var(--color-text-tertiary)', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    dataKey="y"
                    type="number"
                    domain={scatterAxes.y.domain}
                    ticks={scatterAxes.y.ticks}
                    tick={{ fill: 'var(--color-text-tertiary)', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Scatter data={scatterPoints} fill="var(--color-aerobic)" />
                </ScatterChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </>
      )}

      {genericModels.length > 0 && (
        <div className="insights-models">
          {genericModels.map((m) => (
            <div key={m.name} className="insights-model-card">
              <div className="insights-model-title">{m.name}</div>
              {m.spec && <div className="insights-model-spec">{m.spec}</div>}
              <table className="insights-model-table">
                <thead>
                  <tr>
                    <th>term</th>
                    <th>coef</th>
                    <th>95% CI</th>
                    <th>p</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(m.coefficients ?? {}).map(([term, c]) => (
                    <tr key={term}>
                      <td>{term}</td>
                      <td className="tabular-nums">{c.coef.toPrecision(3)}</td>
                      <td className="tabular-nums">
                        [{c.ci_low.toPrecision(3)}, {c.ci_high.toPrecision(3)}]
                      </td>
                      <td className="tabular-nums">
                        {c.p_value < 0.001 ? '<0.001' : c.p_value.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="insights-model-diagnostics tabular-nums">
                n {m.diagnostics?.n ?? '—'} · r² {m.diagnostics?.r2?.toFixed(3) ?? '—'}
              </div>
              {m.diagnostics?.caveat && <p className="insights-caption">{m.diagnostics.caveat}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
