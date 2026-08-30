import { useMemo, useState, type ReactElement } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Workout, WorkoutManualInputsPatch } from '@shared/types'
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
 * ManualCardioSection is the way in: it renders inside the day drawer's session
 * card (the same slot the gym log occupies for strength workouts), one field set
 * per machine. It mirrors the rules in metrics/models.py exactly; if those
 * change, change these together.
 */

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

/**
 * Machine-data entry for one indoor-cardio session, drawn as a drawer section.
 * Renders null for any workout `manualFieldsFor` does not recognize, so the
 * caller may mount it unconditionally on non-strength sessions.
 */
export function ManualCardioSection({ workout }: { workout: Workout }): ReactElement | null {
  const specs = manualFieldsFor(workout.type)
  const queryClient = useQueryClient()

  const stored = useMemo(
    () => Object.fromEntries((specs ?? []).map((s) => [s.key, fmtStored(workout[s.key])])),
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

  if (specs === null) return null

  const dirty = specs.some((s) => (draft[s.key] ?? '') !== (stored[s.key] ?? ''))

  function handleSave(): void {
    const patch: WorkoutManualInputsPatch = {}
    for (const spec of specs ?? []) {
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

  return (
    <div className="manual-cardio">
      <div className="day-drawer-section-label">Machine data</div>
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
                aria-label={`${spec.label} in ${spec.unit}`}
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
      <p className="manual-cardio-note">
        The machine's numbers are this session's only path into the Zone-2 efficiency signal.
        Read by the next nightly run, which covers the last 60 days — an older session needs a
        full recompute.
      </p>
      {error && (
        <p className="manual-cardio-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
