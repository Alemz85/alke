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

/**
 * Today's single-day, user-authored log entry, if one exists — mirrors the
 * server's same-day merge scope in `addInjuryLog` (source 'user', no
 * entry_end_date, entry_date = today). Used to make the quick-log UI reflect
 * "already logged today" instead of relying on a client-side timer: a repeat
 * "Feeling fine" click is then a visible no-op rather than an extra optimistic
 * row, while a flare-up log (different content) still goes through and, per
 * the server merge rule, overwrites today's row instead of duplicating it.
 */
export function todayUserEntry(entries: InjuryLogEntry[], todayYMD: string): InjuryLogEntry | null {
  for (const e of entries) {
    if (e.source === 'user' && e.entry_end_date == null && entryYMD(e) === todayYMD) return e
  }
  return null
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

/** Plan week on `dateYMD`: 0 before start, 1-based after start, null for legacy plans. */
export function currentPlanWeek(planStartedAt: string | null, dateYMD: string): number | null {
  if (planStartedAt == null) return null
  const elapsed = daysBetween(planStartedAt, dateYMD)
  return elapsed < 0 ? 0 : Math.floor(elapsed / 7) + 1
}

/** Calendar date on which an item's cumulative plan phase becomes accountable. */
export function phaseStartYMD(
  item: Pick<RecoveryPlanItem, 'start_week'>,
  planStartedAt: string | null
): string | null {
  if (planStartedAt == null) return null
  return shiftYMD(planStartedAt, 7 * (Math.max(1, item.start_week ?? 1) - 1))
}

/** Legacy plans without a start date treat every active item as already due. */
export function isPlanItemAccountable(
  item: Pick<RecoveryPlanItem, 'start_week'>,
  planStartedAt: string | null,
  dateYMD: string
): boolean {
  const starts = phaseStartYMD(item, planStartedAt)
  return starts == null || starts <= dateYMD
}

// ── daily pain resolution ──────────────────────────────────────────────────
// A day's effective pain is the MAX pain logged that day: "fine at 18:00, flare
// at night → flare day". All flare stats plot and count on day-maxes, so a day
// with several logs collapses to one point at its worst reading.

export interface PainDay {
  date: string
  /** Maximum pain level logged that day (>= 0). */
  pain: number
}

/**
 * Collapse log entries to one point per day carrying that day's MAX pain level.
 * Only days with at least one pain-logged entry (pain_level != null) appear.
 * Sorted oldest → newest.
 */
export function dailyPainSeries(entries: InjuryLogEntry[]): PainDay[] {
  const maxByDay = new Map<string, number>()
  for (const e of entries) {
    if (e.pain_level == null) continue
    const d = entryYMD(e)
    const prev = maxByDay.get(d)
    if (prev == null || e.pain_level > prev) maxByDay.set(d, e.pain_level)
  }
  return Array.from(maxByDay.entries())
    .map(([date, pain]) => ({ date, pain }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

// ── flare statistics ─────────────────────────────────────────────────────────

/** A "flare DAY" is a day whose max pain is 1 or more. */
function isFlareDay(d: PainDay): boolean {
  return d.pain >= 1
}

export interface FlareStats {
  /** Distinct flare DAYS per week over the trailing 30 days; null if no entries. */
  perWeek30d: number | null
  /** Mean of the day-maxes of flare days in the last 30d, or null if none. */
  avgIntensity30d: number | null
  /** Trend of pain load (summed day-maxes), last 30d vs prior 30d; null if thin. */
  trend: 'improving' | 'stable' | 'worsening' | null
  /** Most recent flare day at any time, carrying that day's max pain. */
  lastFlare: { daysAgo: number; pain: number } | null
}

/**
 * Flare frequency, intensity, trend and last-flare summary relative to `now`,
 * all computed on DAY-MAXES (see dailyPainSeries): a day is a "flare day" when
 * its worst logged pain is >= 1, and each day contributes a single value.
 *
 * - perWeek30d: distinct flare DAYS in the last 30d divided by (30/7). null only
 *   when there are no pain-logged entries at all (an injury with entries but no
 *   recent flares reports 0, which is meaningful).
 * - avgIntensity30d: mean of the day-maxes of flare days in the last 30d; null
 *   when none.
 * - trend: compares summed day-max pain load of the last 30d against the prior
 *   30d. improving if load fell >15%, worsening if it rose >15%, else stable.
 *   null when BOTH windows have fewer than 2 flare days (insufficient data).
 * - lastFlare: the most recent flare day across ALL entries, at its day-max.
 */
export function flareStats(entries: InjuryLogEntry[], now: Date): FlareStats {
  const nowYMD = toYMD(now)
  const start30 = shiftYMD(nowYMD, -30)
  const start60 = shiftYMD(nowYMD, -60)

  const inWindow = (d: PainDay, fromYMD: string, toYMDExclusive: string): boolean => {
    return d.date > fromYMD && d.date <= toYMDExclusive
  }

  // Whether ANY pain reading exists (pain 0 counts) — distinguishes "no data"
  // (null) from "data but no flares" (0). Day-maxes drop pain-null entries, so
  // check the raw log for the null decision.
  const hasAnyPain = entries.some((e) => e.pain_level != null)

  const painDays = dailyPainSeries(entries)
  const flareDays = painDays.filter(isFlareDay)

  const last30Flares = flareDays.filter((d) => inWindow(d, start30, nowYMD))
  const prior30Flares = flareDays.filter((d) => inWindow(d, start60, start30))

  const perWeek30d = !hasAnyPain ? null : last30Flares.length / (30 / 7)

  const avgIntensity30d =
    last30Flares.length === 0
      ? null
      : last30Flares.reduce((s, d) => s + d.pain, 0) / last30Flares.length

  // Trend from summed day-max load, guarded by a minimum sample in both windows.
  let trend: FlareStats['trend'] = null
  if (last30Flares.length >= 2 || prior30Flares.length >= 2) {
    const loadLast = last30Flares.reduce((s, d) => s + d.pain, 0)
    const loadPrior = prior30Flares.reduce((s, d) => s + d.pain, 0)
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

  // Last flare day (flareDays is sorted oldest → newest, so the last is newest).
  const newest = flareDays[flareDays.length - 1]
  const lastFlare: FlareStats['lastFlare'] = newest
    ? { daysAgo: daysBetween(newest.date, nowYMD), pain: newest.pain }
    : null

  return { perWeek30d, avgIntensity30d, trend, lastFlare }
}

// ── plan adherence ───────────────────────────────────────────────────────────

/**
 * Active REHAB items (kind 'exercise') carrying a weekly target — the only ones
 * adherence measures. Activities/habits/constraints are excluded from scoring
 * (activities are allowed training, not rehab work).
 */
function targetedItems(items: RecoveryPlanItem[]): RecoveryPlanItem[] {
  return items.filter(
    (i) => i.active && i.kind === 'exercise' && i.weekly_target != null && i.weekly_target > 0
  )
}

/**
 * Dose that the plan author considers therapeutically acceptable. The plan's
 * green threshold is authoritative when present; older plans fall back to the
 * requested weekly target.
 */
function adherenceDose(item: RecoveryPlanItem): number {
  return item.green_min ?? (item.weekly_target as number)
}

/** Count distinct checked days, insulating the score from duplicate rows. */
function checkedDays(
  checks: PlanItemCheck[],
  itemId: string,
  fromYMD: string,
  toYMD: string
): number {
  return new Set(
    checks
      .filter((c) => {
        const d = c.done_date.slice(0, 10)
        return c.item_id === itemId && d >= fromYMD && d <= toYMD
      })
      .map((c) => c.done_date.slice(0, 10))
  ).size
}

/** Aggregate adherence is intentionally shown in coarse five-point bands. */
function adherenceBand(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value / 5) * 5))
}

function accountableWindow(
  item: Pick<RecoveryPlanItem, 'start_week'>,
  planStartedAt: string | null,
  fromYMD: string,
  toYMD: string
): { fromYMD: string; days: number } | null {
  const starts = phaseStartYMD(item, planStartedAt)
  if (starts != null && starts > toYMD) return null
  const accountableFrom = starts != null && starts > fromYMD ? starts : fromYMD
  return { fromYMD: accountableFrom, days: daysBetween(accountableFrom, toYMD) + 1 }
}

/**
 * Percentage of acceptable rehab dose met over a trailing `days` window,
 * averaged equally across active targeted exercises. The green efficacy
 * threshold is the denominator when available; older plans use weekly_target.
 * Activity clearance, habits and constraints remain visible but unscored.
 *
 * Duplicate checks on one item/day count once. The aggregate is returned in
 * five-point bands to avoid suggesting precision the plan cannot support.
 */
export function adherencePct(
  items: RecoveryPlanItem[],
  checks: PlanItemCheck[],
  todayYMD: string,
  days: number,
  planStartedAt: string | null = null
): number | null {
  const targeted = targetedItems(items)
  if (targeted.length === 0) return null

  const fromInclusive = shiftYMD(todayYMD, -(days - 1))

  let sum = 0
  let accountableCount = 0
  for (const item of targeted) {
    const window = accountableWindow(item, planStartedAt, fromInclusive, todayYMD)
    if (window == null) continue
    const expected = adherenceDose(item) * (window.days / 7)
    const done = checkedDays(checks, item.id, window.fromYMD, todayYMD)
    sum += Math.min(1, expected === 0 ? 0 : done / expected)
    accountableCount++
  }
  return accountableCount === 0 ? null : adherenceBand((sum / accountableCount) * 100)
}

export interface CurrentWeekAdherenceRow {
  itemId: string
  kind: 'exercise' | 'activity'
  scored: boolean
  done: number
  accountable: boolean
  prescribed: number | null
  acceptable: number | null
  minimum: number | null
}

export interface CurrentWeekAdherenceSummary {
  rows: CurrentWeekAdherenceRow[]
  /** Pace against elapsed accountable days, in five-point bands. */
  pct: number | null
}

/**
 * Current ISO-week progress for every active, checkable plan item. Exercise
 * rows with a positive weekly target are scored against their acceptable dose;
 * activities and untargeted exercises stay visible as unscored progress.
 */
export function currentWeekAdherenceSummary(
  items: RecoveryPlanItem[],
  checks: PlanItemCheck[],
  todayYMD: string,
  planStartedAt: string | null = null
): CurrentWeekAdherenceSummary {
  const weekStart = isoWeekStart(todayYMD)
  const checkable = items.filter(
    (item): item is RecoveryPlanItem & { kind: 'exercise' | 'activity' } =>
      item.active && (item.kind === 'exercise' || item.kind === 'activity')
  )

  const rows = checkable.map((item): CurrentWeekAdherenceRow => {
    const scored = item.kind === 'exercise' && item.weekly_target != null && item.weekly_target > 0
    return {
      itemId: item.id,
      kind: item.kind,
      scored,
      done: checkedDays(checks, item.id, weekStart, todayYMD),
      accountable: isPlanItemAccountable(item, planStartedAt, todayYMD),
      prescribed: item.weekly_target,
      acceptable: scored ? item.green_min ?? item.weekly_target : null,
      minimum: scored ? item.yellow_min : null
    }
  })

  let sum = 0
  let accountableCount = 0
  for (const item of checkable) {
    if (item.kind !== 'exercise' || item.weekly_target == null || item.weekly_target <= 0) continue
    const window = accountableWindow(item, planStartedAt, weekStart, todayYMD)
    if (window == null) continue
    const expected = adherenceDose(item) * (window.days / 7)
    const done = checkedDays(checks, item.id, window.fromYMD, todayYMD)
    sum += Math.min(1, expected === 0 ? 0 : done / expected)
    accountableCount++
  }

  return {
    rows,
    pct: accountableCount === 0 ? null : adherenceBand((sum / accountableCount) * 100)
  }
}

/**
 * Weekly adherence % for the trailing `weeks` ISO weeks (oldest → newest), for
 * the sparkline underlay. Completed weeks use the full acceptable dose. The
 * current week uses the whole-number dose expected by the elapsed weekday, so
 * Friday is not compared with seven completed days. This is a pace indicator,
 * not a prediction of final adherence.
 */
export function weeklyAdherence(
  items: RecoveryPlanItem[],
  checks: PlanItemCheck[],
  todayYMD: string,
  weeks: number,
  planStartedAt: string | null = null
): Array<{ weekStart: string; pct: number | null }> {
  const targeted = targetedItems(items)
  const currentWeekStart = isoWeekStart(todayYMD)
  const out: Array<{ weekStart: string; pct: number | null }> = []

  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = shiftYMD(currentWeekStart, -7 * i)
    const weekEnd = shiftYMD(weekStart, 6)
    const isCurrent = weekStart === currentWeekStart
    let pct: number | null = null
    if (targeted.length > 0) {
      let sum = 0
      let accountableCount = 0
      const scoreEnd = isCurrent ? todayYMD : weekEnd
      for (const item of targeted) {
        const window = accountableWindow(item, planStartedAt, weekStart, scoreEnd)
        if (window == null) continue
        const target = adherenceDose(item) * (window.days / 7)
        const done = checkedDays(checks, item.id, window.fromYMD, scoreEnd)
        sum += Math.min(1, target === 0 ? 0 : done / target)
        accountableCount++
      }
      if (accountableCount > 0) pct = adherenceBand((sum / accountableCount) * 100)
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
  const done = checkedDays(checks, item.id, weekStart, weekEnd)
  return { done, target: item.weekly_target }
}

/** Human-readable progress that never frames a future phase as currently due. */
export function weeklyProgressStatus(
  item: RecoveryPlanItem,
  checks: PlanItemCheck[],
  todayYMD: string,
  planStartedAt: string | null = null
): string | null {
  const progress = weeklyProgress(item, checks, todayYMD)
  if (progress == null) return null
  if (!isPlanItemAccountable(item, planStartedAt, todayYMD)) {
    return progress.done > 0 ? `${progress.done} done early` : null
  }
  return `${progress.done}/${progress.target} this week`
}

/**
 * A single day's rehab completion: how many active EXERCISE items were checked
 * on `dateYMD` out of the total active exercise items. Activities, habits and
 * constraints are excluded (only rehab work is scored). `total` is 0 when there
 * are no active exercise items, in which case there is nothing to score.
 */
export function dayScore(
  items: RecoveryPlanItem[],
  checks: PlanItemCheck[],
  dateYMD: string,
  planStartedAt: string | null = null
): { done: number; total: number } {
  const exercises = items.filter(
    (i) =>
      i.active &&
      i.kind === 'exercise' &&
      isPlanItemAccountable(i, planStartedAt, dateYMD)
  )
  const total = exercises.length
  if (total === 0) return { done: 0, total: 0 }
  const exerciseIds = new Set(exercises.map((i) => i.id))
  const checkedIds = new Set(
    checks.filter((c) => c.done_date.slice(0, 10) === dateYMD).map((c) => c.item_id)
  )
  let done = 0
  for (const id of exerciseIds) if (checkedIds.has(id)) done++
  return { done, total }
}

// ── adherence rating ─────────────────────────────────────────────────────────

export type AdherenceRating = 'none' | 'low' | 'met' | 'untargeted'

/**
 * The PROVISIONAL blanket rating — used for items without their own efficacy
 * thresholds (see itemAdherenceRating) and for aggregate percentages:
 * - null (or non-positive) target → 'untargeted' — informational count only
 * - done 0 → 'none'
 * - done/target >= 0.75 → 'met'
 * - otherwise → 'low'
 */
export function adherenceRating(done: number, target: number | null): AdherenceRating {
  if (target == null || target <= 0) return 'untargeted'
  if (done === 0) return 'none'
  return done / target >= 0.75 ? 'met' : 'low'
}

/**
 * Rate a week's done-count for a specific item. When the item carries agent-
 * assigned efficacy thresholds, the colors are EFFICACY claims, not effort:
 * - done >= green_min  → 'met'  (acceptable therapeutic dose)
 * - done >= yellow_min → 'low'  (minimum-effective dose — maintenance)
 * - otherwise          → 'none' (below meaningful effect — even when non-zero:
 *   1/7 of a daily mobility routine is red, not yellow)
 * Items without both thresholds fall back to the blanket adherenceRating.
 */
export function itemAdherenceRating(
  done: number,
  item: Pick<RecoveryPlanItem, 'weekly_target' | 'green_min' | 'yellow_min'>
): AdherenceRating {
  if (item.green_min == null || item.yellow_min == null) {
    return adherenceRating(done, item.weekly_target)
  }
  if (done >= item.green_min) return 'met'
  if (done >= item.yellow_min) return 'low'
  return 'none'
}

/**
 * The weekly count at which an item's column mutes as "dose reached" in the
 * current-week table: the acceptable therapeutic dose when assigned, else the
 * full weekly target.
 */
export function doseTarget(
  item: Pick<RecoveryPlanItem, 'weekly_target' | 'green_min'>
): number | null {
  return item.green_min ?? item.weekly_target
}

// ── weekly matrix (past-weeks history table) ─────────────────────────────────

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]

/** "Jun 29" — locale-independent short date for week labels. */
function shortDate(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number)
  return `${MONTH_ABBR[m - 1]} ${d}`
}

export interface WeekMatrixRow {
  weekStart: string
  weekEnd: string
  /** e.g. "Jun 29 – Jul 5" */
  label: string
  /** One entry per active item, in the order the items were passed. */
  perItem: Array<{ itemId: string; done: number; target: number | null; accountable: boolean }>
  /**
   * Mean capped completion against each item's acceptable efficacy dose across
   * targeted EXERCISE items only, in five-point bands. null when none exist.
   */
  overallPct: number | null
}

/**
 * Per-item weekly done-counts for the trailing `weeks` PAST ISO weeks — the
 * current week is excluded — newest first. Inactive items are skipped.
 * Rows never precede the ISO week the recovery plan started in: once the
 * walk-back reaches that week, generation stops even if `weeks` asked for
 * more. Without a `planStartedAt`, all `weeks` are generated (legacy plans).
 */
export function weeklyMatrix(
  items: RecoveryPlanItem[],
  checks: PlanItemCheck[],
  todayYMD: string,
  weeks: number,
  planStartedAt: string | null = null
): WeekMatrixRow[] {
  const active = items.filter((i) => i.active)
  const targeted = active.filter(
    (i) => i.kind === 'exercise' && i.weekly_target != null && i.weekly_target > 0
  )
  const currentWeekStart = isoWeekStart(todayYMD)
  const planStartWeek = planStartedAt != null ? isoWeekStart(planStartedAt) : null
  const rows: WeekMatrixRow[] = []

  for (let i = 1; i <= weeks; i++) {
    const weekStart = shiftYMD(currentWeekStart, -7 * i)
    if (planStartWeek != null && weekStart < planStartWeek) break
    const weekEnd = shiftYMD(weekStart, 6)
    const doneFor = (itemId: string): number =>
      checkedDays(checks, itemId, weekStart, weekEnd)

    const perItem = active.map((item) => ({
      itemId: item.id,
      done: doneFor(item.id),
      target: item.weekly_target,
      accountable: accountableWindow(item, planStartedAt, weekStart, weekEnd) != null
    }))

    let overallPct: number | null = null
    if (targeted.length > 0) {
      let sum = 0
      let accountableCount = 0
      for (const item of targeted) {
        const window = accountableWindow(item, planStartedAt, weekStart, weekEnd)
        if (window == null) continue
        const expected = adherenceDose(item) * (window.days / 7)
        const done = checkedDays(checks, item.id, window.fromYMD, weekEnd)
        sum += Math.min(1, expected === 0 ? 0 : done / expected)
        accountableCount++
      }
      if (accountableCount > 0) {
        overallPct = adherenceBand((sum / accountableCount) * 100)
      }
    }

    rows.push({
      weekStart,
      weekEnd,
      label: `${shortDate(weekStart)} – ${shortDate(weekEnd)}`,
      perItem,
      overallPct
    })
  }
  return rows
}

/**
 * How many PAST ISO weeks (excluding the current week) exist between the
 * plan-start week and today — the ceiling `weeklyMatrix` walk-back can ever
 * fill. Without a `planStartedAt`, there is no floor: callers should treat
 * this as "unbounded" (e.g. keep paging by a fixed page size) rather than 0.
 */
export function maxWeeksAvailable(todayYMD: string, planStartedAt: string | null): number | null {
  if (planStartedAt == null) return null
  const currentWeekStart = isoWeekStart(todayYMD)
  const planStartWeek = isoWeekStart(planStartedAt)
  const weeks = Math.floor(daysBetween(planStartWeek, currentWeekStart) / 7)
  return Math.max(0, weeks)
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
