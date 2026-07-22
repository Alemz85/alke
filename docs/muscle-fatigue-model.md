# Muscle Load & Fatigue Model — implementation spec

Provenance: designed 2026-07-12 with the user, grounded by (1) a codebase pass over the
existing load machinery (`metrics/models.py` TRIMP/CTL/ATL/ACWR, `lib/zone2Fitness.ts`),
(2) the muscle/exercise catalog, and (3) a targeted literature pass on cross-modal fatigue
+ concurrent-training interference (seeded into the private knowledge library).
It obeys the same laws as the Zone-2 fitness model: **DYNAMIC, not
hardcoded** (every state/timing constant is a continuous function of the user's own data;
only irreducible physiological priors stay literature constants, clearly marked and
personalizing as history grows), **confidence-banded**, and **honest** (thin-data muscles
say so; the cardio magnitude is labeled an estimate).

## 0. What it is, in one paragraph

For each of the **6 body-part groups** (expandable to the **20 individual muscles**), two
readouts: a **Volume** (descriptive — what you did) and a **Fatigue** score ∈ [0,1] (modeled
— how recovered that muscle is *right now*). Fatigue is a per-muscle **acute÷chronic
impulse-response**: each session deposits a load impulse into every muscle it works (lifting
AND cardio), the impulse decays with a recovery time-constant, and the acute total is read
relative to that muscle's chronic capacity ("how used to the load you are"). It runs entirely
**app-side, in real time** (pure functions, no nightly job) because every input is available
client-side after the small `gym_sets.is_eccentric` persistence migration.

