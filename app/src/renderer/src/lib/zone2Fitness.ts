// Pure presentation logic for the Zone-2 fitness model UX (docs/zone2-fitness-model.md §10).
// Kept out of the React view so the band formatting, latest-row selection, and the
// "projected if you stop" decay series are unit-testable in isolation. No React, no DOM.
import type { Zone2EvidenceState, Zone2Fitness, Zone2Stage } from '@shared/types'

/** τ_fast for the sharpness projection (days). Locked constant, spec §2a. */
export const TAU_FAST_DAYS = 14

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * Geometry for the v2 vertical two-zone bar (docs/zone2-fitness-model.md v2 "Visual").
 * All outputs are PERCENTAGES OF THE FULL 0→100 INDEX HEIGHT so the caller can position
 * every layer against one shared axis — the durable zone is the bottom [0, C_D] slice
 * and the fast zone is the top [C_D, C_D+C_F] slice.
 *
 *   durableFillPct  solid "earned" teal, 0 → D (durable_base), clamped to [0, C_D]
 *   durableGhostPct ghosted headroom, D → C_D (the durable ceiling)
 *   fastFillPct     lighter "provisional" teal, C_D → C_D+F (sharpness), F clamped to [0, C_F]
 *   fastGhostPct    ghosted headroom, C_D+F → C_D+C_F (the top of the bar)
 *   indexValue      D + F (the headline number), clamped to [0, C_D+C_F]
 *   bandLoPct       lower edge of the confidence band as a % of full height
 *   bandHiPct       upper edge of the confidence band as a % of full height
 *
 * The four fill/ghost slices always sum to 100 (they tile the whole bar). Band edges
 * come from the INDEX band columns (durable_band_lo/hi); when either is missing, both
 * band percentages collapse onto the index so the caller can skip the error zone.
 */
export interface Zone2BarGeometry {
  durableFillPct: number
  durableGhostPct: number
  fastFillPct: number
  fastGhostPct: number
  indexValue: number
  bandLoPct: number
  bandHiPct: number
  hasBand: boolean
}

export function zone2BarGeometry(
  row: Pick<Zone2Fitness, 'durable_base' | 'sharpness' | 'durable_band_lo' | 'durable_band_hi'>,
  durableCeiling: number,
  fastCeiling: number
): Zone2BarGeometry {
  const total = durableCeiling + fastCeiling
  // Guard against a degenerate ceiling config (never happens in prod, but keeps the
  // percentages finite for tests / bad params).
  const toPct = (v: number): number => (total > 0 ? (v / total) * 100 : 0)

  const d = clamp(row.durable_base ?? 0, 0, durableCeiling)
  const f = clamp(row.sharpness ?? 0, 0, fastCeiling)
  const indexValue = clamp(d + f, 0, total)

  const durableFillPct = toPct(d)
  const durableGhostPct = toPct(durableCeiling - d)
  const fastFillPct = toPct(f)
  const fastGhostPct = toPct(fastCeiling - f)

  const lo = row.durable_band_lo
  const hi = row.durable_band_hi
  const hasBand = lo != null && hi != null && Number.isFinite(lo) && Number.isFinite(hi)
  // Band edges are the INDEX band, clamped to the bar and ordered lo ≤ hi even if the
  // stored columns are inverted. Absent band → collapse both edges onto the index.
  const bandLoRaw = hasBand ? clamp(Math.min(lo as number, hi as number), 0, total) : indexValue
  const bandHiRaw = hasBand ? clamp(Math.max(lo as number, hi as number), 0, total) : indexValue

  return {
    durableFillPct,
    durableGhostPct,
    fastFillPct,
    fastGhostPct,
    indexValue,
    bandLoPct: toPct(bandLoRaw),
    bandHiPct: toPct(bandHiRaw),
    hasBand
  }
}

/**
 * Half-width of the INDEX confidence band for the "±N" caption on the headline number
 * (v2: the band is on the index D+F, stored in durable_band_lo/hi). Returns null when
 * the band is unavailable. Never negative.
 */
export function indexBandHalfWidth(
  row: Pick<Zone2Fitness, 'durable_band_lo' | 'durable_band_hi'>
): number | null {
  const { durable_band_lo: lo, durable_band_hi: hi } = row
  if (lo == null || hi == null) return null
  const half = Math.abs(hi - lo) / 2
  if (!Number.isFinite(half)) return null
  return Math.max(0, Math.round(half))
}

