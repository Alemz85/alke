// "Most likely" exercise ranking for the Gym tab's ExercisePicker. Pure and
// tested: no window.api / DOM access — matches lib/gymLog.ts conventions.
//
// Ranking is tiered (exact > starts-with > word-boundary starts-with >
// substring), name matches edge out alias matches within a tier, and actual
// usage (from the fetched 90d sessions) nudges familiar exercises to the top.

import type { Exercise } from '@shared/types'

const RESULT_CAP = 5
const USAGE_COUNT_CAP = 8
const RECENCY_WINDOW_DAYS = 21

export interface ExerciseUsageEntry {
  count: number
  lastIso: string | null
}

export interface RankExercisesOptions {
  bodyPart?: string | null
  usage?: Map<string, ExerciseUsageEntry>
}

/** lowercase + trim + strip diacritics (NFD, drop combining marks) so "pressa" / accented Italian input matches ASCII-normalized catalog data. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
}

// Match tiers, best first. Higher number = better match.
const TIER_EXACT = 4
const TIER_STARTS_WITH = 3
const TIER_WORD_BOUNDARY = 2
const TIER_SUBSTRING = 1
const TIER_NONE = 0

function candidateTier(query: string, candidate: string): number {
  if (candidate === query) return TIER_EXACT
  if (candidate.startsWith(query)) return TIER_STARTS_WITH
  if (new RegExp(`\\b${escapeRegExp(query)}`).test(candidate)) return TIER_WORD_BOUNDARY
  if (candidate.includes(query)) return TIER_SUBSTRING
  return TIER_NONE
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Best (tier, isName) match for one exercise against the normalized query. isName breaks ties within a tier in favor of the exercise's own name over an alias. */
function bestMatch(query: string, exercise: Exercise): { tier: number; isName: boolean } | null {
  let best: { tier: number; isName: boolean } | null = null

  const consider = (candidate: string, isName: boolean): void => {
    const tier = candidateTier(query, normalize(candidate))
    if (tier === TIER_NONE) return
    if (!best || tier > best.tier || (tier === best.tier && isName && !best.isName)) {
      best = { tier, isName }
    }
  }

  consider(exercise.name, true)
  for (const alias of exercise.aliases) consider(alias, false)

  return best
}

function usageBoost(exercise: Exercise, usage: Map<string, ExerciseUsageEntry> | undefined): number {
  if (!usage) return 0
  const entry = usage.get(exercise.id)
  if (!entry) return 0
  let boost = Math.min(entry.count, USAGE_COUNT_CAP)
  if (entry.lastIso) {
    const ageDays = (Date.now() - Date.parse(entry.lastIso)) / 86_400_000
    if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= RECENCY_WINDOW_DAYS) {
      boost += 1
    }
  }
  return boost
}

/**
 * Ranks exercises against a free-text query. Empty/whitespace query returns
 * [] unless a bodyPart filter is active, in which case it returns the top 5
 * for that body part by usage then alphabetically (the "picked legs, show me
 * likely legs exercises" flow). Always capped at 5 results.
 */
export function rankExercises(
  query: string,
  exercises: Exercise[],
  opts: RankExercisesOptions = {}
): Exercise[] {
  const bodyPart = opts.bodyPart ?? null
  const usage = opts.usage

  const pool = bodyPart ? exercises.filter((e) => e.body_part === bodyPart) : exercises

  const normalizedQuery = normalize(query)

  if (normalizedQuery === '') {
    if (!bodyPart) return []
    return [...pool]
      .sort((a, b) => {
        const boostDiff = usageBoost(b, usage) - usageBoost(a, usage)
        if (boostDiff !== 0) return boostDiff
        return a.name.localeCompare(b.name)
      })
      .slice(0, RESULT_CAP)
  }

  const scored: { exercise: Exercise; tier: number; isName: boolean; boost: number }[] = []
  for (const exercise of pool) {
    const match = bestMatch(normalizedQuery, exercise)
    if (!match) continue
    scored.push({ exercise, tier: match.tier, isName: match.isName, boost: usageBoost(exercise, usage) })
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier
    if (a.boost !== b.boost) return b.boost - a.boost
    if (a.isName !== b.isName) return a.isName ? -1 : 1
    return a.exercise.name.localeCompare(b.exercise.name)
  })

  return scored.slice(0, RESULT_CAP).map((s) => s.exercise)
}
