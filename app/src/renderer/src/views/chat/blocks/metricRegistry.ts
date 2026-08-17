// Fixed registry mapping an `alke:metric` block's `metric` key to where its
// values live (getDailyMetrics vs getComputedDaily) and how to display them.
// Deliberately closed: a metric name the agent invents that isn't in this
// table renders as a plain code-block fallback rather than guessing at a
// source/format (see MetricBlock.tsx).
import type { Domain } from '../../../components/domain'

export type MetricSource = 'daily' | 'computed'

export interface MetricDef {
  source: MetricSource
  /** Field name on the DailyMetric / ComputedDaily row. */
  field: string
  /** MetricCard eyebrow label. */
  label: string
  /** Formats a non-null raw value into its display string (unit included). */
  format: (value: number) => string
  /** Optional domain accent for the card value + sparkline; undefined = neutral. */
  domain?: Domain
}

function fixed(decimals: number, unit?: string): (value: number) => string {
  return (value: number) => (unit ? `${value.toFixed(decimals)} ${unit}` : value.toFixed(decimals))
}

function intWithUnit(unit?: string): (value: number) => string {
  return (value: number) => {
    const rounded = Math.round(value).toLocaleString()
    return unit ? `${rounded} ${unit}` : rounded
  }
}

/** "1:23" — total minutes rendered as h:mm, per spec ("render as h:mm"). */
function hoursMinutes(): (value: number) => string {
  return (value: number) => {
    const totalMin = Math.round(value)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return `${h}:${String(m).padStart(2, '0')}`
  }
}

/** Meters -> km, 2 decimals. */
function km(): (value: number) => string {
  return (value: number) => `${(value / 1000).toFixed(2)} km`
}

export const METRIC_REGISTRY: Record<string, MetricDef> = {
  // getDailyMetrics-sourced
  resting_hr: { source: 'daily', field: 'resting_hr', label: 'Resting HR', format: fixed(0, 'bpm'), domain: 'recovery' },
  hrv_sdnn_ms: { source: 'daily', field: 'hrv_sdnn_ms', label: 'HRV (SDNN)', format: fixed(0, 'ms'), domain: 'recovery' },
  respiratory_rate: {
    source: 'daily',
    field: 'respiratory_rate',
    label: 'Respiratory rate',
    format: fixed(1, '/min'),
    domain: 'recovery'
  },
  sleep_duration_min: {
    source: 'daily',
    field: 'sleep_duration_min',
    label: 'Sleep duration',
    format: hoursMinutes(),
    domain: 'recovery'
  },
  vo2max: { source: 'daily', field: 'vo2max', label: 'VO2max', format: fixed(1, 'ml/kg/min'), domain: 'aerobic' },
  steps: { source: 'daily', field: 'steps', label: 'Steps', format: intWithUnit() },
  active_energy_kcal: {
    source: 'daily',
    field: 'active_energy_kcal',
    label: 'Active energy',
    format: intWithUnit('kcal')
  },
  weight_kg: { source: 'daily', field: 'weight_kg', label: 'Weight', format: fixed(1, 'kg') },
  body_fat_pct: { source: 'daily', field: 'body_fat_pct', label: 'Body fat', format: fixed(1, '%') },
  walking_running_distance_m: {
    source: 'daily',
    field: 'walking_running_distance_m',
    label: 'Walk/run distance',
    format: km()
  },
  flights_climbed: { source: 'daily', field: 'flights_climbed', label: 'Flights climbed', format: intWithUnit() },

  // getComputedDaily-sourced
  trimp_total: { source: 'computed', field: 'trimp_total', label: 'TRIMP', format: fixed(0), domain: 'load' },
  ctl: { source: 'computed', field: 'ctl', label: 'CTL', format: fixed(1), domain: 'load' },
  atl: { source: 'computed', field: 'atl', label: 'ATL', format: fixed(1), domain: 'load' },
  tsb: { source: 'computed', field: 'tsb', label: 'TSB', format: fixed(1), domain: 'load' },
  acwr: { source: 'computed', field: 'acwr', label: 'ACWR', format: fixed(2), domain: 'load' },
  rhr_dev: { source: 'computed', field: 'rhr_dev', label: 'RHR deviation', format: fixed(1, 'bpm'), domain: 'recovery' },
  hrv_dev: { source: 'computed', field: 'hrv_dev', label: 'HRV deviation', format: fixed(1, 'ms'), domain: 'recovery' }
}

export function resolveMetricDef(metric: string): MetricDef | null {
  return METRIC_REGISTRY[metric] ?? null
}
