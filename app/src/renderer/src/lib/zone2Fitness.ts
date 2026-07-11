// Pure presentation logic for the Zone-2 fitness model UX (docs/zone2-fitness-model.md §10).
// Kept out of the React view so the band formatting, latest-row selection, and the
// calendar coaching-guidance placement are unit-testable in isolation. No React, no DOM.
// The nightly job derives every projection/horizon; this file only formats and places them.
import type { Zone2EvidenceState, Zone2Fitness, Zone2Stage } from '@shared/types'

/** τ_fast for the sharpness compartment (days). Locked physiological constant, spec §2a. */
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
 * Half-width of a lo/hi band, rounded, for a "±N" caption. Order-insensitive
 * (abs of the span) and never negative. Shared by both band callers
 * (index band + durable band) so they can't disagree on inverted columns.
 */
function bandHalfWidth(lo: number | null, hi: number | null): number | null {
  if (lo == null || hi == null) return null
  const half = Math.abs(hi - lo) / 2
  if (!Number.isFinite(half)) return null
  return Math.max(0, Math.round(half))
}

/**
 * Half-width of the INDEX confidence band for the "±N" caption on the headline number
 * (v2: the band is on the index D+F, stored in durable_band_lo/hi). Returns null when
 * the band is unavailable. Never negative.
 */
