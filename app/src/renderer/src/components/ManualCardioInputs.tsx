import { useMemo, useState, type ReactElement } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Heart } from 'lucide-react'
import type { Workout, WorkoutManualInputsPatch } from '@shared/types'
import { ActivityBadge } from './ActivityBadge'
import { ModalityIcon } from './ModalityIcon'
import { activityEnvironmentAccent, modalityLabel } from './modalityAccent'
import { EM_DASH, formatDurationHM } from '../lib/format'
import './ManualCardioInputs.css'

/**
 * Indoor-cardio EF inputs (agent_log 34 + 35).
 *
 * Indoor sessions buy training load but no EVIDENCE: a trainer reports no
 * trustworthy distance, an erg reports none at all, and Apple's treadmill
 * distance comes from an accelerometer model calibrated on outdoor GPS runs,
 * not indoor ones. So the efficiency channel — the signal that narrows the
 * Zone-2 confidence band most once a session with real distance or power
 * reaches it — was closed to every indoor session.
 *
 * This panel is the way in, one field set per machine. It mirrors the rules in
 * metrics/models.py exactly; if those change, change these together.
 */

const PAGE_SIZE = 5

type ManualField = 'manual_avg_watts' | 'manual_distance_m' | 'manual_incline_pct'

export interface FieldSpec {
  key: ManualField
  label: string
  unit: string
  /** Rejected outside this range, matching the DB check constraints. */
  min: number
  max: number
  hint: string
}

const WATTS_FIELD: FieldSpec = {
  key: 'manual_avg_watts',
  label: 'Avg power',
  unit: 'W',
  min: 1,
  max: 1999,
  hint: 'Average watts from the console — machine-independent, unlike its distance.'
}

const DISTANCE_FIELD: FieldSpec = {
  key: 'manual_distance_m',
  label: 'Distance',
  unit: 'm',
  min: 1,
  max: 999999,
  hint: 'Metres from the console. Supersedes any distance the watch estimated.'
}

const INCLINE_FIELD: FieldSpec = {
  key: 'manual_incline_pct',
  label: 'Incline',
  unit: '%',
  min: -30,
  max: 40,
  hint: 'Grade in percent. Required for treadmill EF, which is only computed at 1% or flatter.'
}

/** Which inputs a session accepts, or null when it is not an indoor-cardio session. */
export function manualFieldsFor(type: string): FieldSpec[] | null {
  const t = type.toLowerCase()
  const indoor = t.includes('indoor') || t.includes('treadmill') || t.includes('stationary')
  if (/(?:^|[^a-z])rowing/.test(t)) return [DISTANCE_FIELD]
  if (indoor && t.includes('run')) return [DISTANCE_FIELD, INCLINE_FIELD]
  if (indoor && (t.includes('cycl') || t.includes('bik'))) return [WATTS_FIELD]
  return null
}

function fmtStored(value: number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(Number(value.toFixed(2)))
}

/** '' clears the value; anything unparseable or out of range is rejected. */
export function parseField(raw: string, spec: FieldSpec): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return 'invalid'
  if (parsed < spec.min || parsed > spec.max) return 'invalid'
  return parsed
}

export interface ManualCardioInputsProps {
  workouts: Workout[]
  timezone: string | null | undefined
}

export function ManualCardioInputs({
  workouts,
  timezone
}: ManualCardioInputsProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)

  const eligible = useMemo(
    () =>
      workouts
        .filter((w) => manualFieldsFor(w.type) !== null)
        .sort((a, b) => b.start_at.localeCompare(a.start_at)),
    [workouts]
  )

  if (eligible.length === 0) return null

  const shown = expanded ? eligible : eligible.slice(0, PAGE_SIZE)

  return (
    <section className="manual-cardio" aria-labelledby="manual-cardio-title">
      <div className="manual-cardio-head">
        <h3 className="manual-cardio-title" id="manual-cardio-title">
          Indoor cardio inputs
        </h3>
        <p className="manual-cardio-note">
          Indoor machines report no trustworthy distance, so these sessions reach the Zone-2
          efficiency signal only through what you type here. Values are picked up by the next
          nightly metrics run, which recomputes the last 60 days — an older session needs a
          full recompute.
        </p>
      </div>

      <ul className="manual-cardio-rows">
        {shown.map((workout) => (
          <ManualCardioRow key={workout.id} workout={workout} timezone={timezone} />
        ))}
      </ul>

      {eligible.length > PAGE_SIZE && (
        <button
          type="button"
          className="manual-cardio-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show fewer' : `Show all ${eligible.length}`}
        </button>
      )}
    </section>
  )
}

