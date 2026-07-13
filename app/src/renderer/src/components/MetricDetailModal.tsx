import { useMemo, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Domain } from './domain'
import { EmptyState } from './EmptyState'
import { chartAxisTickSm, chartTooltipStyle } from '../lib/chartTheme'
import './MetricDetailModal.css'

/** One point on the modal's history chart. `label` is a pre-formatted x-axis string (e.g. "12 Jul"). */
export interface MetricDetailPoint {
  date: string
  label: string
  value: number | null
}

export interface MetricDetailConfig {
  title: string
  /** Pre-formatted current value, e.g. "48.2" or "72.4 kg". */
  currentValueDisplay: string
  /** Optional caption under the value (e.g. unit context or a delta). */
  currentValueCaption?: string
  series: MetricDetailPoint[]
  /** Optional comparison series rendered on the same chart (for example ATL beside CTL). */
  secondarySeries?: MetricDetailPoint[]
  /**
   * Plain-language explanation paragraph — friendly, non-medical. Optional:
   * omit it (e.g. body weight) to hide the "What this means" section entirely.
   */
  explanation?: string
  domain: Domain
  /** Name shown in the chart tooltip, e.g. "CTL". Defaults to `title`. */
  seriesName?: string
  /** Name and colour shown for the optional comparison series. */
  secondarySeriesName?: string
  secondarySeriesColor?: string
  /** Y-axis unit suffix for the tooltip, e.g. "bpm" or "kg". */
  unit?: string
  /** Overlay a smoothed trend line (rolling mean) — for noisy daily metrics like RHR. */
  showTrend?: boolean
  /** Draw a dot at each recorded reading along the curve (e.g. body weight). */
  showDots?: boolean
}

export interface MetricDetailModalProps {
  config: MetricDetailConfig
  onClose: () => void
}

interface TimeframeOption {
  key: string
  label: string
  days: number
}

const TIMEFRAMES: readonly TimeframeOption[] = [
  { key: '1M', label: '1M', days: 31 },
  { key: '3M', label: '3M', days: 92 },
  { key: '6M', label: '6M', days: 183 },
  { key: '1Y', label: '1Y', days: 366 },
  { key: 'all', label: 'All', days: Number.POSITIVE_INFINITY }
]

/** Rolling mean over the last `window` non-null values, aligned to each index. */
function rollingMean(values: (number | null)[], window: number): (number | null)[] {
  return values.map((_, i) => {
    const slice: number[] = []
    for (let j = i; j >= 0 && slice.length < window; j--) {
      const v = values[j]
      if (v !== null) slice.push(v)
    }
    if (slice.length === 0) return null
    return slice.reduce((s, v) => s + v, 0) / slice.length
  })
}

/** Formats a "YYYY-MM-DD" as "12 Jul 2026" for the tooltip (includes the year). */
function fmtTooltipDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(d)
}

/**
 * Centered modal overlay for an expanded metric view: name, current value, a
 * timeframe-filterable history chart, and (optionally) a plain-language
 * explanation. Modeled on DayDetailDrawer's overlay/scrim/Escape/aria-modal.
 */