export function indexBandHalfWidth(
  row: Pick<Zone2Fitness, 'durable_band_lo' | 'durable_band_hi'>
): number | null {
  return bandHalfWidth(row.durable_band_lo, row.durable_band_hi)
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
  return bandHalfWidth(row.durable_band_lo, row.durable_band_hi)
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

/** Add N days to a "YYYY-MM-DD" key using UTC arithmetic (DST-safe, calendar-only).
 *  `n` may be fractional (continuous interval math upstream) — rounded to the
 *  nearest whole day here, at the single point a date key is materialized. */
function addDaysKey(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + Math.round(n))
  const yy = dt.getUTCFullYear().toString().padStart(4, '0')
  const mm = (dt.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = dt.getUTCDate().toString().padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar coaching guidance — the "calendar is the coach" model.
//
// docs/zone2-fitness-model.md v3 amendment §6, as extended by the v3 renderer
// amendment: the nightly job now derives ALL guidance horizons — decay-onset
// (warn_after_days), the last day one session still holds the level
// (maintain_horizon_days), and the session cadence that nets a build
// (build_interval_days) — as continuous projections FROM THE LATEST ROW'S OWN
// DATE. The renderer's only job is to place them as calendar dates:
//
//   anchor     — the latest row's `date`. The row's state (and therefore every
//                horizon derived from it) already embeds any elapsed gap since
//                the last session, so the row date — NOT the last-session date
//                — is the correct zero-point for the projection.
//   decayFrom  — anchor + row.warn_after_days.
//   maintainBy — anchor + row.maintain_horizon_days.
//   buildBy    — anchor + row.build_interval_days.
//
// `lastSession` / `sessions7d` are kept for copy (recency context) but are
// NEVER used as an anchor for any marker date.
//
// A horizon column that is null (old rows, pre-migration) OMITS that marker
// entirely — the renderer never invents a fallback offset. A horizon of 0 (or
// a computed date at/before today) is valid data meaning "already easing /
// past the hold window"; it is shown honestly (marker clamped to display on
// today, copy says "now"/"already"), never silently pushed to tomorrow.
//
// All dates are plain "YYYY-MM-DD" keys; arithmetic is UTC-anchored (DST-safe).
// Interval math is kept fractional internally and only rounded once, at the
// point a date key is built (see addDaysKey).
// ─────────────────────────────────────────────────────────────────────────────

export type Zone2MarkerKind = 'build' | 'maintain' | 'decay'

export interface Zone2CalendarMarker {
  kind: Zone2MarkerKind
  /** Accessible title / tooltip for the annotated day cell. */
  label: string
}

export interface Zone2GuidanceDoses {
  /** Null when build_interval_days is unavailable (no marker, no dose to show). */
  build: string | null
  maintain: string
}

export interface Zone2CalendarGuidance {
  /** Next-session-to-keep-building date ("YYYY-MM-DD"), or null when build_interval_days is missing. */
  buildBy: string | null
  /** Latest-day-to-hold date ("YYYY-MM-DD"), or null when maintain_horizon_days is missing. */
  maintainBy: string | null
  /** First-day-of-erosion date ("YYYY-MM-DD"), or null when warn_after_days is missing. */
  decayFrom: string | null
  /** True when decayFrom lands at or before today — the index is already past its hold window. */
  alreadyEasing: boolean
  /** The most-recent Zone-2 session date used for copy ("YYYY-MM-DD"), or null when none. Never an anchor. */
  lastSession: string | null
  /** Trailing-7-day session count ending at `today`. */
  sessions7d: number
  /** One-line actionable summary with real weekday/date formatting. */
  summary: string
  /** Suggested-dose copy for the build and maintain markers. */
  doses: Zone2GuidanceDoses
  /** Marker record keyed by "YYYY-MM-DD" — pass straight to CalendarHeatmap `markers`. On a
   *  same-day collision only the highest-priority marker (build > maintain > decay) is kept. */
  markers: Record<string, Zone2CalendarMarker>
}

/** Maintenance dose copy — Hickson's 2/wk result licenses holding an existing
 *  base (spec §5a/§5b); this is a literature constant, not a derived horizon. */
export const ZONE2_MAINTAIN_DOSE =
  'Maintain · 2 Zone 2 sessions/wk, ≥20 min at Zone 2 intensity — for a base you’ve already built. Still building? The build cadence above is the priority.'

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

/** Build cadence copy from build_interval_days: "a Zone 2 session every ~N days
 *  (≈X/wk)". N/X trace to the stored cadence — never a hardcoded dose. */
function buildDoseCopy(buildIntervalDays: number): string {
  const n = Math.max(1, Math.round(buildIntervalDays))
  const perWeek = 7 / n
  const perWeekLabel = perWeek >= 1 ? Math.round(perWeek * 10) / 10 : Math.round(perWeek * 100) / 100
  return `Build · a Zone 2 session every ~${n} day${n === 1 ? '' : 's'} (≈${perWeekLabel}/wk) at Zone 2 intensity.`
}

/**
 * Forward-looking Zone-2 coaching dates from the model's own stored horizons +
 * session history (for copy only). PURE — fixed `today`, deterministic.
 *
 * Every marker date traces directly to a horizon column stored on the row
 * (warn_after_days / maintain_horizon_days / build_interval_days), anchored at
 * the ROW'S DATE. The renderer performs no projection math and reintroduces no
 * fixed offsets. A null horizon omits its marker; a horizon that resolves to
 * today-or-earlier is shown honestly as "already easing", clamped to today for
 * display only.
 *
 * `sessionDates` are Zone-2 session day keys ("YYYY-MM-DD"), any order, dupes ok
 * — used only for `lastSession`/`sessions7d` copy, never as an anchor.
 * `today` is the reference "YYYY-MM-DD" (never mutated).
 */
export function zone2CalendarGuidance(
  row:
    | Pick<Zone2Fitness, 'date' | 'warn_after_days' | 'maintain_horizon_days' | 'build_interval_days'>
    | null
    | undefined,
  sessionDates: string[],
  today: string
): Zone2CalendarGuidance {
  // Most-recent session date (clamp anything in the future to at most today so a
  // stray future-dated row can't push it out) — copy only, never an anchor.
  let lastSession: string | null = null
  for (const raw of sessionDates) {
    if (!raw) continue
    const d = raw > today ? today : raw
    if (lastSession == null || d > lastSession) lastSession = d
  }

  const sessions7d = trailing7Count(sessionDates, today)

  if (!row) {
    return {
      buildBy: null,
      maintainBy: null,
      decayFrom: null,
      alreadyEasing: false,
      lastSession,
      sessions7d,
      summary: 'Not enough data yet to place build/maintain/decay dates.',
      doses: { build: null, maintain: ZONE2_MAINTAIN_DOSE },
      markers: {}
    }
  }

  // The row's OWN date is the anchor — its state already embeds any elapsed
  // gap since the last session, so re-anchoring at lastSession would double
  // count that gap. See block comment above.
  const anchor = row.date

  // Each horizon is placed independently, from the SAME anchor; a missing
  // column omits its marker rather than inventing a fallback offset.
  const decayFromRaw =
    row.warn_after_days != null && Number.isFinite(row.warn_after_days)
      ? addDaysKey(anchor, row.warn_after_days)
      : null
  const maintainByRaw =
    row.maintain_horizon_days != null && Number.isFinite(row.maintain_horizon_days)
      ? addDaysKey(anchor, row.maintain_horizon_days)
      : null
  const buildByRaw =
    row.build_interval_days != null && Number.isFinite(row.build_interval_days)
      ? addDaysKey(anchor, row.build_interval_days)
      : null

  // Never render a marker in the past: clamp the DISPLAY date to today, but
  // track whether the raw (unclamped) horizon was already at/before today so
  // the copy can say so honestly instead of silently presenting a future date.
  const decayFrom = decayFromRaw != null ? maxKey(decayFromRaw, today) : null
  const maintainBy = maintainByRaw != null ? maxKey(maintainByRaw, today) : null
  const buildBy = buildByRaw != null ? maxKey(buildByRaw, today) : null
  const alreadyEasing = decayFromRaw != null && decayFromRaw <= today

  const buildDose = row.build_interval_days != null ? buildDoseCopy(row.build_interval_days) : null
  const doses: Zone2GuidanceDoses = { build: buildDose, maintain: ZONE2_MAINTAIN_DOSE }

  // Marker record: on a same-day collision, the most-actionable kind wins
  // (build > maintain > decay). Insert lowest priority first so higher
  // priority overwrites it.
  const markers: Record<string, Zone2CalendarMarker> = {}
  if (decayFrom != null) {
    markers[decayFrom] = {
      kind: 'decay',
      label: alreadyEasing
        ? `Easing now — the index is already past its hold window (from ${formatGuidanceDate(decayFromRaw as string)}).`
        : `Eases from ${formatGuidanceDate(decayFrom)} — index starts to erode without a Zone 2 session.`
    }
  }
  if (maintainBy != null) {
    markers[maintainBy] = {
      kind: 'maintain',
      label: `Hold by ${formatGuidanceDate(maintainBy)} — ${ZONE2_MAINTAIN_DOSE}`
    }
  }
  if (buildBy != null && buildDose != null) {
    markers[buildBy] = {
      kind: 'build',
      label: `Build by ${formatGuidanceDate(buildBy)} — ${buildDose}`
    }
  }

  const parts: string[] = []
  if (buildBy != null) parts.push(`Train by ${formatGuidanceDate(buildBy)} to keep building`)
  if (maintainBy != null) parts.push(`holds through ${formatGuidanceDate(maintainBy)}`)
  if (alreadyEasing) {
    parts.push('easing now — the index is already past its hold window')
  } else if (decayFrom != null) {
    parts.push(`eases from ${formatGuidanceDate(decayFrom)}`)
  }
  const summary = parts.length > 0 ? `${parts.join(' · ')}.` : 'Not enough data yet to place build/maintain/decay dates.'

  return { buildBy, maintainBy, decayFrom, alreadyEasing, lastSession, sessions7d, summary, doses, markers }
}

/** Compare two "YYYY-MM-DD" keys; returns the later one. */
function maxKey(a: string, b: string): string {
  return a >= b ? a : b
}
