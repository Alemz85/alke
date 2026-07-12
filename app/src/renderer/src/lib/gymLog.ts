// Pure, testable helpers for the Gym tab. No window.api / DOM access here —
// everything takes explicit data so it's unit-testable in isolation (mirrors
// lib/injuryStats.ts, lib/profileStats.ts).

import type { GymSession, GymSet, GymTemplate, NewGymSet } from '@shared/types'

/** One contiguous run of same-exercise sets, in original order. */
export interface ExerciseBlock {
  exerciseId: string
  exerciseName: string
  sets: GymSet[]
}

/**
 * Groups a flat, position-ordered set list into consecutive same-exercise
 * runs. Two runs of the SAME exercise separated by a different exercise stay
 * separate blocks (interleaved supersets round-trip as multiple blocks in
 * exercise order, not merged) — this mirrors how the editor lets a user add
 * "+ exercise" blocks in any order.
 */
export function groupSetsIntoBlocks(sets: GymSet[]): ExerciseBlock[] {
  const ordered = [...sets].sort((a, b) => a.position - b.position)
  const blocks: ExerciseBlock[] = []
  for (const set of ordered) {
    const last = blocks[blocks.length - 1]
    if (last && last.exerciseId === set.exercise_id) {
      last.sets.push(set)
    } else {
      blocks.push({ exerciseId: set.exercise_id, exerciseName: set.exercise_name, sets: [set] })
    }
  }
  return blocks
}

/** Sum of reps × weight_kg over non-warmup sets where both are non-null. */
export function sessionVolumeKg(sets: GymSet[]): number {
  let total = 0
  for (const s of sets) {
    if (s.is_warmup) continue
    if (s.reps === null || s.weight_kg === null) continue
    total += s.reps * s.weight_kg
  }
  return total
}

/** Thousands-grouped volume, e.g. 6240 -> "6,240". Matches Intl grouping used elsewhere (toLocaleString). */
function formatVolume(kg: number): string {
  return Math.round(kg).toLocaleString('en-US')
}

/**
 * The one-line History summary. Full logs (sets present) read as
 * "5 exercises · 23 sets · 6,240 kg"; quick logs (sets empty) read as
 * "Quick log — roughly <template name>" or plain "Quick log" when unlinked
 * to a template.
 */
export function summarizeSession(session: GymSession, templateName: string | null): string {
  if (session.sets.length === 0) {
    return templateName ? `Quick log — roughly ${templateName}` : 'Quick log'
  }
  const blocks = groupSetsIntoBlocks(session.sets)
  const workingSets = session.sets.filter((s) => !s.is_warmup)
  const volume = sessionVolumeKg(session.sets)
  const exerciseWord = blocks.length === 1 ? 'exercise' : 'exercises'
  const setWord = workingSets.length === 1 ? 'set' : 'sets'
  const parts = [`${blocks.length} ${exerciseWord}`, `${workingSets.length} ${setWord}`]
  if (volume > 0) parts.push(`${formatVolume(volume)} kg`)
  return parts.join(' · ')
}

/** One prefilled set row for the editor, before it has an id (not yet saved). */
export interface PrefillSetRow {
  exerciseId: string
  exerciseName: string
  reps: number | null
  weightKg: number | null
  isWarmup: boolean
}

/**
 * Expands a template's items into editor set rows: target_sets rows per item
 * (default 3 when target_sets is null), each prefilled with the item's
 * target_reps / target_weight_kg (null-safe — a target left blank prefills
 * blank, never a fabricated number).
 */
export function prefillFromTemplate(template: GymTemplate): PrefillSetRow[] {
  const rows: PrefillSetRow[] = []
  for (const item of [...template.items].sort((a, b) => a.position - b.position)) {
    const count = item.target_sets ?? 3
    for (let i = 0; i < count; i++) {
      rows.push({
        exerciseId: item.exercise_id,
        exerciseName: item.exercise_name,
        reps: item.target_reps,
        weightKg: item.target_weight_kg,
        isWarmup: false
      })
    }
  }
  return rows
}

/** /strength|core/i test against a workout type — single source for the Gym tab. */
export function isStrengthWorkout(type: string | null): boolean {
  if (!type) return false
  return /strength|core/i.test(type)
}

/** Converts editor set rows (grouped by exercise, in block order) into the flat NewGymSet[] the API expects. */
export function blocksToNewSets(blocks: { exerciseId: string; sets: PrefillSetRow[] }[]): NewGymSet[] {
  const out: NewGymSet[] = []
  for (const block of blocks) {
    for (const row of block.sets) {
      out.push({
        exercise_id: block.exerciseId,
        reps: row.reps,
        weight_kg: row.weightKg,
        is_warmup: row.isWarmup
      })
    }
  }
  return out
}
