// Karvonen HR-zone bounds for display — MIRRORS metrics/models.py zone_bounds
// and compute.py rhr_recent_for exactly, so the ranges shown in the app are
// the ones the nightly job actually classifies with.

export interface ZoneRange {
  zone: 1 | 2 | 3 | 4 | 5
  /** Inclusive lower bpm (display-rounded). */
  fromBpm: number
  /** Exclusive upper bpm, null for Z5 (open-ended toward hr_max). */
  toBpm: number | null
}

/**
 * Thresholds where Z2..Z5 begin (Karvonen): rhr + frac × (hrMax − rhr), with
 * Z3/Z4 continuing in 0.10 steps above the configurable Z2 band.
 */
export function zoneThresholds(
  hrMax: number,
  rhrRecent: number,
  z2Low = 0.6,
  z2High = 0.7
): [number, number, number, number] {
  const hrr = hrMax - rhrRecent
  return [
    rhrRecent + z2Low * hrr,
    rhrRecent + z2High * hrr,
    rhrRecent + (z2High + 0.1) * hrr,
    rhrRecent + (z2High + 0.2) * hrr
  ]
}

/** The five display ranges implied by the thresholds. */
export function zoneRanges(
  hrMax: number,
  rhrRecent: number,
  z2Low = 0.6,
  z2High = 0.7
): ZoneRange[] {
  const [t2, t3, t4, t5] = zoneThresholds(hrMax, rhrRecent, z2Low, z2High).map(Math.round)
  return [
    { zone: 1, fromBpm: Math.round(rhrRecent), toBpm: t2 },
    { zone: 2, fromBpm: t2, toBpm: t3 },
    { zone: 3, fromBpm: t3, toBpm: t4 },
    { zone: 4, fromBpm: t4, toBpm: t5 },
    { zone: 5, fromBpm: t5, toBpm: null }
  ]
}

/**
 * Recent resting HR the way the nightly job anchors zones: median of the last
 * 7 days with a reading, else the last 60, else 60 bpm. `restingByDate` maps
 * 'YYYY-MM-DD' → resting bpm; `todayKey` bounds the windows.
 */
export function rhrRecent(restingByDate: Map<string, number>, todayKey: string): number {
  const today = new Date(`${todayKey}T00:00:00Z`).getTime()
  const dayMs = 86_400_000
  for (const window of [7, 60]) {
    const values: number[] = []
    for (let i = 0; i < window; i++) {
      const key = new Date(today - i * dayMs).toISOString().slice(0, 10)
      const v = restingByDate.get(key)
      if (v != null) values.push(v)
    }
    if (values.length > 0) {
      const sorted = [...values].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }
  }
  return 60
}
