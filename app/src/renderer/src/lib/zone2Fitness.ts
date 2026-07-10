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
// docs/zone2-fitness-model.md v3 amendment §6 ("Projection-derived guidance —
// replaces the warn_after_days band lookup and the maintainBy=decay−1 formula
// ENTIRELY"): every marker on the calendar must trace to a CONTINUOUS function
// of the model's current state. No fixed "+3", no "decay−1". The nightly job
// now derives `warn_after_days` itself as a continuous, projection-derived
// decay-onset horizon (the smallest t where the projected index eases by ≥SWC);
// the renderer's only job is to place markers from that horizon and from the
// fitness state that produced it — never to reintroduce a step function.
//
//   anchor     — the most recent Zone-2 session date, future-clamped to today
//                (or `today` itself when no session is on record).
//   decayFrom  — anchor + row.warn_after_days. This IS the model's derived
//                decay-onset horizon; the renderer does not adjust it further.
//   buildBy    — anchor + buildInterval(B). buildInterval is a continuous
//                function of base_accum_b (B) and the fast time constant
//                TAU_FAST_DAYS (the literature prior for how quickly a single
//                session's gain outpaces between-session fast-decay): tight for
//                a thin base (a beginner must stack sessions before the fast
//                layer decays back out), looser as the base banks. See
//                `zone2BuildIntervalDays` below for the exact formula.
//   maintainBy — anchor + maintInterval(B). maintInterval is a continuous
//                function BETWEEN buildInterval and the decay horizon — a
//                data-derived fraction of the decay window (the last day a
//                single session's build still holds the level before the
//                model's own projection says it eases). See
//                `zone2MaintainIntervalDays` below. Guaranteed
//                buildInterval <= maintInterval < warn_after_days so
//                buildBy <= maintainBy < decayFrom always holds.
//
// All dates are plain "YYYY-MM-DD" keys; arithmetic is UTC-anchored (DST-safe).
// Interval math is kept in fractional days internally (continuous in B and
// warn_after_days) and only rounded once, at the point a date key is built.
// ─────────────────────────────────────────────────────────────────────────────

/** Fallback decay window (days) when the row carries no warn_after_days — the tight
 *  thin-base end of the model's own projected range (spec v3 §6: a thin base decays
 *  at roughly tau_fast; this is a fallback only, never a band lookup in the live path). */
export const DEFAULT_WARN_AFTER_DAYS = 9

/**
 * Projected index drop I(0) − I(t) from a row's fitness state — the SAME
 * two-compartment projection the calendar trail draws (fast decays at
 * TAU_FAST_DAYS, durable toward its floor at tau_slow). Monotonic increasing in
 * t, so it inverts cleanly. This is the model's own dynamics, not a heuristic.
 */
type Zone2ProjectionState = Pick<
  Zone2Fitness,
  'durable_base' | 'sharpness' | 'floor_score' | 'tau_slow_days'
>

function projectedIndexDrop(row: Partial<Zone2ProjectionState>, t: number): number {
  const d0 = row.durable_base ?? 0
  const s0 = row.sharpness ?? 0
  const floor = row.floor_score ?? 0
  const tauSlow = row.tau_slow_days && row.tau_slow_days > 0 ? row.tau_slow_days : 45
  const i0 = d0 + s0
  const dT = floor + (d0 - floor) * Math.exp(-t / tauSlow)
  const sT = s0 * Math.exp(-t / TAU_FAST_DAYS)
  return i0 - (dT + sT)
}

/** Smallest horizon (days) at which the projected index has eased by ≥ target.
 *  Numerically inverts the monotonic projection (bisection) — grounded in the
 *  model's dynamics, never a fixed offset. */
function horizonForDrop(row: Partial<Zone2ProjectionState>, targetDrop: number, maxDays = 120): number {
  if (targetDrop <= 0) return 0
  if (projectedIndexDrop(row, maxDays) < targetDrop) return maxDays
  let lo = 0
  let hi = maxDays
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (projectedIndexDrop(row, mid) >= targetDrop) hi = mid
    else lo = mid
  }
  return hi
}

// Build and maintain are placed where the projected index has eased by a
// FRACTION of the drop that defines decay-onset (SWC, the horizon the model
// stored in warn_after_days) — so both invert the SAME projection and move with
// the fitness state and the projection's curvature, not a fixed multiple of the
// horizon in days. The fractions are the only constants: retrain well before a
// full worthwhile change accrues. 0.3 → build (stay ahead), 0.6 → maintain
// (last day a single session still holds the level). Ordered by construction
// (0.3 < 0.6 < 1 on a monotonic drop) → buildBy ≤ maintainBy < decayFrom.
const ZONE2_BUILD_DROP_FRACTION = 0.3
const ZONE2_MAINTAIN_DROP_FRACTION = 0.6

