// Pure, testable analytics for the Injuries tab.
//
// Every function takes an explicit `now: Date` or `todayYMD: string` — there is
// no Date.now() inside, so the whole module is deterministic and testable
// without the DOM or window.api. Dates are handled as YYYY-MM-DD strings and
// compared lexicographically (ISO dates sort chronologically as text), with a
// small UTC-noon Date helper for arithmetic that must not drift across DST.

import type {
  InjuryLogEntry,
  PlanItemCheck,
  RecoveryPlanItem,
  RecoveryPlanPhase
} from '@shared/types'

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

/** Smallest 30d-vs-30d change in summed day-max pain that earns a trend
 *  direction — see the rationale at the trend computation in flareStats. */
const MIN_TREND_LOAD_DELTA = 3

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
 *   30d. A direction requires BOTH a >15% relative change AND an absolute
 *   swing of at least MIN_TREND_LOAD_DELTA summed points — smaller moves are
 *   'stable' (logging noise, not a claim of change). null when BOTH windows
 *   have fewer than 2 flare days (insufficient data).
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
  //
  // A trend label is a CLAIM of change, so it must clear an ABSOLUTE bar as
  // well as the relative one: ±15% alone flips on noise when the base is a
  // couple of 1/10 days (one extra summed pain point is +50%), which is how
  // every injury card once read a red "Worsening" at the same time — alarm
  // framing this app reserves for genuine deterioration. Three summed
  // day-max points (about one 3/10 day, or three 1/10 days) is the smallest
  // swing worth calling a direction; below it the honest label is stable.
  // The floor is chosen against the owner's own logging noise, not derived.
  let trend: FlareStats['trend'] = null
  if (last30Flares.length >= 2 || prior30Flares.length >= 2) {
    const loadLast = last30Flares.reduce((s, d) => s + d.pain, 0)
    const loadPrior = prior30Flares.reduce((s, d) => s + d.pain, 0)
    const delta = loadLast - loadPrior
    if (Math.abs(delta) < MIN_TREND_LOAD_DELTA) {
      trend = 'stable'
    } else if (loadPrior === 0) {
      // No prior load and a meaningful current one: a genuine worsening.
      trend = 'worsening'
    } else {
      const change = delta / loadPrior
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

export interface ResolvedTargets {
  weekly_target: number | null
  green_min: number | null
  yellow_min: number | null
}

/**
 * The plan week in which a phase step comes into force, or null when it has
 * not (demonstrably) started. Calendar phases carry their own `from_week`. A
 * symptom-gated phase has no week until someone stamps `applied_on`; once
 * stamped it behaves like a calendar phase starting in the week containing
 * that date, so history keeps grading past weeks by the dose in force THEN.
 */
export function phaseEffectiveWeek(
  phase: RecoveryPlanPhase,
  planStartedAt: string | null
): number | null {
  if (phase.gate != null) {
    if (!phase.applied_on) return null
    return currentPlanWeek(planStartedAt, phase.applied_on)
  }
  return phase.from_week ?? null
}

/**
 * The dose in force for a given plan week. An item's scalar targets cover it
 * from `start_week`; each entry in `phases` overrides them once it starts —
 * calendar phases from their `from_week`, gated phases from the week they
 * were `applied_on` — and the LAST phase that has started wins (array order
 * breaks ties). A pending gate never changes targets.
 *
 * Scoring must go through this rather than reading the scalar columns: a plan
 * that ramps ("3× in week 1, then daily") otherwise rates a correctly-followed
 * week 1 as red against week 2's target — a false efficacy claim, and exactly
 * what forced the duplicate "— week 1" / "— daily" rows this replaces.
 *
 * planWeek null (a plan with no start date) means no phase has demonstrably
 * begun, so the scalars stand. Mirrors resolve_targets() in chatctx
 * injuries.py — keep the two in step.
 */
export function resolveItemTargets(
  item: Partial<Pick<RecoveryPlanItem, 'weekly_target' | 'green_min' | 'yellow_min'>> &
    Pick<RecoveryPlanItem, 'phases'>,
  planWeek: number | null,
  planStartedAt: string | null = null
): ResolvedTargets {
  const base: ResolvedTargets = {
    weekly_target: item.weekly_target ?? null,
    green_min: item.green_min ?? null,
    yellow_min: item.yellow_min ?? null
  }
  if (planWeek == null || !item.phases || item.phases.length === 0) return base
  const started = item.phases
    .map((phase, index) => ({ phase, index, week: phaseEffectiveWeek(phase, planStartedAt) }))
    .filter((step): step is { phase: RecoveryPlanPhase; index: number; week: number } =>
      step.week != null && step.week <= planWeek
    )
    .sort((a, b) => a.week - b.week || a.index - b.index)
  const last = started[started.length - 1]
  if (!last) return base
  return {
    weekly_target: last.phase.weekly_target,
    green_min: last.phase.green_min,
    yellow_min: last.phase.yellow_min
  }
}

/**
 * The next phase that has NOT started yet, for "then N× / week from week X"
 * copy. Dated (calendar) steps come first in week order; pending gated steps
 * have no date, so they follow in array order. Null when the item is flat or
 * already on its final phase.
 */
export function nextItemPhase(
  item: Pick<RecoveryPlanItem, 'phases'>,
  planWeek: number | null,
  planStartedAt: string | null = null
): RecoveryPlanPhase | null {
  if (!item.phases || item.phases.length === 0) return null
  const steps = item.phases.map((phase) => ({
    phase,
    week: phaseEffectiveWeek(phase, planStartedAt)
  }))
  const dated = steps
    .filter((s): s is { phase: RecoveryPlanPhase; week: number } => s.week != null)
    .sort((a, b) => a.week - b.week)
    .filter((s) => planWeek == null || s.week > planWeek)
  if (dated[0]) return dated[0].phase
  const pending = steps.find((s) => s.week == null && s.phase.gate != null)
  return pending?.phase ?? null
}

// ── symptom gates ────────────────────────────────────────────────────────────

export interface GateStatus {
  /** 'pending' counting clean days · 'eligible' clock satisfied, awaiting the
   *  judgment call · 'applied' step-down in force. */
  state: 'pending' | 'eligible' | 'applied'
  /** Consecutive clean days accrued (pending/eligible); null when no clock
   *  can be established or the step is applied. */
  cleanDays: number | null
  clearDays: number
  /** First date the clock can be satisfied (pending), or was (eligible). */
  eligibleOn: string | null
  appliedOn: string | null
  /** Most recent entry above the gate AFTER application — the agreed
   *  reversion rule's watch signal ("any entry above X returns the dose"). */
  flareAfter: string | null
}

/**
 * Live status of a gated phase against the injury log. The clean-day clock
 * counts from the day after the last entry whose pain exceeds the gate
 * (spans count at their END date); with no exceeding entry ever, it counts
 * from the plan start. This computes the measurable half of the trigger only —
 * eligibility says the CLOCK is satisfied, not that the judgment condition
 * (`gate.condition`) holds. Mirrors gate_status() in chatctx injuries.py.
 */
export function phaseGateStatus(
  phase: RecoveryPlanPhase,
  entries: InjuryLogEntry[],
  todayYMD: string,
  planStartedAt: string | null
): GateStatus | null {
  const gate = phase.gate
  if (gate == null) return null
  const exceedDates = entries
    .filter((e) => e.pain_level != null && e.pain_level > gate.max_pain)
    .map((e) => (e.entry_end_date ?? e.entry_date).slice(0, 10))
  const lastExceed = exceedDates.length
    ? exceedDates.reduce((a, b) => (a > b ? a : b))
    : null
  if (phase.applied_on) {
    const appliedOn = phase.applied_on.slice(0, 10)
    const after = exceedDates.filter((d) => d > appliedOn)
    return {
      state: 'applied',
      cleanDays: null,
      clearDays: gate.clear_days,
      eligibleOn: null,
      appliedOn,
      flareAfter: after.length ? after.reduce((a, b) => (a > b ? a : b)) : null
    }
  }
  const clockStart =
    lastExceed != null ? shiftYMD(lastExceed, 1) : (planStartedAt?.slice(0, 10) ?? null)
  if (clockStart == null) {
    return {
      state: 'pending',
      cleanDays: null,
      clearDays: gate.clear_days,
      eligibleOn: null,
      appliedOn: null,
      flareAfter: null
    }
  }
  const cleanDays = Math.max(0, daysBetween(clockStart, todayYMD) + 1)
  return {
    state: cleanDays >= gate.clear_days ? 'eligible' : 'pending',
    cleanDays,
    clearDays: gate.clear_days,
    eligibleOn: shiftYMD(clockStart, gate.clear_days - 1),
    appliedOn: null,
    flareAfter: null
  }
}

/**
 * Active REHAB items (kind 'exercise') carrying a weekly target — the only ones
 * adherence measures. Activities/habits/constraints are excluded from scoring
 * (activities are allowed training, not rehab work).
 */
function hasAnyTarget(item: RecoveryPlanItem): boolean {
  if (item.weekly_target != null && item.weekly_target > 0) return true
  return (item.phases ?? []).some((phase) => phase.weekly_target > 0)
}

function targetedItems(items: RecoveryPlanItem[]): RecoveryPlanItem[] {
  return items.filter((i) => i.active && i.kind === 'exercise' && hasAnyTarget(i))
}

/**
 * Dose that the plan author considers therapeutically acceptable. The plan's
 * green threshold is authoritative when present; older plans fall back to the
 * requested weekly target.
 */
function adherenceDose(
  item: RecoveryPlanItem,
  planWeek: number | null,
  planStartedAt: string | null
): number {
  const targets = resolveItemTargets(item, planWeek, planStartedAt)
  return targets.green_min ?? (targets.weekly_target as number)
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

  const planWeek = currentPlanWeek(planStartedAt, todayYMD)

  let sum = 0
  let accountableCount = 0
  for (const item of targeted) {
    const window = accountableWindow(item, planStartedAt, fromInclusive, todayYMD)
    if (window == null) continue
    const expected = adherenceDose(item, planWeek, planStartedAt) * (window.days / 7)
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
  const planWeek = currentPlanWeek(planStartedAt, todayYMD)
  const checkable = items.filter(
    (item): item is RecoveryPlanItem & { kind: 'exercise' | 'activity' } =>
      item.active && (item.kind === 'exercise' || item.kind === 'activity')
  )

  const rows = checkable.map((item): CurrentWeekAdherenceRow => {
    // The dose in force THIS week — a ramped item is scored against the phase
    // it is actually in, never against a later one it has not reached.
    const targets = resolveItemTargets(item, planWeek, planStartedAt)
    const scored =
      item.kind === 'exercise' && targets.weekly_target != null && targets.weekly_target > 0
    return {
      itemId: item.id,
      kind: item.kind,
      scored,
      done: checkedDays(checks, item.id, weekStart, todayYMD),
      accountable: isPlanItemAccountable(item, planStartedAt, todayYMD),
      prescribed: targets.weekly_target,
      acceptable: scored ? targets.green_min ?? targets.weekly_target : null,
      minimum: scored ? targets.yellow_min : null
    }
  })

  let sum = 0
  let accountableCount = 0
  for (const item of checkable) {
    const targets = resolveItemTargets(item, planWeek, planStartedAt)
    if (item.kind !== 'exercise' || targets.weekly_target == null || targets.weekly_target <= 0) {
      continue
    }
    const window = accountableWindow(item, planStartedAt, weekStart, todayYMD)
    if (window == null) continue
    const expected = adherenceDose(item, planWeek, planStartedAt) * (window.days / 7)
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
      // Each past week is judged by the dose that was in force THEN — a ramped
      // item's week-1 row must not be graded against week 2's target.
      const weekPlanWeek = currentPlanWeek(planStartedAt, scoreEnd)
      for (const item of targeted) {
        const window = accountableWindow(item, planStartedAt, weekStart, scoreEnd)
        if (window == null) continue
        const target = adherenceDose(item, weekPlanWeek, planStartedAt) * (window.days / 7)
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
  todayYMD: string,
  planStartedAt: string | null = null
): { done: number; target: number } | null {
  const targets = resolveItemTargets(item, currentPlanWeek(planStartedAt, todayYMD), planStartedAt)
  if (targets.weekly_target == null || targets.weekly_target <= 0) return null
  const weekStart = isoWeekStart(todayYMD)
  const weekEnd = shiftYMD(weekStart, 6)
  const done = checkedDays(checks, item.id, weekStart, weekEnd)
  return { done, target: targets.weekly_target }
}

/** Human-readable progress that never frames a future phase as currently due. */
export function weeklyProgressStatus(
  item: RecoveryPlanItem,
  checks: PlanItemCheck[],
  todayYMD: string,
  planStartedAt: string | null = null
): string | null {
  const progress = weeklyProgress(item, checks, todayYMD, planStartedAt)
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
  item: Pick<RecoveryPlanItem, 'weekly_target' | 'green_min' | 'yellow_min' | 'phases'>,
  planWeek: number | null = null,
  planStartedAt: string | null = null
): AdherenceRating {
  const targets = resolveItemTargets(item, planWeek, planStartedAt)
  if (targets.green_min == null || targets.yellow_min == null) {
    return adherenceRating(done, targets.weekly_target)
  }
  if (done >= targets.green_min) return 'met'
  if (done >= targets.yellow_min) return 'low'
  return 'none'
}

/**
 * The weekly count at which an item's column mutes as "dose reached" in the
 * current-week table: the acceptable therapeutic dose when assigned, else the
 * full weekly target.
 */
export function doseTarget(
  item: Pick<RecoveryPlanItem, 'weekly_target' | 'green_min' | 'phases'>,
  planWeek: number | null = null,
  planStartedAt: string | null = null
): number | null {
  const targets = resolveItemTargets(item, planWeek, planStartedAt)
  return targets.green_min ?? targets.weekly_target
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
  const targeted = active.filter((i) => i.kind === 'exercise' && hasAnyTarget(i))
  const currentWeekStart = isoWeekStart(todayYMD)
  const planStartWeek = planStartedAt != null ? isoWeekStart(planStartedAt) : null
  const rows: WeekMatrixRow[] = []

  for (let i = 1; i <= weeks; i++) {
    const weekStart = shiftYMD(currentWeekStart, -7 * i)
    if (planStartWeek != null && weekStart < planStartWeek) break
    const weekEnd = shiftYMD(weekStart, 6)
    const doneFor = (itemId: string): number =>
      checkedDays(checks, itemId, weekStart, weekEnd)

    // Each historical row reports the target that applied in ITS week.
    const rowPlanWeek = currentPlanWeek(planStartedAt, weekEnd)
    const perItem = active.map((item) => ({
      itemId: item.id,
      done: doneFor(item.id),
      target: resolveItemTargets(item, rowPlanWeek, planStartedAt).weekly_target,
      accountable: accountableWindow(item, planStartedAt, weekStart, weekEnd) != null
    }))

    let overallPct: number | null = null
    if (targeted.length > 0) {
      let sum = 0
      let accountableCount = 0
      const weekPlanWeek = currentPlanWeek(planStartedAt, weekEnd)
      for (const item of targeted) {
        const window = accountableWindow(item, planStartedAt, weekStart, weekEnd)
        if (window == null) continue
        const expected = adherenceDose(item, weekPlanWeek, planStartedAt) * (window.days / 7)
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
