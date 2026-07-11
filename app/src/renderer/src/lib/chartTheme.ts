// THE recharts styling vocabulary. Every chart pulls its tooltip/axis/grid
// styling from here so a theme tweak lands everywhere at once.

export const CHART = {
  aerobic: 'var(--color-aerobic)',
  aerobicDim: 'var(--color-aerobic-dim)',
  tertiary: 'var(--color-text-tertiary)',
  grid: 'var(--color-divider-soft)',
  cursor: 'var(--color-chart-cursor)'
} as const

export const chartTooltipStyle = {
  backgroundColor: 'var(--color-surface-hover)',
  border: 'none',
  borderRadius: 12,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums' as const
}

/** Standard axis tick styling — pass as `tick` to XAxis/YAxis. */
export const chartAxisTick = { fontSize: 12, fill: CHART.tertiary }

/** Smaller tick variant for compact plots (drawer, header cards). */
export const chartAxisTickSm = { fontSize: 11, fill: CHART.tertiary }