function ManualCardioRow({
  workout,
  timezone
}: {
  workout: Workout
  timezone: string | null | undefined
}): ReactElement {
  const specs = manualFieldsFor(workout.type) as FieldSpec[]
  const queryClient = useQueryClient()

  const stored = useMemo(
    () => Object.fromEntries(specs.map((s) => [s.key, fmtStored(workout[s.key])])),
    // The stored values are the edit baseline; they change only when a save (or a
    // nightly sync) refetches the workout.
    [workout, specs]
  ) as Record<ManualField, string>

  const [draft, setDraft] = useState<Record<ManualField, string>>(stored)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (patch: WorkoutManualInputsPatch) =>
      window.api.updateWorkoutManualInputs(workout.id, patch),
    onSuccess: () => {
      setError(null)
      // Every workout query shares the 'health' root key; refetching them is
      // cheaper than reasoning about which windows contain this session.
      void queryClient.invalidateQueries({ queryKey: ['health'] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Save failed')
  })

  const dirty = specs.some((s) => (draft[s.key] ?? '') !== (stored[s.key] ?? ''))

  function handleSave(): void {
    const patch: WorkoutManualInputsPatch = {}
    for (const spec of specs) {
      const value = parseField(draft[spec.key] ?? '', spec)
      if (value === 'invalid') {
        setError(`${spec.label} must be between ${spec.min} and ${spec.max} ${spec.unit}`)
        return
      }
      patch[spec.key] = value
    }
    setError(null)
    save.mutate(patch)
  }

  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(new Date(workout.start_at))

  // Cycling shows POWER EF (W/bpm); everything else shows speed EF (m/min per
  // beat). Different units — deliberately never rendered on one shared scale.
  const isPower = specs[0].key === 'manual_avg_watts'
  const efValue = isPower ? workout.computed?.power_ef : workout.computed?.ef
  const efUnit = isPower ? 'W/bpm' : 'm/min/bpm'

  return (
    <li className="manual-cardio-row">
      <div className="manual-cardio-meta">
        <span className="manual-cardio-date tabular-nums">{dateLabel}</span>
        <span
          className="manual-cardio-modality"
          style={{ color: activityEnvironmentAccent(workout.type) }}
        >
          <ModalityIcon type={workout.type} className="manual-cardio-modality-icon" />
          <ActivityBadge type={workout.type} label={modalityLabel(workout.type)} />
        </span>
        <span className="manual-cardio-stat tabular-nums">
          {formatDurationHM(workout.duration_s ?? 0)}
        </span>
        <span className="manual-cardio-stat tabular-nums">
          {workout.avg_hr !== null ? (
            <>
              <Heart size={12} strokeWidth={1.75} className="manual-cardio-hr-icon" />
              {Math.round(workout.avg_hr)}
            </>
          ) : (
            EM_DASH
          )}
        </span>
        <span className="manual-cardio-ef tabular-nums">
          {efValue !== null && efValue !== undefined
            ? `EF ${efValue.toFixed(2)} ${efUnit}`
            : `EF ${EM_DASH}`}
        </span>
      </div>

      <div className="manual-cardio-fields">
        {specs.map((spec) => (
          <label key={spec.key} className="manual-cardio-field">
            <span className="manual-cardio-field-label">{spec.label}</span>
            <span className="manual-cardio-field-control">
              <input
                type="text"
                inputMode="decimal"
                className="manual-cardio-input"
                placeholder={spec.unit}
                value={draft[spec.key] ?? ''}
                title={spec.hint}
                aria-label={`${spec.label} in ${spec.unit} for the ${modalityLabel(
                  workout.type
                )} session on ${dateLabel}`}
                onChange={(e) => setDraft({ ...draft, [spec.key]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirty) handleSave()
                }}
              />
              <span className="manual-cardio-unit">{spec.unit}</span>
            </span>
          </label>
        ))}
        <button
          type="button"
          className="manual-cardio-save"
          onClick={handleSave}
          disabled={!dirty || save.isPending}
        >
          {save.isPending ? 'Saving' : 'Save'}
        </button>
      </div>

      {error && (
        <p className="manual-cardio-error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}
