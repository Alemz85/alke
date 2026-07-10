// Pure, testable analytics for the Injuries tab.
//
// Every function takes an explicit `now: Date` or `todayYMD: string` — there is
// no Date.now() inside, so the whole module is deterministic and testable
// without the DOM or window.api. Dates are handled as YYYY-MM-DD strings and
// compared lexicographically (ISO dates sort chronologically as text), with a
// small UTC-noon Date helper for arithmetic that must not drift across DST.

import type { InjuryLogEntry, PlanItemCheck, RecoveryPlanItem } from '@shared/types'

// ── date primitives ─────────────────────────────────────────────────────────
// All parsing pins to UTC noon so day arithmetic never lands on a DST boundary.

/** Parse a YYYY-MM-DD (or ISO datetime) into a UTC-noon Date. */
function parseYMD(s: string): Date {
  const ymd = s.slice(0, 10)
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0))
}

/** Format a Date back to YYYY-MM-DD in UTC. */
function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** The YYYY-MM-DD part of an entry (entry_date is already a date string). */
function entryYMD(e: InjuryLogEntry): string {
  return e.entry_date.slice(0, 10)
}

/** Whole days between two YMD strings (b - a), can be negative. */
export function daysBetween(aYMD: string, bYMD: string): number {
  const a = parseYMD(aYMD).getTime()
  const b = parseYMD(bYMD).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** Shift a YMD string by n days. */
export function shiftYMD(ymd: string, n: number): string {
  const d = parseYMD(ymd)
  d.setUTCDate(d.getUTCDate() + n)
  return toYMD(d)
}

/** Monday of the ISO week containing `ymd`, as a YMD string. */
export function isoWeekStart(ymd: string): string {
  const d = parseYMD(ymd)
  // getUTCDay: 0=Sun..6=Sat. Convert to Mon=0..Sun=6.
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow)
  return toYMD(d)
}

// ── flare statistics ─────────────────────────────────────────────────────────

/** A "flare" is any log entry with a recorded pain level of 1 or more. */
function isFlare(e: InjuryLogEntry): boolean {
  return e.pain_level != null && e.pain_level >= 1
}

export interface FlareStats {
  /** Flares per week over the trailing 30 days, or null if no entries at all. */
  perWeek30d: number | null
  /** Mean pain of flares in the last 30d, or null if none. */
  avgIntensity30d: number | null
  /** Trend of pain load, last 30d vs prior 30d; null when data is too thin. */
  trend: 'improving' | 'stable' | 'worsening' | null
  /** Most recent flare at any time in the provided entries. */
  lastFlare: { daysAgo: number; pain: number } | null
}

/**
 * Flare frequency, intensity, trend and last-flare summary relative to `now`.
 *
 * - perWeek30d: flares in the last 30d divided by (30/7). null only when there
 *   are no entries whatsoever (an injury with entries but no recent flares
 *   reports 0, which is meaningful).
 * - avgIntensity30d: mean pain of flares in the last 30d; null when none.
 * - trend: compares summed pain load of the last 30d against the prior 30d.
 *   improving if load fell >15%, worsening if it rose >15%, else stable.
 *   null when BOTH windows have fewer than 2 flare entries (insufficient data).
 * - lastFlare: the most recent flare across ALL provided entries.
 */
export function flareStats(entries: InjuryLogEntry[], now: Date): FlareStats {
  const nowYMD = toYMD(now)
  const start30 = shiftYMD(nowYMD, -30)
  const start60 = shiftYMD(nowYMD, -60)

  const inWindow = (e: InjuryLogEntry, fromYMD: string, toYMDExclusive: string): boolean => {
    const d = entryYMD(e)
    return d > fromYMD && d <= toYMDExclusive
  }

  const flares = entries.filter(isFlare)

  const last30Flares = flares.filter((e) => inWindow(e, start30, nowYMD))
  const prior30Flares = flares.filter((e) => inWindow(e, start60, start30))

  const perWeek30d = entries.length === 0 ? null : last30Flares.length / (30 / 7)

  const avgIntensity30d =
    last30Flares.length === 0
      ? null
      : last30Flares.reduce((s, e) => s + (e.pain_level ?? 0), 0) / last30Flares.length

  // Trend from summed pain load, guarded by a minimum sample in both windows.
  let trend: FlareStats['trend'] = null
  if (last30Flares.length >= 2 || prior30Flares.length >= 2) {
    const loadLast = last30Flares.reduce((s, e) => s + (e.pain_level ?? 0), 0)
    const loadPrior = prior30Flares.reduce((s, e) => s + (e.pain_level ?? 0), 0)
    if (loadPrior === 0) {
      // No prior load: any current load is a worsening, otherwise stable.
      trend = loadLast > 0 ? 'worsening' : 'stable'
    } else {
      const change = (loadLast - loadPrior) / loadPrior
      if (change < -0.15) trend = 'improving'
      else if (change > 0.15) trend = 'worsening'
      else trend = 'stable'
    }
  }

  // Last flare across all entries (most recent by entry date).
  let lastFlare: FlareStats['lastFlare'] = null
  let bestYMD = ''
  for (const e of flares) {
    const d = entryYMD(e)
    if (d > bestYMD) {
      bestYMD = d
      lastFlare = { daysAgo: daysBetween(d, nowYMD), pain: e.pain_level as number }
    }
  }

  return { perWeek30d, avgIntensity30d, trend, lastFlare }
}

