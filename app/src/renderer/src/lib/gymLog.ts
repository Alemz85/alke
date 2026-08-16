// Pure, testable helpers for the Gym tab. No window.api / DOM access here —
// everything takes explicit data so it's unit-testable in isolation (mirrors
// lib/injuryStats.ts, lib/profileStats.ts).

import { GYM_BODY_PARTS, type Exercise, type GymSession, type GymSet, type GymTemplate, type NewGymSet } from '@shared/types'
import type { ExerciseUsageEntry } from './exerciseSearch'

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

export interface BodyPartExerciseGroup {
  bodyPart: string
  blocks: ExerciseBlock[]
}

/**
 * Group adjacent logged exercise runs under body-part headings without ever
 * changing their position order. A body part may therefore appear more than
 * once when the workout alternates between regions.
 */
export function groupExerciseBlocksByBodyPart(
  blocks: ExerciseBlock[],
  exercisesById: Map<string, Exercise>
): BodyPartExerciseGroup[] {
  const groups: BodyPartExerciseGroup[] = []
  for (const block of blocks) {
    const part = exercisesById.get(block.exerciseId)?.body_part ?? 'other'
    const last = groups[groups.length - 1]
    if (last?.bodyPart === part) last.blocks.push(block)
    else groups.push({ bodyPart: part, blocks: [block] })
  }
  return groups
}

/**
 * Compact working-set prescription for a collapsed exercise disclosure. Reads a
 * time-counted block as a hold ("3 × 45s") — the dose measure comes from the
 * sets themselves, so a block of holds never summarises as a rep count.
 */
export function formatExerciseSetSummary(sets: GymSet[]): string {
  const working = sets.filter((set) => !set.is_warmup)
  if (working.length === 0) return 'Warm-up only'
  const timed = working.every((set) => set.duration_s != null)
  const doses = working.map((set) => (timed ? set.duration_s : set.reps))
  const unit = (value: number | null): string => (timed ? `${value}s` : String(value))
  if (doses.every((value) => value != null && value === doses[0])) {
    return `${working.length} × ${unit(doses[0])}`
  }
  if (doses.every((value) => value != null)) {
    return `${working.length} sets · ${doses.map(unit).join(' / ')}`
  }
  return `${working.length} ${working.length === 1 ? 'set' : 'sets'}`
}

/**
 * Column label for a block's dose: "Hold" when every working set is
 * time-counted, else "Reps". The cell values carry their own unit, so this is
 * about the header not contradicting the column beneath it.
 */
export function setDoseLabel(sets: Pick<GymSet, 'duration_s' | 'is_warmup'>[]): string {
  const working = sets.filter((set) => !set.is_warmup)
  const measured = working.length > 0 ? working : sets
  return measured.length > 0 && measured.every((set) => set.duration_s != null) ? 'Hold' : 'Reps'
}

/**
 * One logged set's dose for a table cell: "8" for reps, "45s" for a hold, and
 * the caller's blank otherwise. The unit is carried in the value so a timed set
 * reads correctly even under a column headed "Reps".
 */
export function formatSetDose(set: Pick<GymSet, 'reps' | 'duration_s'>, blank = '—'): string {
  if (set.duration_s != null) return `${set.duration_s}s`
  return set.reps != null ? String(set.reps) : blank
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

/** "legs" -> "Legs", "full body" -> "Full body" — display form of a body part. */
export function displayBodyPart(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1)
}

