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
import { localDateKey } from '../hooks/sessionsDate'
import './InsightsView.css'

const DRIVERS = [
  { key: 'sleep_duration', label: 'Sleep duration' },
  { key: 'sleep_midpoint_dev', label: 'Sleep timing drift' },
  { key: 'rhr_dev', label: 'RHR deviation' },
  { key: 'hrv_dev', label: 'HRV deviation' },
  { key: 'trimp_prior', label: 'Prior-day load' }
]
const PERFS = [
  { key: 'ef', label: 'EF' },
  { key: 'decoupling', label: 'Decoupling' },
  { key: 'hrr60', label: 'HRR60' },
  { key: 'trimp_total', label: 'Daily load' }
]
const LAGS = [0, 1, 2, 3]

function cellColor(r: number): string {
  const alpha = 0.06 + Math.min(Math.abs(r), 1) * 0.8
  // positive = aerobic teal, negative = recovery violet — sign is direction, not judgement
  return r >= 0 ? `rgba(45, 212, 191, ${alpha})` : `rgba(167, 139, 250, ${alpha})`
}

const tooltipStyle = {
  backgroundColor: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 12,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums' as const
}

/** Rebuild the daily analysis series in the renderer so a clicked cell can
 * show its underlying scatter — mirrors metrics/compute.py's frame. */
function useAnalysisSeries(): Record<string, Map<string, number>> {
  const from = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 180)
    return d.toISOString()
  }, [])
  const daily = useQuery({
    queryKey: ['insights', 'dailyMetrics'],
    queryFn: () => window.api.getDailyMetrics(from.slice(0, 10), new Date().toISOString().slice(0, 10)),
    staleTime: 60_000
  })
  const computed = useQuery({
    queryKey: ['insights', 'computedDaily'],
    queryFn: () => window.api.getComputedDaily(from.slice(0, 10), new Date().toISOString().slice(0, 10)),
    staleTime: 60_000
  })
  const workouts = useQuery({
    queryKey: ['insights', 'workouts'],
    queryFn: () => window.api.getWorkouts(from, new Date().toISOString()),
    staleTime: 60_000
  })
  const config = useQuery({
    queryKey: ['insights', 'config'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })

  return useMemo(() => {
    const tz = config.data?.timezone ?? null
    const series: Record<string, Map<string, number>> = {}
    const put = (name: string, date: string, value: number | null | undefined): void => {
      if (value === null || value === undefined || Number.isNaN(value)) return
      ;(series[name] ??= new Map()).set(date, value)
    }
    for (const m of daily.data ?? []) {
      put('sleep_duration', m.date, m.sleep_duration_min)
      if (m.sleep_start && m.sleep_end) {
        const start = new Date(m.sleep_start).getTime()
        const end = new Date(m.sleep_end).getTime()
        const mid = new Date((start + end) / 2)
        put('sleep_midpoint', m.date, mid.getUTCHours() + mid.getUTCMinutes() / 60)
      }
    }
    const computedRows = [...(computed.data ?? [])].sort((a, b) => a.date.localeCompare(b.date))
    computedRows.forEach((r, i) => {
      put('rhr_dev', r.date, r.rhr_dev)
      put('hrv_dev', r.date, r.hrv_dev)
      put('trimp_total', r.date, r.trimp_total)
      if (i > 0) put('trimp_prior', r.date, computedRows[i - 1].trimp_total)
    })
    // sleep_midpoint_dev: |midpoint − rolling 14d median| in hours
    const mids = [...(series.sleep_midpoint ?? new Map()).entries()].sort()
    mids.forEach(([date], i) => {
      const window = mids.slice(Math.max(0, i - 13), i + 1).map(([, v]) => v)
      if (window.length < 5) return
      const sorted = [...window].sort((a, b) => a - b)
      const m = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
      put('sleep_midpoint_dev', date, Math.abs(mids[i][1] - median))
    })
    // per-day workout performance means
    const perfAcc: Record<string, Map<string, number[]>> = { ef: new Map(), decoupling: new Map(), hrr60: new Map() }
    for (const w of workouts.data ?? []) {
      if (!w.computed) continue
      const day = localDateKey(w.start_at, tz)
      const pairs: [string, number | null][] = [
        ['ef', w.computed.ef],
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
    for (const [name, byDay] of Object.entries(perfAcc)) {
      for (const [day, values] of byDay) {
        put(name, day, values.reduce((a, b) => a + b, 0) / values.length)
      }
    }
    return series
  }, [daily.data, computed.data, workouts.data, config.data])
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
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
  const series = useAnalysisSeries()

  const correlations = correlationsQuery.data ?? []
  const byKey = new Map(correlations.map((c) => [`${c.var_x}|${c.var_y}|${c.lag_days}`, c]))

  const scatterPoints = useMemo(() => {
    if (!selected) return []
    const xs = series[selected.var_x]
    const ys = series[selected.var_y]
    if (!xs || !ys) return []
    const points: { x: number; y: number; date: string }[] = []
    for (const [date, y] of ys) {
      const x = xs.get(shiftDate(date, selected.lag_days))
      if (x !== undefined) points.push({ x, y, date })
    }
    return points
  }, [selected, series])

  const models = (modelsQuery.data ?? []).filter((m) => m.coefficients)

  return (
    <div className="view">
      <TabHeader eyebrow="Analysis" title="Insights" />

      {correlations.length === 0 ? (
        <EmptyState message="Keep training — this tab switches on at ~20 observations (~5–6 weeks) and gets honest at ~3 months." />
      ) : (
        <>
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
                      <div key={p.key} className="insights-cell insights-cell--empty" title="Fewer than 20 paired observations">
                        ·
                      </div>
                    )
                  }
                  const isSelected =
                    selected?.var_x === cell.var_x && selected?.var_y === cell.var_y && selected?.lag_days === cell.lag_days
                  return (
                    <button
                      key={p.key}
                      className={isSelected ? 'insights-cell insights-cell--selected' : 'insights-cell'}
                      style={{ background: cellColor(cell.r) }}
                      onClick={() => setSelected(cell)}
                    >
                      {cell.r.toFixed(2)}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <p className="insights-caption">
            Pearson r, teal positive / violet negative. Cells need ≥20 paired days; single-person data — read as
            hypotheses, not conclusions.
          </p>

          {selected && (
            <ChartCard
              title={`${DRIVERS.find((d) => d.key === selected.var_x)?.label} → ${PERFS.find((p) => p.key === selected.var_y)?.label}`}
              span={12}
              headerRight={
                <span className="insights-scatter-meta tabular-nums">
                  r {selected.r.toFixed(2)} · n {selected.n} · p {selected.p_value < 0.001 ? '<0.001' : selected.p_value.toFixed(3)}
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={260}>
                <ScatterChart margin={{ top: 12, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke="var(--color-divider-soft)" />
                  <XAxis
                    dataKey="x"
                    type="number"
                    domain={['auto', 'auto']}
                    tick={{ fill: 'var(--color-text-tertiary)', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    dataKey="y"
                    type="number"
                    domain={['auto', 'auto']}
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

      {models.length > 0 && (
        <div className="insights-models">
          {models.map((m) => (
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
                      <td className="tabular-nums">{c.p_value < 0.001 ? '<0.001' : c.p_value.toFixed(3)}</td>
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
