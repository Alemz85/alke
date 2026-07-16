import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import type { UserConfig, UserConfigPatch } from '@shared/types'
import { isQueuedWriteReceipt } from '../lib/optimisticEntities'
import { TabHeader } from './TabHeader'
import './SettingsView.css'

// Known modality goals a user can add rows for (DESIGN: sessions domain, but
// this is neutral chrome so no accent). Order is the fixed pick-list order.
const KNOWN_MODALITIES = ['swim', 'lift', 'bike', 'row', 'cardio'] as const
const MODALITY_LABELS: Record<string, string> = {
  swim: 'Swim',
  lift: 'Lift',
  bike: 'Bike',
  row: 'Row',
  cardio: 'Cardio'
}

// The editable draft mirrors UserConfig's editable fields, but holds every
// numeric field as a string so inputs can be transiently empty/partial while
// typing. fracs are shown as 0–100 percentages.
interface Draft {
  hr_max: string
  swim_hr_offset: string
  zone2_low_pct: string
  zone2_high_pct: string
  zone2_weekly_target_min: string
  sleep_goal_hours: string
  bedtime_goal: string
  weekly_min_sessions: Record<string, number>
  timezone: string
}

function minutesToClock(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '00:00'
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${Math.floor(normalized / 60).toString().padStart(2, '0')}:${(normalized % 60).toString().padStart(2, '0')}`
}

function clockToMinutes(clock: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null
}

function fracToPct(frac: number | null): string {
  return frac == null ? '' : String(Math.round(frac * 10000) / 100)
}

function numOrEmpty(n: number | null): string {
  return n == null ? '' : String(n)
}

function toDraft(cfg: UserConfig): Draft {
  const sessions: Record<string, number> = {}
  const raw = cfg.weekly_min_sessions ?? {}
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v)
    sessions[k] = Number.isFinite(n) ? n : 0
  }
  return {
    hr_max: numOrEmpty(cfg.hr_max),
    swim_hr_offset: numOrEmpty(cfg.swim_hr_offset),
    zone2_low_pct: fracToPct(cfg.zone2_low_frac),
    zone2_high_pct: fracToPct(cfg.zone2_high_frac),
    zone2_weekly_target_min: String(cfg.zone2_weekly_target_min ?? ''),
    sleep_goal_hours: String((cfg.sleep_goal_min ?? 480) / 60),
    bedtime_goal: minutesToClock(cfg.bedtime_goal_min ?? 0),
    weekly_min_sessions: sessions,
    timezone: cfg.timezone ?? ''
  }
}

// Parse "" → null, otherwise a finite number, else NaN sentinel via null-guard.
function parseNumOrNull(s: string): number | null | 'invalid' {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : 'invalid'
}

function sessionsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => b[k] === a[k])
}

const TIMEZONES: string[] = (() => {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf
    return typeof sv === 'function' ? sv('timeZone') : []
  } catch {
    return []
  }
})()

function isValidTimezone(tz: string): boolean {
  if (tz.trim() === '') return false
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function SettingsView(): ReactElement {
  const queryClient = useQueryClient()
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => window.api.getUserConfig(),
    staleTime: 60_000
  })

  const loaded = configQuery.data
  const [draft, setDraft] = useState<Draft | null>(null)
  const [savedVisible, setSavedVisible] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Hydrate/refresh the draft when the loaded config changes and there is no
  // in-flight local edit diverging from it (draft null = not yet hydrated).
  useEffect(() => {
    if (loaded && draft === null) {
      setDraft(toDraft(loaded))
    }
  }, [loaded, draft])

  const mutation = useMutation({
    mutationFn: (patch: UserConfigPatch) => window.api.updateUserConfig(patch),
    onSuccess: (fresh) => {
      if (isQueuedWriteReceipt(fresh)) {
        // Offline: the patch is durably queued; keep the local draft as the
        // source of truth and skip the global refetch (the server still holds
        // the old config until the queue flushes).
        setSaveError(null)
        setSavedVisible(true)
        return
      }
      setDraft(toDraft(fresh))
      setSaveError(null)
      setSavedVisible(true)
      // Refresh every tab so new zones/targets propagate.
      queryClient.invalidateQueries()
    },
    onError: (err: unknown) => {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  })

  // Fade the "Saved" caption after 2s.
  useEffect(() => {
    if (!savedVisible) return
    const t = setTimeout(() => setSavedVisible(false), 2000)
    return () => clearTimeout(t)
  }, [savedVisible])

  // ── Field-level validation (only for genuine errors) ──────────────────────
  const errors = useMemo(() => {
    const e: Record<string, string> = {}
    if (!draft) return e
    const hrMax = parseNumOrNull(draft.hr_max)
    if (hrMax === 'invalid') e.hr_max = 'Enter a number.'
    else if (hrMax != null && hrMax <= 0) e.hr_max = 'Must be greater than 0.'

    const swim = parseNumOrNull(draft.swim_hr_offset)
    if (swim === 'invalid') e.swim_hr_offset = 'Enter a number.'

    const low = parseNumOrNull(draft.zone2_low_pct)
    const high = parseNumOrNull(draft.zone2_high_pct)
    if (low === 'invalid') e.zone2_low_pct = 'Enter a percentage.'
    else if (low != null && (low < 0 || low > 100)) e.zone2_low_pct = 'Must be 0–100%.'
    if (high === 'invalid') e.zone2_high_pct = 'Enter a percentage.'
    else if (high != null && (high < 0 || high > 100)) e.zone2_high_pct = 'Must be 0–100%.'
    if (
      typeof low === 'number' &&
      typeof high === 'number' &&
      low >= high &&
      !e.zone2_low_pct &&
      !e.zone2_high_pct
    ) {
      e.zone2_high_pct = 'Upper bound must exceed the lower bound.'
    }

    const target = parseNumOrNull(draft.zone2_weekly_target_min)
    if (target === 'invalid') e.zone2_weekly_target_min = 'Enter a number.'
    else if (target == null) e.zone2_weekly_target_min = 'Required.'
    else if (target < 0 || !Number.isInteger(target))
      e.zone2_weekly_target_min = 'Whole minutes, 0 or more.'

    const sleepGoal = parseNumOrNull(draft.sleep_goal_hours)
    if (sleepGoal === 'invalid') e.sleep_goal_hours = 'Enter a number.'
    else if (sleepGoal == null) e.sleep_goal_hours = 'Required.'
    else if (sleepGoal < 1 || sleepGoal > 24) e.sleep_goal_hours = 'Choose 1 to 24 hours.'

    if (clockToMinutes(draft.bedtime_goal) === null)
      e.bedtime_goal = 'Enter a valid time.'

    if (draft.timezone.trim() !== '' && !isValidTimezone(draft.timezone))
      e.timezone = 'Not a recognized IANA time zone.'
    else if (draft.timezone.trim() === '') e.timezone = 'Required.'

    return e
  }, [draft])

  const hasErrors = Object.keys(errors).length > 0

  // ── Build a patch of only the changed keys ────────────────────────────────
  const patch = useMemo<UserConfigPatch>(() => {
    if (!draft || !loaded) return {}
    const p: UserConfigPatch = {}
    const hrMax = parseNumOrNull(draft.hr_max)
    if (hrMax !== 'invalid' && hrMax !== loaded.hr_max) p.hr_max = hrMax
    const swim = parseNumOrNull(draft.swim_hr_offset)
    if (swim !== 'invalid' && swim !== loaded.swim_hr_offset) p.swim_hr_offset = swim

    const lowPct = parseNumOrNull(draft.zone2_low_pct)
    if (lowPct !== 'invalid') {
      const frac = lowPct == null ? null : Math.round((lowPct / 100) * 10000) / 10000
      if (frac !== loaded.zone2_low_frac) p.zone2_low_frac = frac
    }
    const highPct = parseNumOrNull(draft.zone2_high_pct)
    if (highPct !== 'invalid') {
      const frac = highPct == null ? null : Math.round((highPct / 100) * 10000) / 10000
      if (frac !== loaded.zone2_high_frac) p.zone2_high_frac = frac
    }

    const target = parseNumOrNull(draft.zone2_weekly_target_min)
    if (typeof target === 'number' && target !== loaded.zone2_weekly_target_min)
      p.zone2_weekly_target_min = target

    const sleepGoal = parseNumOrNull(draft.sleep_goal_hours)
    if (typeof sleepGoal === 'number') {
      const minutes = Math.round(sleepGoal * 60)
      if (minutes !== loaded.sleep_goal_min) p.sleep_goal_min = minutes
    }

    const bedtimeGoal = clockToMinutes(draft.bedtime_goal)
    if (bedtimeGoal !== null && bedtimeGoal !== loaded.bedtime_goal_min)
      p.bedtime_goal_min = bedtimeGoal

    const loadedSessions = toDraft(loaded).weekly_min_sessions
    if (!sessionsEqual(draft.weekly_min_sessions, loadedSessions))
      p.weekly_min_sessions = draft.weekly_min_sessions

    if (draft.timezone.trim() !== '' && draft.timezone !== loaded.timezone)
      p.timezone = draft.timezone.trim()

    return p
  }, [draft, loaded])

  const isDirty = Object.keys(patch).length > 0
  const canSave = isDirty && !hasErrors && !mutation.isPending

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    setSavedVisible(false)
  }

  function setSession(key: string, value: number): void {
    setDraft((d) =>
      d ? { ...d, weekly_min_sessions: { ...d.weekly_min_sessions, [key]: value } } : d
    )
    setSavedVisible(false)
  }

  function removeSession(key: string): void {
    setDraft((d) => {
      if (!d) return d
      const next = { ...d.weekly_min_sessions }
      delete next[key]
      return { ...d, weekly_min_sessions: next }
    })
    setSavedVisible(false)
  }

  function addSession(key: string): void {
    if (!key) return
    setDraft((d) =>
      d && !(key in d.weekly_min_sessions)
        ? { ...d, weekly_min_sessions: { ...d.weekly_min_sessions, [key]: 1 } }
        : d
    )
    setSavedVisible(false)
  }

  function onSave(): void {
    if (!canSave) return
    mutation.mutate(patch)
  }

  const availableModalities = draft
    ? KNOWN_MODALITIES.filter((m) => !(m in draft.weekly_min_sessions))
    : []

  return (
    <div className="view settings-view">
      <TabHeader eyebrow="Configuration" title="Settings" />

      {configQuery.isLoading || !draft ? (
        <p className="settings-caption">Loading your configuration…</p>
      ) : configQuery.isError ? (
        <p className="settings-error-caption">Couldn’t load configuration.</p>
      ) : (
        <div className="settings-cards">
          {/* ── Heart rate ─────────────────────────────────────────────── */}
          <section className="settings-card" aria-labelledby="settings-hr-title">
            <h2 className="settings-card-title" id="settings-hr-title">
              Heart rate
            </h2>

            <div className="settings-field">
              <label className="settings-label" htmlFor="hr_max">
                Max heart rate
              </label>
              <div className="settings-input-row">
                <input
                  id="hr_max"
                  className="text-input tabular-nums settings-input--num"
                  type="number"
                  inputMode="numeric"
                  value={draft.hr_max}
                  onChange={(e) => update('hr_max', e.target.value)}
                  aria-invalid={!!errors.hr_max}
                />
                <span className="settings-unit">bpm</span>
              </div>
              {errors.hr_max && <p className="settings-field-error">{errors.hr_max}</p>}
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="swim_hr_offset">
                Swim HR offset
              </label>
              <div className="settings-input-row">
                <input
                  id="swim_hr_offset"
                  className="text-input tabular-nums settings-input--num"
                  type="number"
                  inputMode="numeric"
                  value={draft.swim_hr_offset}
                  onChange={(e) => update('swim_hr_offset', e.target.value)}
                  aria-invalid={!!errors.swim_hr_offset}
                />
                <span className="settings-unit">bpm</span>
              </div>
              <p className="settings-help">
                Swim wrist readings run low; this shifts zone bounds for swims.
              </p>
              {errors.swim_hr_offset && (
                <p className="settings-field-error">{errors.swim_hr_offset}</p>
              )}
            </div>

            <div className="settings-field-pair">
              <div className="settings-field">
                <label className="settings-label" htmlFor="zone2_low_pct">
                  Zone 2 lower bound
                </label>
                <div className="settings-input-row">
                  <input
                    id="zone2_low_pct"
                    className="text-input tabular-nums settings-input--num"
                    type="number"
                    inputMode="numeric"
                    value={draft.zone2_low_pct}
                    onChange={(e) => update('zone2_low_pct', e.target.value)}
                    aria-invalid={!!errors.zone2_low_pct}
                  />
                  <span className="settings-unit">%</span>
                </div>
                {errors.zone2_low_pct && (
                  <p className="settings-field-error">{errors.zone2_low_pct}</p>
                )}
              </div>

              <div className="settings-field">
                <label className="settings-label" htmlFor="zone2_high_pct">
                  Zone 2 upper bound
                </label>
                <div className="settings-input-row">
                  <input
                    id="zone2_high_pct"
                    className="text-input tabular-nums settings-input--num"
                    type="number"
                    inputMode="numeric"
                    value={draft.zone2_high_pct}
                    onChange={(e) => update('zone2_high_pct', e.target.value)}
                    aria-invalid={!!errors.zone2_high_pct}
                  />
                  <span className="settings-unit">%</span>
                </div>
                {errors.zone2_high_pct && (
                  <p className="settings-field-error">{errors.zone2_high_pct}</p>
                )}
              </div>
            </div>

            <p className="settings-card-footnote">
              hr_max is auto-raised by the nightly job when a workout exceeds it.
            </p>
          </section>

          <section className="settings-card" aria-labelledby="settings-sleep-title">
            <h2 className="settings-card-title" id="settings-sleep-title">
              Sleep &amp; recovery
            </h2>

            <div className="settings-field-pair">
              <div className="settings-field">
                <label className="settings-label" htmlFor="sleep_goal_hours">
                  Sleep duration goal
                </label>
                <div className="settings-input-row">
                  <input
                    id="sleep_goal_hours"
                    className="text-input tabular-nums settings-input--num"
                    type="number"
                    min={1}
                    max={24}
                    step={0.25}
                    inputMode="decimal"
                    value={draft.sleep_goal_hours}
                    onChange={(e) => update('sleep_goal_hours', e.target.value)}
                    aria-invalid={!!errors.sleep_goal_hours}
                  />
                  <span className="settings-unit">hours</span>
                </div>
                {errors.sleep_goal_hours && (
                  <p className="settings-field-error">{errors.sleep_goal_hours}</p>
                )}
              </div>

              <div className="settings-field">
                <label className="settings-label" htmlFor="bedtime_goal">
                  Bedtime goal
                </label>
                <input
                  id="bedtime_goal"
                  className="text-input tabular-nums settings-input--time"
                  type="time"
                  value={draft.bedtime_goal}
                  onChange={(e) => update('bedtime_goal', e.target.value)}
                  aria-invalid={!!errors.bedtime_goal}
                />
                {errors.bedtime_goal && (
                  <p className="settings-field-error">{errors.bedtime_goal}</p>
                )}
              </div>
            </div>

            <p className="settings-card-footnote">
              These targets appear as reference lines in Recovery charts.
            </p>
          </section>

          {/* ── Training targets ───────────────────────────────────────── */}
          <section className="settings-card" aria-labelledby="settings-targets-title">
            <h2 className="settings-card-title" id="settings-targets-title">
              Training targets
            </h2>

            <div className="settings-field">
              <label className="settings-label" htmlFor="zone2_weekly_target_min">
                Weekly Zone 2 target
              </label>
              <div className="settings-input-row">
                <input
                  id="zone2_weekly_target_min"
                  className="text-input tabular-nums settings-input--num"
                  type="number"
                  inputMode="numeric"
                  value={draft.zone2_weekly_target_min}
                  onChange={(e) => update('zone2_weekly_target_min', e.target.value)}
                  aria-invalid={!!errors.zone2_weekly_target_min}
                />
                <span className="settings-unit">min / week</span>
              </div>
              {errors.zone2_weekly_target_min && (
                <p className="settings-field-error">{errors.zone2_weekly_target_min}</p>
              )}
            </div>

            <div className="settings-field">
              <span className="settings-label">Weekly minimum sessions</span>
              <div className="settings-sessions">
                {Object.keys(draft.weekly_min_sessions).length === 0 ? (
                  <p className="settings-help">No modality minimums set yet.</p>
                ) : (
                  Object.entries(draft.weekly_min_sessions).map(([key, count]) => (
                    <div className="settings-session-row" key={key}>
                      <span className="settings-session-name">
                        {MODALITY_LABELS[key] ?? key}
                      </span>
                      <input
                        className="text-input tabular-nums settings-input--stepper"
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={String(count)}
                        aria-label={`${MODALITY_LABELS[key] ?? key} minimum per week`}
                        onChange={(e) => {
                          const n = Number(e.target.value)
                          setSession(key, Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0)
                        }}
                      />
                      <span className="settings-session-unit">/ week</span>
                      <button
                        type="button"
                        className="settings-icon-button"
                        onClick={() => removeSession(key)}
                        aria-label={`Remove ${MODALITY_LABELS[key] ?? key}`}
                        title="Remove"
                      >
                        <X size={16} strokeWidth={1.5} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {availableModalities.length > 0 && (
                <div className="settings-add-row">
                  <select
                    className="text-input settings-add-select"
                    aria-label="Add a modality minimum"
                    value=""
                    onChange={(e) => {
                      addSession(e.target.value)
                      e.currentTarget.value = ''
                    }}
                  >
                    <option value="" disabled>
                      Add modality…
                    </option>
                    {availableModalities.map((m) => (
                      <option key={m} value={m}>
                        {MODALITY_LABELS[m]}
                      </option>
                    ))}
                  </select>
                  <span className="settings-add-hint" aria-hidden="true">
                    <Plus size={16} strokeWidth={1.5} />
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* ── Locale ─────────────────────────────────────────────────── */}
          <section className="settings-card" aria-labelledby="settings-locale-title">
            <h2 className="settings-card-title" id="settings-locale-title">
              Locale
            </h2>
            <div className="settings-field">
              <label className="settings-label" htmlFor="timezone">
                Time zone
              </label>
              <input
                id="timezone"
                className="text-input settings-input--tz"
                type="text"
                list="settings-tz-list"
                autoComplete="off"
                spellCheck={false}
                value={draft.timezone}
                onChange={(e) => update('timezone', e.target.value)}
                aria-invalid={!!errors.timezone}
              />
              <datalist id="settings-tz-list">
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
              <p className="settings-help">IANA name, e.g. America/New_York.</p>
              {errors.timezone && <p className="settings-field-error">{errors.timezone}</p>}
            </div>
          </section>

          {/* ── Save bar ───────────────────────────────────────────────── */}
          <div className="settings-save-bar">
            {isDirty && (
              <button
                type="button"
                className="button-primary"
                onClick={onSave}
                disabled={!canSave}
              >
                {mutation.isPending ? 'Saving…' : 'Save changes'}
              </button>
            )}
            <span
              className={
                savedVisible ? 'settings-saved settings-saved--visible' : 'settings-saved'
              }
              role="status"
              aria-live="polite"
            >
              Saved
            </span>
            {saveError && <span className="settings-save-error">{saveError}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