/**
 * Projection-derived build + maintenance intervals (days from the anchor), both
 * obtained by inverting the model's own index projection at fractions of the
 * decay-onset drop. When the state is degenerate (already at floor → no
 * meaningful projected drop), falls back to small fractions of the decay horizon
 * purely to keep the three markers ordered and finite.
 */
export function zone2GuidanceIntervals(
  row: Partial<Zone2ProjectionState> | null | undefined,
  warnAfterDays: number
): { buildInterval: number; maintInterval: number } {
  if (!row) {
    return { buildInterval: warnAfterDays * ZONE2_BUILD_DROP_FRACTION, maintInterval: warnAfterDays * ZONE2_MAINTAIN_DROP_FRACTION }
  }
  const dropAtDecay = projectedIndexDrop(row, warnAfterDays)
  if (!(dropAtDecay > 0)) {
    return { buildInterval: warnAfterDays * ZONE2_BUILD_DROP_FRACTION, maintInterval: warnAfterDays * ZONE2_MAINTAIN_DROP_FRACTION }
  }
  return {
    buildInterval: horizonForDrop(row, ZONE2_BUILD_DROP_FRACTION * dropAtDecay),
    maintInterval: horizonForDrop(row, ZONE2_MAINTAIN_DROP_FRACTION * dropAtDecay)
  }
}

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

/** Suggested-dose copy. Maintenance is a dose for a base that is already BUILT
 *  (Hickson's 2/wk result licenses holding an existing base, spec §5a/§5b) — for
 *  a beginner still building, the build cadence above is the priority; the
 *  maintain dose is what to switch to only once the base is banked. */
export const ZONE2_BUILD_DOSE = 'Build · 3–4 Zone 2 sessions/wk, ~40–50 min at Zone 2 HR.'
export const ZONE2_MAINTAIN_DOSE =
  'Maintain · 2 Zone 2 sessions/wk, ≥20 min at Zone 2 intensity — for a base you’ve already built. Still building? The build cadence above is the priority.'

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
 * All three markers trace to CONTINUOUS functions of the model state
 * (base_accum_b, warn_after_days) — no fixed offsets, no band lookups.
 *
 * `sessionDates` are Zone-2 session day keys ("YYYY-MM-DD"), any order, dupes ok.
 * `today` is the reference "YYYY-MM-DD" (never mutated).
 */
export function zone2CalendarGuidance(
  row:
    | (Pick<Zone2Fitness, 'warn_after_days' | 'maintenance_met' | 'base_accum_b'> & Partial<Zone2ProjectionState>)
    | null
    | undefined,
  sessionDates: string[],
  today: string
): Zone2CalendarGuidance {
  // warn_after_days is now the model's own continuous, projection-derived
  // decay-onset horizon (docs/zone2-fitness-model.md v3 §6) — used as-is, never
  // rounded into a band. The fallback only covers a genuinely missing row.
  const warnAfter =
    row && row.warn_after_days != null && row.warn_after_days > 0 ? row.warn_after_days : DEFAULT_WARN_AFTER_DAYS

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

  // Build/maintain intervals derived by inverting the model's own index
  // projection at fractions of the decay-onset drop (see zone2GuidanceIntervals
  // + horizonForDrop above). buildInterval <= maintInterval < warnAfter by
  // construction, so buildBy <= maintainBy < decayFrom holds before any
  // today-clamping below.
  const { buildInterval, maintInterval } = zone2GuidanceIntervals(row, warnAfter)

  const decayFrom = maxKey(addDaysKey(today, 1), addDaysKey(anchor, warnAfter))
  const maintainByRaw = maxKey(today, addDaysKey(anchor, maintInterval))
  const buildByRaw = maxKey(today, addDaysKey(anchor, buildInterval))

  // The today-clamp above can independently pull maintainBy/buildBy up to
  // `today`, which could — only in the stale-session branch, where both floor
  // to the same day — invert the pre-clamp ordering relative to decayFrom.
  // Re-assert the invariant post-clamp: buildBy <= maintainBy < decayFrom.
  const maintainBy = maxKey(buildByRaw, maintainByRaw) >= decayFrom ? addDaysKey(decayFrom, -1) : maintainByRaw
  const buildBy = buildByRaw >= maintainBy ? maintainBy : buildByRaw

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