// ── plan adherence ───────────────────────────────────────────────────────────

/** Active plan items that carry a weekly target (the ones adherence measures). */
function targetedItems(items: RecoveryPlanItem[]): RecoveryPlanItem[] {
  return items.filter((i) => i.active && i.weekly_target != null && i.weekly_target > 0)
}

/**
 * Percentage of weekly targets met over a trailing `days` window, averaged
 * across active targeted items and rounded. null when no such items exist.
 *
 * expected = weekly_target * (days/7); per-item score = min(1, done/expected);
 * result = mean(scores) * 100.
 */
export function adherencePct(
  items: RecoveryPlanItem[],
  checks: PlanItemCheck[],
  todayYMD: string,
  days: number
): number | null {
  const targeted = targetedItems(items)
  if (targeted.length === 0) return null

  const fromExclusive = shiftYMD(todayYMD, -days)
  const inWindow = (c: PlanItemCheck): boolean => {
    const d = c.done_date.slice(0, 10)
    return d > fromExclusive && d <= todayYMD
  }

  let sum = 0
  for (const item of targeted) {
    const expected = (item.weekly_target as number) * (days / 7)
    const done = checks.filter((c) => c.item_id === item.id && inWindow(c)).length
    sum += Math.min(1, expected === 0 ? 0 : done / expected)
  }
  return Math.round((sum / targeted.length) * 100)
}

/**
 * Weekly adherence % for the trailing `weeks` ISO weeks (oldest → newest), for
 * the sparkline underlay. Each entry is a whole ISO week; pct is the average
 * per-item completion (done/weekly_target, capped at 1) across targeted items.
 */
export function weeklyAdherence(
  items: RecoveryPlanItem[],
  checks: PlanItemCheck[],
  todayYMD: string,
  weeks: number
): Array<{ weekStart: string; pct: number }> {
  const targeted = targetedItems(items)
  const currentWeekStart = isoWeekStart(todayYMD)
  const out: Array<{ weekStart: string; pct: number }> = []

  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = shiftYMD(currentWeekStart, -7 * i)
    const weekEnd = shiftYMD(weekStart, 6)
    let pct = 0
    if (targeted.length > 0) {
      let sum = 0
      for (const item of targeted) {
        const target = item.weekly_target as number
        const done = checks.filter((c) => {
          const d = c.done_date.slice(0, 10)
          return c.item_id === item.id && d >= weekStart && d <= weekEnd
        }).length
        sum += Math.min(1, target === 0 ? 0 : done / target)
      }
      pct = Math.round((sum / targeted.length) * 100)
    }
    out.push({ weekStart, pct })
  }
  return out
}

/**
 * Current-ISO-week progress for a single item: checks this week vs its weekly
 * target. null when the item has no weekly target.
 */
export function weeklyProgress(
  item: RecoveryPlanItem,
  checks: PlanItemCheck[],
  todayYMD: string
): { done: number; target: number } | null {
  if (item.weekly_target == null || item.weekly_target <= 0) return null
  const weekStart = isoWeekStart(todayYMD)
  const weekEnd = shiftYMD(weekStart, 6)
  const done = checks.filter((c) => {
    const d = c.done_date.slice(0, 10)
    return c.item_id === item.id && d >= weekStart && d <= weekEnd
  }).length
  return { done, target: item.weekly_target }
}

// ── unified timeline ─────────────────────────────────────────────────────────

export interface TimelineDay {
  date: string
  notes: InjuryLogEntry[]
  checks: Array<{ itemName: string; source: string }>
}

/**
 * Merge log entries and plan-item checks into a per-date timeline, newest date
 * first. Notes within a day keep input order; checks resolve item_id → name via
 * `items` (falling back to the raw id if the item is unknown).
 */
export function buildTimeline(
  entries: InjuryLogEntry[],
  checks: PlanItemCheck[],
  items: RecoveryPlanItem[]
): TimelineDay[] {
  const nameById = new Map(items.map((i) => [i.id, i.name]))
  const byDate = new Map<string, TimelineDay>()

  const dayFor = (date: string): TimelineDay => {
    let day = byDate.get(date)
    if (!day) {
      day = { date, notes: [], checks: [] }
      byDate.set(date, day)
    }
    return day
  }

  for (const e of entries) {
    dayFor(entryYMD(e)).notes.push(e)
  }
  for (const c of checks) {
    const date = c.done_date.slice(0, 10)
    dayFor(date).checks.push({
      itemName: nameById.get(c.item_id) ?? c.item_id,
      source: c.source
    })
  }

  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

// ── duration humanizer ───────────────────────────────────────────────────────

/**
 * Humanize the span between two YMD dates as "12 d", "3 mo" or "1.5 y".
 * When `endYMD` is null the span runs to "now" is NOT assumed — callers pass
 * an explicit end; a null start (or an inverted range) yields "—".
 */
export function humanizeDuration(startYMD: string | null, endYMD: string | null): string {
  if (!startYMD || !endYMD) return '—'
  const days = daysBetween(startYMD.slice(0, 10), endYMD.slice(0, 10))
  if (days < 0) return '—'
  if (days < 31) return `${days} d`
  if (days < 365) return `${Math.round(days / 30.44)} mo`
  const years = days / 365.25
  // One decimal, but drop a trailing ".0" for whole years.
  const rounded = Math.round(years * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} y`
}
