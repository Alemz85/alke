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
 * Two independent component METERS (v4 "two bars" layout). The confusing single
 * stacked two-zone bar (durable bottom, fast top, ghosted headroom, a 70-divider)
 * is replaced by two plain horizontal fill meters, each measured against its OWN
 * ceiling — so "how full is my durable base" and "how full is my recent form" each
 * read at a glance. The headline INDEX (durable + fast) stays the one hero number
 * above them; these bars are its composition.
 *
 *   durableValue  rounded durable_base, clamped to [0, C_D]
 *   durablePct    durable_base / C_D as a percentage (bar fill width)
 *   fastValue     rounded sharpness, clamped to [0, C_F]
 *   fastPct       sharpness / C_F as a percentage (bar fill width)
 */
export interface Zone2Meters {
  durableValue: number
  durablePct: number
  fastValue: number
  fastPct: number
}

export function zone2Meters(
  row: Pick<Zone2Fitness, 'durable_base' | 'sharpness'>,
  durableCeiling: number,
  fastCeiling: number
): Zone2Meters {
  const d = clamp(row.durable_base ?? 0, 0, durableCeiling)
  const f = clamp(row.sharpness ?? 0, 0, fastCeiling)
  return {
    durableValue: Math.round(d),
    durablePct: durableCeiling > 0 ? (d / durableCeiling) * 100 : 0,
    fastValue: Math.round(f),
    fastPct: fastCeiling > 0 ? (f / fastCeiling) * 100 : 0
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
// Calendar coaching guidance — the "calendar is the coach" model (docs v4).
//
// Two kinds of horizon, anchored differently because they answer different
// questions (this is the fix for the build marker landing 2 days late and the
// "eases" marker being loud-when-fresh / silent-when-detrained):
//
//   BUILD WINDOW — a session-to-session CADENCE, so it is anchored at the LAST
//     SESSION + row.build_interval_days (the B-scaled cadence the job stored).
//     Anchoring at the row date would forgive the days already elapsed since the
//     last session and permit a gap of twice the cadence. Rendered as a 2-day
//     band (the 24–48h build window), clamped forward so it is never in the past;
//     if the deadline has passed, the window is today→tomorrow and copy says due.
//
//   EASES / HOLD — FROM-TODAY durable-erosion projections, so they anchor at the
//     ROW date (its state already embeds the gap). They appear ONLY in the
//     maintenance phase: `warn_after_days` is null whenever the base is too thin
//     to erode by a confidence band, and in that (building) phase the calendar
//     shows the build window alone — "nothing banked to protect yet, just build".
//
// A null horizon column omits its marker; the renderer never invents a fallback
// offset. All dates are "YYYY-MM-DD"; arithmetic is UTC-anchored (DST-safe);
// interval math stays fractional and is rounded once, at addDaysKey.
// ─────────────────────────────────────────────────────────────────────────────

export type Zone2MarkerKind = 'build' | 'maintain' | 'decay'

export interface Zone2CalendarMarker {
  kind: Zone2MarkerKind
  /** Accessible title / tooltip for the annotated day cell. */
  label: string
}

/**
 * Which coaching story the calendar tells (docs v4 amendment):
 *  - 'building'     — the durable base is too thin to erode by a confidence band
 *                     (`warn_after_days` is null). There is nothing banked to
 *                     protect yet, so ONLY the build window is shown.
 *  - 'maintenance'  — a base worth protecting exists; the erosion ("eases") and
 *                     hold markers become meaningful and are shown alongside build.
 *  - 'unknown'      — no row yet.
 */
export type Zone2Phase = 'building' | 'maintenance' | 'unknown'

export interface Zone2CalendarGuidance {
  phase: Zone2Phase
  /** The 2-day build WINDOW (the 24–48h cadence band), anchored at the last
   *  session + the stored cadence and clamped forward so it is never in the past.
   *  Null when there is no cadence to place. */
  buildWindow: { start: string; end: string } | null
  /** True when the build-cadence deadline is already due/overdue (train now). */
  buildOverdue: boolean
  /** Maintenance phase only: first day the durable base erodes past the band
   *  ("YYYY-MM-DD"), else null. Anchored at the ROW date (a from-today projection). */
  easesFrom: string | null
  /** Maintenance phase only: last day one session still holds today's level. */
  holdBy: string | null
  /** The most-recent Zone-2 session date used for copy/anchor ("YYYY-MM-DD"), or null. */
  lastSession: string | null
  /** Trailing-7-day session count ending at `today`. */
  sessions7d: number
  /** One-line actionable summary with real weekday/date formatting. */
  summary: string
  /** Build-cadence dose copy (derived from build_interval_days), or null when absent. */
  buildDose: string | null
  /** Marker record keyed by "YYYY-MM-DD" — pass straight to CalendarHeatmap `markers`.
   *  On a same-day collision the build markers win (most actionable). */
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
  const markers: Record<string, Zone2CalendarMarker> = {}

  const empty = (summary: string): Zone2CalendarGuidance => ({
    phase: 'unknown',
    buildWindow: null,
    buildOverdue: false,
    easesFrom: null,
    holdBy: null,
    lastSession,
    sessions7d,
    summary,
    buildDose: null,
    markers
  })

  if (!row) return empty('Not enough data yet to place a build window.')

  // ── BUILD WINDOW (a 2-day 24–48h band). The stored cadence is a
  // session-to-session interval, so it is anchored at the LAST SESSION (falling
  // back to today when none is on record). Clamped forward: the window always
  // ends at least tomorrow and never starts in the past. ──
  const cadence =
    row.build_interval_days != null && Number.isFinite(row.build_interval_days)
      ? Math.max(0, row.build_interval_days)
      : null
  const buildDose = cadence != null ? buildDoseCopy(cadence as number) : null
  let buildWindow: { start: string; end: string } | null = null
  let buildOverdue = false
  if (cadence != null) {
    const anchor = lastSession ?? today
    const dueRaw = addDaysKey(anchor, cadence) // fractional deadline, rounded to a day
    buildOverdue = dueRaw <= today
    const end = maxKey(addDaysKey(today, 1), dueRaw) // deadline, at least tomorrow
    const start = maxKey(today, addDaysKey(end, -1)) // 2-day window, never before today
    buildWindow = { start, end }
    const range = `${formatGuidanceDate(start)}–${formatGuidanceDate(end)}`
    const label = buildOverdue
      ? `Due now — train today to keep building. ${buildDose ?? ''}`.trim()
      : `Build window · train ${range} to keep building. ${buildDose ?? ''}`.trim()
    // Both cells carry the build marker (the whole band is "on-cadence").
    markers[start] = { kind: 'build', label }
    markers[end] = { kind: 'build', label }
  }

  // ── PHASE. warn_after_days (the durable-erosion-vs-band "eases" horizon) is
  // null whenever the base is too thin to erode by a confidence band — the
  // BUILDING phase, where only the build window is shown. A present horizon means
  // a base worth protecting: the MAINTENANCE phase adds eases + hold markers,
  // anchored at the ROW date (from-today projections). ──
  const maintenance =
    row.warn_after_days != null && Number.isFinite(row.warn_after_days)
  const phase: Zone2Phase = maintenance ? 'maintenance' : 'building'

  let easesFrom: string | null = null
  let holdBy: string | null = null
  if (maintenance) {
    easesFrom = maxKey(addDaysKey(row.date, row.warn_after_days as number), today)
    if (!(easesFrom in markers)) {
      markers[easesFrom] = {
        kind: 'decay',
        label: `Base eases from ${formatGuidanceDate(easesFrom)} — it starts to erode without a Zone 2 session.`
      }
    }
    if (row.maintain_horizon_days != null && Number.isFinite(row.maintain_horizon_days)) {
      holdBy = maxKey(addDaysKey(row.date, row.maintain_horizon_days), today)
      if (!(holdBy in markers)) {
        markers[holdBy] = {
          kind: 'maintain',
          label: `Hold by ${formatGuidanceDate(holdBy)} — ${ZONE2_MAINTAIN_DOSE}`
        }
      }
    }
  }

  // ── Summary. Building phase leads with "just build"; maintenance phase chains
  // the build/hold/eases dates. ──
  const windowPhrase = buildWindow
    ? buildOverdue
      ? 'train now'
      : `train ${formatGuidanceDate(buildWindow.start)}–${formatGuidanceDate(buildWindow.end)}`
    : null
  let summary: string
  if (phase === 'building') {
    summary = windowPhrase
      ? `Base still thin — just build. ${windowPhrase[0].toUpperCase()}${windowPhrase.slice(1)} to keep climbing.`
      : 'Base still thin — keep building.'
  } else {
    const parts: string[] = []
    if (windowPhrase) parts.push(`build window: ${windowPhrase}`)
    if (holdBy) parts.push(`holds through ${formatGuidanceDate(holdBy)}`)
    if (easesFrom) parts.push(`base eases from ${formatGuidanceDate(easesFrom)}`)
    summary = parts.length > 0 ? `${parts.join(' · ')}.` : 'Keep training to hold your base.'
  }

  return {
    phase,
    buildWindow,
    buildOverdue,
    easesFrom,
    holdBy,
    lastSession,
    sessions7d,
    summary,
    buildDose,
    markers
  }
}

/** Compare two "YYYY-MM-DD" keys; returns the later one. */
function maxKey(a: string, b: string): string {
  return a >= b ? a : b
}
