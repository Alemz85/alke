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

export interface Zone2TrajectorySnapshot {
  start: { date: string; value: number }
  now: { date: string; value: number }
  change: number
  sinceLabel: string
  currentBand: { lo: number; hi: number } | null
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

/**
 * The trajectory's always-visible summary, derived independently from its chart.
 * Rows are sorted because the API contract does not promise ordering; same-day
 * recomputations use the newest `computed_at`, matching latestZone2Row.
 */
export function zone2TrajectorySnapshot(rows: Zone2Fitness[]): Zone2TrajectorySnapshot | null {
  const valid = rows
    .map((row) => ({ row, value: zone2IndexValue(row) }))
    .filter(
      (entry): entry is { row: Zone2Fitness; value: number } =>
        entry.value != null && Number.isFinite(entry.value)
    )
    .sort((a, b) =>
      a.row.date === b.row.date
        ? (a.row.computed_at ?? '').localeCompare(b.row.computed_at ?? '')
        : a.row.date.localeCompare(b.row.date)
    )

  if (valid.length === 0) return null

  const start = valid[0]
  const now = valid[valid.length - 1]
  const lo = now.row.durable_band_lo
  const hi = now.row.durable_band_hi
  const currentBand =
    lo != null && hi != null && Number.isFinite(lo) && Number.isFinite(hi)
      ? { lo: Math.min(lo, hi), hi: Math.max(lo, hi) }
      : null
  const monthIndex = Number(start.row.date.slice(5, 7)) - 1

  return {
    start: { date: start.row.date, value: start.value },
    now: { date: now.row.date, value: now.value },
    change: now.value - start.value,
    sinceLabel: SHORT_MONTHS[monthIndex] ?? start.row.date.slice(5, 7),
    currentBand
  }
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
//   BUILD WINDOW — the literal interval from 24h through 48h after the LAST
//     SESSION timestamp. It is never clamped forward: an elapsed window stays on
//     the dates when it actually occurred, while copy reports that it is overdue.
//     build_interval_days still supplies the model-derived dose copy, but does
//     not redefine a UI band labelled "24–48h".
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
  /** Calendar dates intersecting the literal +24h to +48h window after the last
   *  qualifying session. Null without both a session timestamp and stored cadence. */
  buildWindow: { start: string; end: string } | null
  /** True once the literal +48h build window has closed. */
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
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ][dt.getUTCMonth()]
  return `${weekday} ${d} ${month}`
}

/** Build cadence copy from build_interval_days: "a Zone 2 session every ~N days
 *  (≈X/wk)". N/X trace to the stored cadence — never a hardcoded dose. */
function buildDoseCopy(buildIntervalDays: number): string {
  const n = Math.max(1, Math.round(buildIntervalDays))
  const perWeek = 7 / n
  const perWeekLabel =
    perWeek >= 1 ? Math.round(perWeek * 10) / 10 : Math.round(perWeek * 100) / 100
  return `Build · a Zone 2 session every ~${n} day${n === 1 ? '' : 's'} (≈${perWeekLabel}/wk) at Zone 2 intensity.`
}

/**
 * Zone-2 coaching dates from the model's stored erosion horizons plus exact
 * session history. PURE when `nowIso` is supplied.
 *
 * The build marker is the literal +24h to +48h interval after the latest Zone 2
 * workout. Erosion and hold markers trace to their model horizon columns and
 * remain anchored at the model row date.
 *
 * `sessionStarts` are ISO workout timestamps, any order, duplicates tolerated.
 * Date-only values remain accepted for older callers and tests. `today` is the
 * reference local date key; `timezone` controls calendar projection.
 */
export function zone2CalendarGuidance(
  row:
    | Pick<
        Zone2Fitness,
        'date' | 'warn_after_days' | 'maintain_horizon_days' | 'build_interval_days'
      >
    | null
    | undefined,
  sessionStarts: string[],
  today: string,
  timezone = 'UTC',
  nowIso?: string
): Zone2CalendarGuidance {
  const fallbackNow = Date.parse(`${today}T23:59:59.999Z`)
  const parsedNow = nowIso ? Date.parse(nowIso) : fallbackNow
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : fallbackNow

  const localKey = (timestampMs: number): string => {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date(timestampMs))
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? ''
      return `${part('year')}-${part('month')}-${part('day')}`
    } catch {
      return new Date(timestampMs).toISOString().slice(0, 10)
    }
  }

  // Date-only values remain supported for deterministic tests/legacy callers;
  // production passes full workout instants. Noon avoids accidental day shifts.
  const parseStart = (raw: string): number =>
    Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00.000Z` : raw)

  const validStarts = sessionStarts
    .map(parseStart)
    .filter((value) => Number.isFinite(value) && value <= nowMs)
  const sessionDates = validStarts.map(localKey)

  // Most-recent real session instant. Future-dated rows are ignored rather than
  // coerced onto today, so bad source data cannot invent a current anchor.
  let lastSessionAt: number | null = null
  let lastSession: string | null = null
  for (const start of validStarts) {
    if (lastSessionAt == null || start > lastSessionAt) lastSessionAt = start
  }
  if (lastSessionAt != null) lastSession = localKey(lastSessionAt)

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

  // ── BUILD WINDOW. Literal [last session + 24h, last session + 48h), projected
  // onto every local calendar day it intersects. The half-open end prevents a
  // window closing exactly at midnight from incorrectly marking the next day. ──
  const cadence =
    row.build_interval_days != null && Number.isFinite(row.build_interval_days)
      ? Math.max(0, row.build_interval_days)
      : null
  const buildDose = cadence != null ? buildDoseCopy(cadence as number) : null
  let buildWindow: { start: string; end: string } | null = null
  let buildOverdue = false
  if (cadence != null && lastSessionAt != null) {
    const windowStartMs = lastSessionAt + 24 * 60 * 60 * 1000
    const windowEndMs = lastSessionAt + 48 * 60 * 60 * 1000
    buildOverdue = nowMs >= windowEndMs
    const start = localKey(windowStartMs)
    const end = localKey(windowEndMs - 1)
    buildWindow = { start, end }
    const range = `${formatGuidanceDate(start)}–${formatGuidanceDate(end)}`
    const label = buildOverdue
      ? `Due now — train today to keep building. ${buildDose ?? ''}`.trim()
      : `Build window · train ${range} to keep building. ${buildDose ?? ''}`.trim()
    let markerDate = start
    while (markerDate <= end) {
      markers[markerDate] = { kind: 'build', label }
      markerDate = addDaysKey(markerDate, 1)
    }
  }

  // ── PHASE. warn_after_days (the durable-erosion-vs-band "eases" horizon) is
  // null whenever the base is too thin to erode by a confidence band — the
  // BUILDING phase, where only the build window is shown. A present horizon means
  // a base worth protecting: the MAINTENANCE phase adds eases + hold markers,
  // anchored at the ROW date (from-today projections). ──
  const maintenance = row.warn_after_days != null && Number.isFinite(row.warn_after_days)
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
