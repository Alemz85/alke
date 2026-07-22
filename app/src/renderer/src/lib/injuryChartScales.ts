import { scaleUtc } from 'd3-scale'
import { utcMonday } from 'd3-time'

const FALLBACK_DOMAIN: [number, number] = [0, 1]

export interface PainTimeAxis {
  domain: [number, number]
  ticks: number[]
}

export function painDateTimestamp(ymd: string): number {
  return Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`)
}

/** A real UTC time axis with fixed two-week Monday ticks across the 90-day window. */
export function buildPainTimeAxis(dates: string[]): PainTimeAxis {
  const timestamps = dates
    .map(painDateTimestamp)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)

  if (timestamps.length === 0) return { domain: FALLBACK_DOMAIN, ticks: [] }

  const domain: [number, number] = [timestamps[0], timestamps[timestamps.length - 1]]
  if (domain[0] === domain[1]) return { domain, ticks: [domain[0]] }

  const scale = scaleUtc().domain(domain.map((timestamp) => new Date(timestamp)))
  const interval = utcMonday.every(2)
  const ticks = (interval ? scale.ticks(interval) : scale.ticks(6)).map(Number)

  return { domain, ticks: [...new Set(ticks)] }
}

export function formatPainAxisDate(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(5, 10)
}

export function formatPainTooltipDate(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })
}