/** The headline index = durable_base + sharpness (D + F), or null when either is missing. */
export function zone2IndexValue(
  row: Pick<Zone2Fitness, 'durable_base' | 'sharpness'>
): number | null {
  if (row.durable_base == null && row.sharpness == null) return null
  return (row.durable_base ?? 0) + (row.sharpness ?? 0)
}

/**
 * The latest row by calendar date. Rows may arrive unsorted; ties broken by
 * `computed_at` when present. Returns null for an empty array.
 */
export function latestZone2Row(rows: Zone2Fitness[]): Zone2Fitness | null {
  if (rows.length === 0) return null
  let best = rows[0]
  for (const r of rows) {
    if (r.date > best.date) {
      best = r
    } else if (r.date === best.date) {
      // Same date: prefer the more recently computed row.
      const a = r.computed_at ?? ''
      const b = best.computed_at ?? ''
      if (a > b) best = r
    }
  }
  return best
}

/**
 * The half-width of the confidence band, rounded, for the "±N" caption. Derived
 * from durable_band_lo/hi around durable_base. Returns null when the band or the
 * base is unavailable. Never negative.
 */
export function durableBandHalfWidth(row: Zone2Fitness): number | null {
  const { durable_band_lo: lo, durable_band_hi: hi } = row
  if (lo == null || hi == null) return null
  const half = (hi - lo) / 2
  if (!Number.isFinite(half)) return null
  return Math.max(0, Math.round(half))
}

/** Human label for the personalization stage pill (spec §7). */
export function stageLabel(stage: Zone2Stage, episodes?: number | null): string {
  switch (stage) {
    case 'personalized':
      return 'Personalized'
    case 'lightly_tuned':
      return episodes && episodes > 0
        ? `Lightly tuned (${episodes} episode${episodes === 1 ? '' : 's'})`
        : 'Lightly tuned'
    case 'literature':
    default:
      return 'Literature estimate'
  }
}

/**
 * Sub-caption for the "±N · <stage>" line under the hero digit. Combines the band
 * half-width with the stage label so a glance shows both the spread and the honesty
 * tier. When the band is unknown, only the stage is shown.
 */
export function durableBandCaption(row: Zone2Fitness, episodes?: number | null): string {
  const half = durableBandHalfWidth(row)
  const stage = stageLabel(row.stage, episodes)
  return half == null ? stage : `±${half} · ${stage}`
}

/** Whether the latest row carries a zone2_maintenance flag (drives the nudge + at-risk chip). */
export function hasMaintenanceFlag(row: Zone2Fitness | null | undefined): boolean {
  if (!row || !row.flags) return false
  return row.flags.some((f) => f.type === 'zone2_maintenance')
}

/** The zone2_maintenance flag's message, if present (spec §5c copy lives on the row). */
export function maintenanceMessage(row: Zone2Fitness | null | undefined): string | null {
  if (!row || !row.flags) return null
  const flag = row.flags.find((f) => f.type === 'zone2_maintenance')
  return flag?.message ?? null
}

/** Plain-language reason for a non-ok evidence state, for the greyed-hero caption (spec §10.4). */
export function evidenceReason(state: Zone2EvidenceState): string | null {
  switch (state) {
    case 'insufficient':
      return 'Not enough valid sensor days yet to place a level — showing your last known value.'
    case 'ambiguous':
      return 'Signals disagree (likely a technique or modality-specific move) — holding the level until they corroborate.'
    case 'low_confidence':
      return 'Only your watch VO2max moved — holding until RHR/EF corroborate.'
    case 'ok':
    default:
      return null
  }
}

export interface ProjectionPoint {
  /** "YYYY-MM-DD" calendar date. */
  date: string
  /** Historical durable_base (null on projected points). */
  durable: number | null
  /** Historical sharpness (null on projected points). */
  sharpness: number | null
  /** Projected durable_base decaying toward floor (null on historical points except the seam). */
  durableProjected: number | null
  /** Projected sharpness decaying toward 0 (null on historical points except the seam). */
  sharpnessProjected: number | null
  /** True for the dotted "projected if you stop" tail. */
  projected: boolean
}