/** Rest duration for display: under 60s -> "45s"; 60s+ -> "m:ss" like "1:30". */
export function formatRest(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/**
 * The body parts a session touched, in GYM_BODY_PARTS order. Sets win over
 * the stored declaration: with sets present, derive from the set exercises'
 * body_part metadata (exercises looked up by id; customs without a body part
 * contribute nothing); without sets, fall back to the user-declared
 * session.body_parts (the lazy tier).
 */
export function sessionBodyParts(session: GymSession, exercisesById: Map<string, Exercise>): string[] {
  const found = new Set<string>()
  if (session.sets.length > 0) {
    for (const set of session.sets) {
      const part = exercisesById.get(set.exercise_id)?.body_part
      if (part) found.add(part)
    }
  } else {
    for (const part of session.body_parts ?? []) found.add(part)
  }
  return GYM_BODY_PARTS.filter((p) => found.has(p))
}

/**
 * The one-line History summary, by granularity tier: full logs (sets present)
 * read as "5 exercises · 23 sets · 6,240 kg"; set-less logs fall back to the
 * declared body parts ("Body parts — Legs · Core"), then the template
 * ("Quick log — roughly <template name>"), then plain "Quick log".
 */
export function summarizeSession(session: GymSession, templateName: string | null): string {
  if (session.sets.length === 0) {
    const parts = sessionBodyParts(session, new Map())
    if (parts.length > 0) {
      return `Body parts — ${parts.map(displayBodyPart).join(' · ')}`
    }
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
  /** One dose measure per row: reps OR a held duration, never both. */
  reps: number | null
  durationS?: number | null
  weightKg: number | null
  isWarmup: boolean
  /** Session-only context. Templates and quick generators leave these blank. */
  rpe?: number | null
  note?: string | null
}

/** Recover one compact prescription from already-expanded template rows. */
export function uniformPrefillDose(rows: PrefillSetRow[]): { sets: string; reps: string } {
  if (rows.length === 0 || rows.some((row) => row.reps == null || row.reps !== rows[0].reps)) {
    return { sets: '', reps: '' }
  }
  return { sets: String(rows.length), reps: String(rows[0].reps) }
}

/** Build a simple editable prescription from the logger's Sets + Reps shortcut. */
export function buildQuickSetRows(
  exerciseId: string,
  exerciseName: string,
  setCount: number,
  reps: number
): PrefillSetRow[] | null {
  if (
    !exerciseId ||
    !Number.isInteger(setCount) ||
    setCount <= 0 ||
    !Number.isInteger(reps) ||
    reps <= 0
  ) {
    return null
  }
  return Array.from({ length: setCount }, () => ({
    exerciseId,
    exerciseName,
    reps,
    weightKg: null,
    isWarmup: false
  }))
}

/**
 * Expands a template's items into editor set rows: target_sets rows per item
 * (default 3 when target_sets is null), each prefilled with the item's
 * target_reps / target_weight_kg (null-safe — a target left blank prefills
 * blank, never a fabricated number).
 *
 * A time-counted item (target_duration_seconds) still contributes its set rows,
 * with reps left blank: gym_sets records reps, and stamping "1" for a 45-second
 * hold would log a rep count that never happened. The prescribed hold stays on
 * the template, which is where it is read from.
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
        durationS: item.target_duration_seconds,
        weightKg: item.target_weight_kg,
        isWarmup: false
      })
    }
  }
  return rows
}

/**
 * Expands several templates without merging their exercise runs. The caller
 * supplies templates in the order the user selected them, which becomes the
 * session-editor order (for example: rehab, then core, then upper body).
 */
export function prefillFromTemplates(templates: GymTemplate[]): PrefillSetRow[] {
  return templates.flatMap(prefillFromTemplate)
}

/**
 * The most recent prior performance of an exercise: working sets (warmups
 * excluded) from the newest session containing it, skipping the session being
 * edited. Null when the exercise has never been logged (or only as warmups).
 */
export function lastPerformance(
  exerciseId: string,
  sessions: GymSession[],
  excludeSessionId: string | null
): { sets: GymSet[]; performedAt: string } | null {
  const candidates = sessions
    .filter((s) => s.id !== excludeSessionId)
    .sort((a, b) => b.performed_at.localeCompare(a.performed_at))
  for (const session of candidates) {
    const sets = session.sets
      .filter((s) => s.exercise_id === exerciseId && !s.is_warmup)
      .sort((a, b) => a.position - b.position)
    if (sets.length > 0) return { sets, performedAt: session.performed_at }
  }
  return null
}

/** The only equipment for which a blank weight is a reading rather than a gap:
 * these movements carry no kilogram to record. Mirrors UNLOADED_EQUIPMENT in
 * chatctx/gym.py — keep the two in step. */
const UNLOADED_EQUIPMENT = new Set(['bodyweight', 'band'])

/**
 * "8×80 · 8×80 · 8×77.5" — compact reps×kg rendering of a working-set list. A
 * time-counted set renders its hold ("45s×bw") rather than the '?' an absent
 * rep count would otherwise show.
 *
 * A blank weight_kg means two different things and the difference matters: no
 * external load (a pelvic drop) versus a weight nobody typed (a leg extension
 * logged in a hurry). Rendering both as "bw" made a blank machine set read as a
 * real bodyweight performance, so the next session at 10 kg looked like a load
 * increase that never happened (chatctx agent_log #17). Pass the exercise's
 * catalog `equipment` and the two render apart: "bw" only where the movement
 * genuinely carries none, "?kg" everywhere else — including an uncatalogued
 * exercise, where guessing bodyweight is the mistake being fixed.
 */
export function formatSetLine(sets: GymSet[], equipment?: string | null): string {
  const blank = equipment != null && UNLOADED_EQUIPMENT.has(equipment) ? 'bw' : '?kg'
  return sets
    .map((s) => {
      const dose = s.duration_s != null ? `${s.duration_s}s` : (s.reps ?? '?')
      return `${dose}×${s.weight_kg === null ? blank : s.weight_kg}`
    })
    .join(' · ')
}

/**
 * Per-exercise usage from the fetched sessions: how many sessions contain the
 * exercise + the most recent performed_at. Feeds the picker's "most likely"
 * ranking (lib/exerciseSearch.ts).
 */
export function exerciseUsage(sessions: GymSession[]): Map<string, ExerciseUsageEntry> {
  const usage = new Map<string, ExerciseUsageEntry>()
  for (const session of sessions) {
    const inSession = new Set(session.sets.map((s) => s.exercise_id))
    for (const id of inSession) {
      const prev = usage.get(id)
      usage.set(id, {
        count: (prev?.count ?? 0) + 1,
        lastIso:
          prev?.lastIso && prev.lastIso > session.performed_at ? prev.lastIso : session.performed_at
      })
    }
  }
  return usage
}

/** One muscle's weekly training volume in sets (fractional — see muscleSetVolume). */
export interface MuscleVolume {
  muscle: string
  sets: number
}

/**
 * Training volume per muscle across the given sessions, in working sets
 * (warmups excluded): a set credits its exercise's primary muscles 1.0 each
 * and secondary muscles 0.5 each — the common fractional-set convention for
 * weekly volume counting. Sorted by volume desc; muscles with zero volume are
 * omitted. Customs without muscle metadata contribute nothing (honest gap,
 * not a guess).
 */
export function muscleSetVolume(
  sessions: GymSession[],
  exercisesById: Map<string, Exercise>
): MuscleVolume[] {
  const volume = new Map<string, number>()
  for (const session of sessions) {
    for (const set of session.sets) {
      if (set.is_warmup) continue
      const exercise = exercisesById.get(set.exercise_id)
      if (!exercise) continue
      for (const muscle of exercise.primary_muscles) {
        volume.set(muscle, (volume.get(muscle) ?? 0) + 1)
      }
      for (const muscle of exercise.secondary_muscles) {
        volume.set(muscle, (volume.get(muscle) ?? 0) + 0.5)
      }
    }
  }
  return [...volume.entries()]
    .map(([muscle, sets]) => ({ muscle, sets }))
    .sort((a, b) => b.sets - a.sets || a.muscle.localeCompare(b.muscle))
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
        duration_s: row.durationS ?? null,
        weight_kg: row.weightKg,
        rpe: row.rpe ?? null,
        note: row.note?.trim() || null,
        is_warmup: row.isWarmup
      })
    }
  }
  return out
}