**Design invariant:** Volume and Fatigue are never summed or conflated. Volume = sets (and
tonnage); Fatigue = the modeled recovery state. They answer different questions ("what did I
train?" vs "what's recovered enough to train today?").

## 1. Inputs (all already available client-side)

| Input | Source | Notes |
| --- | --- | --- |
| Sets: reps, weight_kg, is_warmup, is_eccentric, exercise_id | `gym_sets` (via `useGymData`) | warmups excluded from volume + stimulus; explicitly eccentric working sets get the conservative fatigue multiplier |
| Exercise → muscles | `exercises.primary_muscles` / `secondary_muscles` (20-muscle vocab) | primary weight 1.0, secondary 0.5 (matches `muscleSetVolume`) |
| Exercise → group | `exercises.body_part` (6 groups) + the §4 muscle→group map | |
| rpe | `gym_sets.rpe` (nullable, usually null) | reserved for a later refinement; v1 works without it |
| Cardio session load | `workouts` + `computed.time_in_zones` (z1..z5 sec), `computed.trimp`, `workouts.type` | TRIMP is zone-weighted, already computed |
| Cardio modality | `cardioModalityOf(type)` → swim/running/cycling/rowing/elliptical/walking | |
| Overall aerobic fitness | Zone-2 durable base (or CTL) | modulates recovery rate |

One small `gym_sets.is_eccentric` migration persists the set flag. No metrics-job change. `rpe`
is used **only if present**.

## 2. Per-muscle daily stimulus `s_m(d)`

For muscle `m` and local date `d`, `s_m(d) = liftStim + cardioStim`.

### 2a. Lifting stimulus

Per non-warmup set, its stress is distributed to the muscles it works:

```
liftStim_m(d) = Σ_sets σ(set) · share(set.exercise, m)
share(ex, m)  = 1.0 if m ∈ ex.primary_muscles, 0.5 if m ∈ ex.secondary_muscles, else 0
σ(set)        = hardSetEquivalent(set) · hardness(set) · loadCoeff(exercise) · relativeIntensityFactor(set) · eccentricMultiplier(set)
hardSetEquivalent = reps · load / (10 · referenceLoad)
referenceLoad = ref30(set.exercise), fallback: that set's own load
hardness(set) = 1 + κ_h · max(0, relIntensity − r0)          # near-max sets cost extra fatigue
relIntensity  = load / ref30(set.exercise)                    # this set's weight vs YOUR recent norm
ref30(ex)     = 90th-pctile working weight for `ex` over the trailing 30 d, excluding the current day
eccentricMultiplier(set) = 1.25 if is_eccentric, otherwise 1.0
```

- `relIntensity` is weight relative to *your own* prior 30-day norm for that lift, so a top
  session cannot redefine its own baseline. One ordinary 10-rep working set at that norm is
  approximately one hard-set equivalent; this avoids treating raw kilogram volume as recovery
  load while preserving an extra cost for unusually heavy sets. **Dynamic** — no absolute
  loading standard is hardcoded.
- `eccentricMultiplier` is a **conservative, tunable prior** applied only to the final fatigue
  stimulus of a non-warmup eccentric set. It does not alter weekly/monthly set counts or the
  exercise's `ref30` and relative-load histories.

### 2b. Cardio stimulus (grounded structure; magnitude a marked prior)

Each cardio session deposits **acute** fatigue into the muscles it drives:

```
cardioStim_m(d) = Σ_cardio  TRIMP(session) · k_cardio · mech(modality) · spill(modality, m)
```

- `TRIMP` = the existing zone-weighted load (Σ min·zone). Carries intensity + duration
  natively: an easy Z1–2 session deposits little, a Z3–4/HIIT session multiples more.
- `mech(modality)` — mechanical/eccentric-damage multiplier. GROUNDED in ACUTE eccentric EIMD:
  downhill (eccentric) running drops MVC ~22% and mostly *peripherally* (real muscle, not just
  CNS), DOMS peaking 24–72 h and resolving 5–7 d [Stožer 2020]; cycling/swimming/steady running
  are concentric/low-impact and recover fast. The eccentric>concentric *direction* is firm; the
  exact per-modality run-vs-bike values are a TUNABLE PRIOR — the chronic interference ranking is
  contested (the 2021 meta lost significance; Sabag 2018 found the reverse). See
  `knowledge/topics/cardio-strength-interference.md`:

  | modality | mech | rationale |
  | --- | --- | --- |
  | running | 1.0 | eccentric leg damage (esp. downhill) — the costly modality |
  | rowing | 0.6 | forceful but concentric-dominant, full-body |
  | elliptical | 0.4 | low impact |
  | cycling | 0.35 | concentric, low damage |
  | swimming | 0.3 | low mechanical load |
  | walking | 0.2 | minimal |

- `spill(modality, m)` — fraction of the session's load reaching muscle `m` (GROUNDED by EMG;
  rows sum to ~1 across the modality's muscles):

  | modality | muscles (weight) |
  | --- | --- |
  | swimming | lats .25, upper back .15, front/side/rear delts .25, triceps .1, biceps .05, abs/obliques .2 |
  | running | quadriceps .3, hamstrings .2, calves .2, glutes .15, abs .15 |
  | cycling | quadriceps .55, glutes .25, hamstrings .1, calves .1 |
  | rowing | quadriceps .2, glutes .15, lats .2, upper back .15, lower back .1, biceps .1, abs .1 |
  | elliptical | quadriceps .35, glutes .25, hamstrings .2, calves .15, front delts .05 |
  | walking | calves .4, quadriceps .3, glutes .2, hamstrings .1 |

- `k_cardio` — global exchange rate so cardio deposits **less** muscle fatigue than lifting per
  unit (acute cardio force decrement ~7% MVC and fast-clearing vs 48–72 h for lifting). **This
  scalar is the one MARKED PRIOR** the literature can't pin; start conservative and expose it as
  a personalizable parameter. See §5.

## 3. Compartments and the Fatigue score

Two EWMA-family recurrences per muscle over a continuous daily axis (rest days: `s_m=0`),
seeded at 0, run over a trailing window long enough to converge (≥ 60 d; fatigue is short-horizon).

```
# Acute fatigue — leaky integrator (impulse deposited, then recovers)
acute_m(d)    = acute_m(d−1) · exp(−1/τ_rec_m(d)) + s_m(d)

# Chronic capacity — "how used to loading this muscle" (slow EWMA)
cap_m(d)      = cap_m(d−1) + α_cap · (s_m(d) − cap_m(d−1)),   α_cap = 1 − exp(−1/τ_cap)

# Fatigue score ∈ [0,1) — acute relative to own capacity, with a neutral cold-start floor
capacityForFatigue_m(d) = max(cap_m(d), 6 hard-set equivalents)
fatigue_m(d)  = 1 − exp( − acute_m(d) / (capacityForFatigue_m(d)·κ_scale + ε) )
```

- **Relative, not absolute:** a concentrated recent dose rises faster than a spread-out dose;
  the same work on a conditioned muscle reads lower as personal capacity grows. The neutral
  six-hard-set floor avoids falsely calling a first ordinary 3–6 set week "fatigued" just because
  no prior Gym history exists.
- **Recovery time-constant** `τ_rec_m` — a physiological PRIOR, made dynamic:

  ```
  τ_rec_m(d) = τ0 · f_muscle(size(m)) · g(cap_m, aerobicBase)
  ```

  - `τ0` ≈ 2.5 d base recovery (literature/physiology prior; no library number exists — MARKED).
  - `f_muscle` — larger muscles recover slower (legs/back > arms/delts); a small fixed per-group
    factor.
  - `g(cap, aerobicBase)` shortens τ as the muscle's chronic capacity AND the user's overall
    aerobic base rise (fitter ⇒ faster clearance — GROUNDED in direction, magnitude marked).
    Floored so it never drops below a physiological minimum (~1 d).
- **`τ_cap`** ≈ 35 d (mirrors the CTL τ=42 family; the "training status" window). **Dynamic** via
  the data it integrates.
- **Detrained / thin-data edge:** when both `acute_m` and `cap_m` are ~0 (never trained), fatigue
  → ~0 ("fresh"), but the muscle is flagged **low-confidence / low-data**, not asserted "recovered."

## 4. Muscle → group rollup (the map that didn't exist yet)

Compute at the 20-muscle level; roll up to the 6 groups for the card; expand a group to reveal
its muscles. A few muscles split across two groups (fractional membership):

| group | muscles (fraction) |
| --- | --- |
| chest | chest 1.0 |
| back | lats 1.0, upper back 1.0, lower back 0.6, traps 0.5, rear delts 0.4 |
| shoulders | front delts 1.0, side delts 1.0, rear delts 0.6, traps 0.5 |
| arms | biceps 1.0, triceps 1.0, forearms 1.0 |
| legs | quadriceps, hamstrings, glutes, calves, adductors, abductors 1.0 each |
| core | abs 1.0, obliques 1.0, hip flexors 1.0, lower back 0.4 |

- A `full body` exercise is distributed via its own primary/secondary muscles; it is not a seventh group.
- Group Volume = Σ muscle sets (existing `muscleSetVolume`, unchanged) shown in the weekly/monthly
  **Sets** column.
- Group Fatigue = capacity-weighted mean of member-muscle fatigue (so a group isn't dragged by a
  tiny muscle), using the fractional memberships above.

## 5. Constants: grounded vs. marked priors

| Constant | Value (v1) | Status |
| --- | --- | --- |
| primary/secondary share | 1.0 / 0.5 | grounded (existing app convention) |
| `mech(modality)` | table §2b | **direction grounded** (acute eccentric EIMD, Stožer 2020); exact per-modality values a tunable prior — chronic run>cycle ranking contested (2021 meta n.s., Sabag 2018 reverse) |
| `spill(modality,·)` | table §2b | **grounded** (EMG recruitment) |
| volume landmarks (context) | <5 low / 5–9 mod / 10+ maximizing sets·muscle⁻¹·wk⁻¹ | grounded (Schoenfeld 2017; no MRV ceiling asserted) |
| fitness→faster recovery | direction of `g(·)` | grounded (direction); magnitude marked |
| `k_cardio` | conservative start | **MARKED PRIOR** — no literature scalar; personalizable |
| `eccentricStimulusMultiplier` | 1.25 | **MARKED PRIOR** — conservative lifting-specific magnitude; tunable after personal calibration |
| `τ0` recovery base ≈ 2.5 d | | **MARKED PRIOR** — no per-muscle recovery number in the library |
| `τ_cap` ≈ 35 d, `κ_h`, `r0`, `κ_scale`, `BW_PROXY`, 10-rep set normalization, 6-set cold-start capacity | | model tuning constants; sensible defaults, documented, personalize later |

All marked priors live in one `MUSCLE_FATIGUE_PARAMS` object (single source of truth, like
`zone2_fitness_params`) so they are tunable and auditable, never scattered as magic numbers.

## 6. Honesty & staged personalization

- The card labels Fatigue an **estimate**; the cardio contribution and recovery rate are marked
  "literature/physiology defaults, personalizes with your data" (stage 1). A muscle with little
  logged history shows a widened/greyed state, not a confident number.
- **Dynamic-not-hardcoded audit:** `relIntensity` (vs your 30-d norm), `cap_m`, `τ_rec` (scales
  with capacity + aerobic base), group rollup weights are the only structural constants — all
  state/timing terms are continuous functions of the user's own data. `k_cardio`,
  `eccentricStimulusMultiplier`, and `τ0` are irreducible priors, flagged.

## 7. Architecture

- Pure functions in `app/src/renderer/src/lib/muscleFatigue.ts` (+ `__tests__/muscleFatigue.test.ts`),
  consumed by the Main-tab card. Reads the same `gym_sessions` + `workouts` the views already load
  (widen the gym query window to ~90 d for convergence). **Real-time**: recomputes on log, no wait
  for the nightly job.
- Why app-side (unlike the nightly Zone-2 model): every input is client-side and HR-signal-free,
  and fatigue is short-horizon, so there is no reason to defer it to `metrics/`.
- Result types live with the pure model in `app/src/renderer/src/lib/muscleFatigue.ts`; they are
  renderer-only derived state, not a persisted IPC contract.

## 8. Main-tab integration (composition)

Gym → **Main** sub-tab (reuses the `Zone2View` tablist), top → bottom:
1. Sub-tab switcher `Main · Templates · Sessions`.
2. **Gym week**: a navigable, Gym-log-only Monday–Sunday calendar. Logged days show their
   sessions and set counts; it never includes unrelated cardio activity.
3. **Muscle load & fatigue** (centerpiece): the 6 groups. Each row's colored bar is **current
   fatigue** (fresh 0–19%, ready 20–39%, loaded 40–64%, fatigued 65%+); the `This week / This
   month` toggle changes the **Sets** column. Click a group → expand to its muscles.
4. Recent gym sessions (`RecentSessionsCard`, gym-adapted).

Protein and Strength cards slot in via their own sub-projects. (Card layout gets a quick mockup
before build.)

## 9. Acceptance gates (machine-verifiable)

- `npx vitest run` (in `app/`) pins, in `muscleFatigue.test.ts`:
  - `share`/rollup: a bench set adds 1.0 to chest, 0.5 to front delts; group rollup sums correctly.
  - leaky-integrator identity vs a hand-computed short series; a rest-day gap decays acute toward 0.
  - `relIntensity`: a heavier set vs a lighter set of equal tonnage yields higher stimulus.
  - eccentric lifting: an explicitly eccentric non-warmup set gets higher fatigue stimulus while
    weekly/monthly set counts remain unchanged.
  - cardio: a Z4 run deposits ≫ a Z1 walk of equal duration into legs; a swim deposits into
    back/shoulders/core and ~0 into quads; `mech(running) > mech(cycling)`.
  - detrained edge: zero-history muscle → fatigue ~0 AND low-confidence flag (not "recovered").
- `npm --prefix app run typecheck` — pure model + Gym card type-check together.