/** Add N days to a "YYYY-MM-DD" key using UTC arithmetic (DST-safe, calendar-only). */
function addDaysKey(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  const yy = dt.getUTCFullYear().toString().padStart(4, '0')
  const mm = (dt.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = dt.getUTCDate().toString().padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * Build the mini-strip series: the historical durable_base + sharpness over the
 * window, then a dotted projection tail extending `projectionDays` days from the
 * latest row assuming no qualifying session is logged (spec §10.3).
 *
 * Projection math (simple exponentials, per spec §10.3):
 *   sharpness(t) = floor 0 with τ_fast=14  → S·exp(-Δ/14)
 *   durable(t)   = floor_score with τ_slow  → floor + (D-floor)·exp(-Δ/τ_slow)
 *
 * The seam day (the latest historical row) is duplicated onto the projected
 * fields so the dotted line visually connects to the solid line.
 */
export function zone2ProjectionSeries(
  rows: Zone2Fitness[],
  projectionDays = 21
): ProjectionPoint[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  const points: ProjectionPoint[] = sorted.map((r) => ({
    date: r.date,
    durable: r.durable_base,
    sharpness: r.sharpness,
    durableProjected: null,
    sharpnessProjected: null,
    projected: false
  }))

  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null
  if (!latest || latest.durable_base == null || latest.sharpness == null) {
    return points
  }

  // Seam: connect the dotted tail to the last solid point.
  const seam = points[points.length - 1]
  seam.durableProjected = latest.durable_base
  seam.sharpnessProjected = latest.sharpness

  const floor = latest.floor_score ?? 0
  const tauSlow = latest.tau_slow_days && latest.tau_slow_days > 0 ? latest.tau_slow_days : 45
  const d0 = latest.durable_base
  const s0 = latest.sharpness

  for (let day = 1; day <= projectionDays; day++) {
    const durable = floor + (d0 - floor) * Math.exp(-day / tauSlow)
    const sharpness = s0 * Math.exp(-day / TAU_FAST_DAYS)
    points.push({
      date: addDaysKey(latest.date, day),
      durable: null,
      sharpness: null,
      durableProjected: Math.round(durable * 10) / 10,
      sharpnessProjected: Math.round(sharpness * 10) / 10,
      projected: true
    })
  }

  return points
}

/** Small sparkline series (last N sharpness values, oldest→newest) for the companion card. */
export function sharpnessSparkline(rows: Zone2Fitness[], count = 30): { i: number; value: number }[] {
  return [...rows]
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((r) => r.sharpness != null)
    .slice(-count)
    .map((r, i) => ({ i, value: r.sharpness as number }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar coaching guidance — the "calendar is the coach" model.
//
// From the latest zone2 row's decay window (warn_after_days) plus the user's
// recent Zone-2 session history we place three forward-looking dates on the month
// grid so the calendar answers "when do I train next?" at a glance:
//
//   buildBy    — the next session to keep the durable level CLIMBING (~every 2–3 d).
//   maintainBy — the latest day to train to HOLD the level (the day before decay).
//   decayFrom  — the day the index begins to erode without a session.
//
// v1 date math (deliberately simple, spec'd in the task):
//   lastSession = max(sessionDates)              (undefined ⇒ stale-forever branch)
//   buildBy     = max(today, lastSession + 3d)
//   decayFrom   = max(today + 1, lastSession + warn_after_days)   (warn_after_days ⇒ 9 default)
//   maintainBy  = decayFrom − 1d
//
// All dates are plain "YYYY-MM-DD" keys; arithmetic is UTC-anchored (DST-safe).
// ─────────────────────────────────────────────────────────────────────────────

/** Fallback decay window (days) when the row carries no warn_after_days — the tight
 *  thin-base window from spec §5b (B<0.33 ⇒ 9 d). */
export const DEFAULT_WARN_AFTER_DAYS = 9

export type Zone2MarkerKind = 'build' | 'maintain' | 'decay'

export interface Zone2CalendarMarker {
  kind: Zone2MarkerKind
  /** Accessible title / tooltip for the annotated day cell. */
  label: string
}

export interface Zone2GuidanceDoses {
  build: string
  maintain: string
}

export interface Zone2CalendarGuidance {
  /** Next-session-to-keep-building date ("YYYY-MM-DD"). */
  buildBy: string
  /** Latest-day-to-hold date ("YYYY-MM-DD"). */
  maintainBy: string
  /** First-day-of-erosion date ("YYYY-MM-DD"). */
  decayFrom: string
  /** The most-recent Zone-2 session date used ("YYYY-MM-DD"), or null when none. */
  lastSession: string | null
  /** Trailing-7-day session count ending at `today`. */
  sessions7d: number
  /** One-line actionable summary with real weekday/date formatting. */
  summary: string
  /** Suggested-dose copy for the build and maintain markers. */
  doses: Zone2GuidanceDoses
  /** Marker record keyed by "YYYY-MM-DD" — pass straight to CalendarHeatmap `markers`. */
  markers: Record<string, Zone2CalendarMarker>
}

/** Suggested-dose copy (fixed strings from the task spec). */
export const ZONE2_BUILD_DOSE = 'Build · 3–4 Zone 2 sessions/wk, ~40–50 min at Zone 2 HR.'
export const ZONE2_MAINTAIN_DOSE = 'Maintain · 2 Zone 2 sessions/wk, ≥20 min at Zone 2 intensity.'

/** Compare two "YYYY-MM-DD" keys; returns the later one. */
function maxKey(a: string, b: string): string {
  return a >= b ? a : b
}

/** Count session dates within the trailing 7 days ending (inclusive) at `today`. */
function trailing7Count(sessionDates: string[], today: string): number {
  const lo = addDaysKey(today, -6) // 7-day window inclusive of today
  return sessionDates.filter((d) => d >= lo && d <= today).length
}

/** "Sat 12 Jul" style label for a date key (weekday + day + short month, no locale deps). */
export function formatGuidanceDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()]
  const month = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ][dt.getUTCMonth()]
  return `${weekday} ${d} ${month}`
}

/**
 * Forward-looking Zone-2 coaching dates from the model + session history.
 * PURE — fixed `today`, deterministic. See the block comment above for the math.
 *
 * `sessionDates` are Zone-2 session day keys ("YYYY-MM-DD"), any order, dupes ok.
 * `today` is the reference "YYYY-MM-DD" (never mutated).
 */
export function zone2CalendarGuidance(
  row: Pick<Zone2Fitness, 'warn_after_days' | 'maintenance_met'> | null | undefined,
  sessionDates: string[],
  today: string
): Zone2CalendarGuidance {
  const warnAfter =
    row && row.warn_after_days != null && row.warn_after_days > 0
      ? Math.round(row.warn_after_days)
      : DEFAULT_WARN_AFTER_DAYS

  // Most-recent session date (clamp anything in the future to at most today so a
  // stray future-dated row can't push the window out).
  let lastSession: string | null = null
  for (const raw of sessionDates) {
    if (!raw) continue
    const d = raw > today ? today : raw
    if (lastSession == null || d > lastSession) lastSession = d
  }

  const sessions7d = trailing7Count(sessionDates, today)

  // Base the cadence on the last session; with none on record, treat "today" as
  // the anchor so every marker lands from today forward (nothing in the past).
  const anchor = lastSession ?? today

  const buildBy = maxKey(today, addDaysKey(anchor, 3))
  const decayFrom = maxKey(addDaysKey(today, 1), addDaysKey(anchor, warnAfter))
  const maintainBy = addDaysKey(decayFrom, -1)

  const doses: Zone2GuidanceDoses = { build: ZONE2_BUILD_DOSE, maintain: ZONE2_MAINTAIN_DOSE }

  // Build the marker record. maintainBy and decayFrom are always distinct (decay =
  // maintain + 1d). buildBy can coincide with maintainBy; when it does, the build
  // marker wins (the more actionable "keep climbing" call).
  const markers: Record<string, Zone2CalendarMarker> = {}
  markers[decayFrom] = {
    kind: 'decay',
    label: `Eases from ${formatGuidanceDate(decayFrom)} — index starts to erode without a Zone 2 session.`
  }
  markers[maintainBy] = {
    kind: 'maintain',
    label: `Hold by ${formatGuidanceDate(maintainBy)} — ${ZONE2_MAINTAIN_DOSE}`
  }
  markers[buildBy] = {
    kind: 'build',
    label: `Build by ${formatGuidanceDate(buildBy)} — ${ZONE2_BUILD_DOSE}`
  }

  const summary =
    `Train by ${formatGuidanceDate(buildBy)} to keep building` +
    ` · holds through ${formatGuidanceDate(maintainBy)}` +
    ` · eases from ${formatGuidanceDate(decayFrom)}.`

  return { buildBy, maintainBy, decayFrom, lastSession, sessions7d, summary, doses, markers }
}
