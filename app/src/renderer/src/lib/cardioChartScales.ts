import { extent } from 'd3-array'
import { scaleLinear } from 'd3-scale'

interface NumericAxisOptions {
  includeZero?: boolean
  paddingRatio?: number
  tickCount?: number
}

export interface NumericAxis {
  domain: [number, number]
  ticks: number[]
}

/**
 * Builds explicit D3-owned domains and ticks for Recharts cardio plots.
 * Recharts still renders the marks, while D3 controls the visual math so
 * flat or tightly clustered series retain breathing room.
 */
export function buildNumericAxis(
  values: Array<number | null | undefined>,
  options: NumericAxisOptions = {}
): NumericAxis {
  const clean = values.filter((value): value is number => Number.isFinite(value))
  const tickCount = options.tickCount ?? 5
  if (clean.length === 0) {
    return { domain: [0, 1], ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] }
  }

  const [rawMin = 0, rawMax = 1] = extent(clean)
  const span = rawMax - rawMin
  const magnitude = Math.max(Math.abs(rawMin), Math.abs(rawMax), 1)
  const padding =
    span === 0
      ? Math.max(magnitude * 0.08, 1)
      : Math.max(span * (options.paddingRatio ?? 0.12), magnitude * 0.015)

  const lower = options.includeZero ? 0 : rawMin - padding
  const upper = rawMax + padding
  const scale = scaleLinear().domain([lower, upper]).nice(tickCount)
  const domain = scale.domain() as [number, number]
  const ticks = scale.ticks(tickCount)

  return { domain, ticks }
}
