// Tiny domain-accent sparkline for the compact dashboard tiles — the
// `metric-card` spec's "optional sparkline (1.5px domain-accent line, -dim area
// fill)". It carries no axes, ticks or tooltip on purpose: at tile width those
// would be illegible, and each tile already states its current value in text.
// The line is here to show SHAPE (rising, falling, flat, sparse).
//
// Two deliberate choices about honesty, per PRODUCT.md ("show the evidence",
// "prefer honest unavailable states to invented precision"):
//   - x is positioned on a real time axis (days), not by array index, so a
//     six-week gap between weigh-ins renders as a long flat run rather than a
//     tidy evenly-spaced series that implies readings nobody took.
//   - segments are straight. A monotone/spline curve would draw values between
//     two readings that were never measured.
import { useId, type ReactElement } from 'react'
import { scaleLinear } from 'd3-scale'
import { extent } from 'd3-array'
import type { Domain } from './domain'
import './Sparkline.css'

export interface SparklinePoint {
  /** Time position — use days-since-epoch (NOT the array index) so gaps stay true. */
  x: number
  y: number
}

export interface SparklineProps {
  points: SparklinePoint[]
  domain: Domain
  /** Describes the trend for screen readers; the shape alone conveys nothing to them. */
  ariaLabel: string
  height?: number
}

/* The path is authored in a fixed 100-wide user space and stretched to the tile
   by preserveAspectRatio="none"; the stroke opts out of that scaling so it
   stays a true 1.5px at any tile width. */
const VIEW_W = 100
/* Keeps the half-stroke at the extremes inside the box instead of clipped. */
const INSET = 1.5

export function Sparkline({
  points,
  domain,
  ariaLabel,
  height = 32
}: SparklineProps): ReactElement | null {
  // useId runs before the early returns below — hooks must not be conditional.
  // The colons React puts in the id are stripped: this value goes into a
  // url(#…) reference, where they are asking for trouble.
  const gradientId = `sparkline-${useId().replace(/:/g, '')}`

  if (points.length < 2) return null

  const [x0, x1] = extent(points, (p) => p.x) as [number, number]
  const [y0, y1] = extent(points, (p) => p.y) as [number, number]
  // Every reading landing on one day gives a zero-width time domain — there is
  // no trend to draw, so draw nothing rather than a divide-by-zero artefact.
  if (x0 === x1) return null

  const x = scaleLinear().domain([x0, x1]).range([0, VIEW_W])
  // A perfectly flat series has a zero-height domain; pad it so the line sits
  // centred in the box instead of collapsing onto an edge.
  const y = scaleLinear()
    .domain(y0 === y1 ? [y0 - 1, y1 + 1] : [y0, y1])
    .range([height - INSET, INSET])

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`)
    .join(' ')
  const area = `${line} L${VIEW_W},${height} L0,${height} Z`

  return (
    <svg
      className={`sparkline sparkline--${domain}`}
      style={{ height }}
      viewBox={`0 0 ${VIEW_W} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
