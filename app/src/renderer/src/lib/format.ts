// THE formatting module. Every duration/pace/delta/percent shown in the app
// formats through here — views must not keep local copies (that's how the
// same number ends up styled three ways). Ports are verbatim from the
// previously scattered helpers, one intentional fix noted on formatClock.

export const EM_DASH = '—'

/** "1:45" (hours:minutes) or "45m" under an hour — list/table density. */
export function formatClockDuration(totalS: number): string {
  const totalMin = Math.round(totalS / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  return `${h}:${m.toString().padStart(2, '0')}`
}

/** "1h 45m" / "2h" / "45m" — prose-adjacent surfaces (labels, summaries). */
export function formatDurationHM(totalSeconds: number): string {
  const totalMin = Math.max(0, Math.round(totalSeconds / 60))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/**
 * "m:ss" for short spans (set times, paces). Rounds TOTAL seconds first so
 * 119.6s is "2:00", never "1:60" (fixes a latent bug in the old drawer copy).
 */
export function formatClock(seconds: number): string {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** "2:16" per 100m, or an em dash when pace is unknown. */
export function formatPace100(paceSecPer100m: number | null): string {
  return paceSecPer100m === null ? EM_DASH : formatClock(paceSecPer100m)
}

/** Fixed-decimal number, em dash on null/NaN. */
export function fmtNum(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH
  return value.toFixed(decimals)
}

/** Signed delta ("+2.3" / "-1.1" / "±0.0"), em dash on null/NaN. */
export function fmtDelta(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH
  const sign = value > 0 ? '+' : value < 0 ? '' : '±'
  return `${sign}${value.toFixed(decimals)}`
}

/** Whole-percent trend ("+158%" / "-12%"), em dash on null. */
export function formatTrendPct(pct: number | null): string {
  if (pct === null) return EM_DASH
  const sign = pct > 0 ? '+' : ''
  return `${sign}${Math.round(pct)}%`
}

/** Per-month average: integers plain, fractions to one decimal ("4" / "4.2"). */
export function formatPerMonth(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(1)
}