export function MetricDetailModal({ config, onClose }: MetricDetailModalProps): ReactElement {
  // Default to the widest window; the data rarely exceeds a year anyway.
  const [timeframe, setTimeframe] = useState<string>('all')
  const seriesName = config.seriesName ?? config.title
  const secondarySeriesName = config.secondarySeriesName ?? 'Comparison'
  const secondarySeriesColor = config.secondarySeriesColor ?? 'var(--color-text-tertiary)'

  const chartData = useMemo(() => {
    const primaryByDate = new Map(config.series.map((point) => [point.date, point]))
    const secondaryByDate = new Map(
      (config.secondarySeries ?? []).map((point) => [point.date, point])
    )
    const series = [...new Set([...primaryByDate.keys(), ...secondaryByDate.keys()])]
      .sort((a, b) => a.localeCompare(b))
      .map((date) => {
        const primary = primaryByDate.get(date)
        const secondary = secondaryByDate.get(date)
        return {
          date,
          label: primary?.label ?? secondary?.label ?? date,
          value: primary?.value ?? null,
          secondaryValue: secondary?.value ?? null
        }
      })
    const tf = TIMEFRAMES.find((t) => t.key === timeframe) ?? TIMEFRAMES[TIMEFRAMES.length - 1]
    let windowed = series
    if (Number.isFinite(tf.days) && series.length > 0) {
      const lastDate = series[series.length - 1].date
      const anchor = new Date(`${lastDate}T12:00:00Z`).getTime()
      const cutoff = anchor - tf.days * 86_400_000
      windowed = series.filter((p) => new Date(`${p.date}T12:00:00Z`).getTime() >= cutoff)
    }
    if (!config.showTrend) return windowed.map((p) => ({ ...p, trend: null as number | null }))
    const trend = rollingMean(
      windowed.map((p) => p.value),
      7
    )
    return windowed.map((p, i) => ({ ...p, trend: trend[i] }))
  }, [config.secondarySeries, config.series, config.showTrend, timeframe])

  const hasData = chartData.some((p) => p.value !== null || p.secondaryValue !== null)
  const fillId = `metric-modal-fill-${config.domain}`

  return (
    <div className="metric-modal-overlay" onClick={onClose}>
      <div
        className="metric-modal"
        role="dialog"
        aria-modal="true"
        aria-label={config.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="metric-modal-header">
          <div className="metric-modal-header-text">
            <div className={`metric-modal-eyebrow metric-modal-eyebrow--${config.domain}`}>
              {config.title}
            </div>
            <div className="metric-modal-value-row">
              <span className="metric-modal-value tabular-nums">{config.currentValueDisplay}</span>
              {config.currentValueCaption && (
                <span className="metric-modal-value-caption">{config.currentValueCaption}</span>
              )}
            </div>
          </div>
          <button type="button" className="metric-modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        <div className="metric-modal-timeframes" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              type="button"
              className={`metric-modal-timeframe${timeframe === tf.key ? ' metric-modal-timeframe--active' : ''}`}
              onClick={() => setTimeframe(tf.key)}
              aria-pressed={timeframe === tf.key}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div className="metric-modal-chart">
          {config.secondarySeries && (
            <div className="metric-modal-series-key" aria-label="Chart series">
              <span>
                <i className="metric-modal-series-swatch metric-modal-series-swatch--primary" />
                {seriesName}
              </span>
              <span>
                <i
                  className="metric-modal-series-swatch"
                  style={{ backgroundColor: secondarySeriesColor }}
                />
                {secondarySeriesName}
              </span>
            </div>
          )}
          {hasData ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={`var(--color-${config.domain})`}
                      stopOpacity={0.32}
                    />
                    <stop
                      offset="100%"
                      stopColor={`var(--color-${config.domain})`}
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="label"
                  tick={chartAxisTickSm}
                  axisLine={{ stroke: 'var(--color-divider-soft)' }}
                  tickLine={false}
                  minTickGap={40}
                />
                <YAxis
                  tick={chartAxisTickSm}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                  domain={['auto', 'auto']}
                  unit={config.unit ? ` ${config.unit}` : undefined}
                />
                <Tooltip
                  contentStyle={chartTooltipStyle}
                  labelStyle={{ color: 'var(--color-text-secondary)' }}
                  isAnimationActive={false}
                  labelFormatter={(_label, payload) => {
                    const p = payload && payload[0]?.payload
                    return p?.date ? fmtTooltipDate(p.date) : _label
                  }}
                  formatter={(value: number, name: string) => [
                    config.unit ? `${Number(value).toFixed(1)} ${config.unit}` : value,
                    name
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  name={seriesName}
                  stroke={`var(--color-${config.domain})`}
                  strokeWidth={config.showTrend ? 1 : 1.5}
                  strokeOpacity={config.showTrend ? 0.45 : 1}
                  fill={config.showTrend ? 'none' : `url(#${fillId})`}
                  dot={
                    config.showDots
                      ? {
                          r: 3.5,
                          fill: `var(--color-${config.domain})`,
                          stroke: 'var(--color-surface-elevated)',
                          strokeWidth: 1.5
                        }
                      : false
                  }
                  activeDot={{ r: 5, strokeWidth: 0 }}
                  connectNulls
                  isAnimationActive={false}
                />
                {config.secondarySeries && (
                  <Area
                    type="monotone"
                    dataKey="secondaryValue"
                    name={secondarySeriesName}
                    stroke={secondarySeriesColor}
                    strokeWidth={1.75}
                    strokeDasharray="5 4"
                    fill="none"
                    dot={false}
                    activeDot={{ r: 5, strokeWidth: 0 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
                {config.showTrend && (
                  <Area
                    type="monotone"
                    dataKey="trend"
                    name="7-day trend"
                    stroke={`var(--color-${config.domain})`}
                    strokeWidth={2}
                    fill={`url(#${fillId})`}
                    dot={false}
                    activeDot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState message="No history in this range yet." />
          )}
        </div>

        {config.explanation && (
          <div className="metric-modal-explanation">
            <div className="metric-modal-section-label">What this means</div>
            <p className="metric-modal-explanation-text">{config.explanation}</p>
          </div>
        )}
      </div>
    </div>
  )
}
