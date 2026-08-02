# Insights statistical design

This document is the contract for the personal Insights engine. The engine is
an N-of-1 observational screen: it can identify repeatable within-person
associations worth acting on or testing deliberately, but it cannot turn
wearable data into causal claims.

## Questions, not a correlation grab bag

Every candidate must declare four things before it is evaluated:

1. the exposure time and outcome time;
2. the population of days or workouts to which the estimate applies;
3. the variables available before the exposure/outcome that must be adjusted;
4. the minimum information and stability gates required to surface it.

Variables are not added merely because a database column exists. In
particular, daily active energy, wrist temperature, weight, protein, gym-set RPE,
HRR60, and modality-specific decoupling currently lack enough observations.
Walking/running distance is almost a duplicate of steps and is not an
independent hypothesis. REM/deep/core shares are compositional and consumer
sleep-stage classification is too uncertain for three separate inferential
claims; the engine uses only the less ambitious awake fraction as a sleep
continuity proxy.

## Temporal ordering

The row labelled date `t` contains the sleep ending on `t`. Respiratory rate
is treated as sleep-associated. RHR and HRV are different: Health Auto Export
sends one midnight-stamped daily aggregate and later exports can revise it
after a workout on `t`. The final stored RHR/HRV value is therefore not known
before that workout.

This creates the following legal ordering:

```
load / ambient activity on t-1
        ↓
sleep-associated context on t
        ↓
workout choice and recorded intensity later on t
```

That ordering applies to sleep-derived variables, not final same-day RHR/HRV.
For RHR/HRV the legal workout predictor is the finalized aggregate from
`t-1`. A same-date relationship may be screened only as co-measured, with
within-day order and causal direction explicitly unresolved.

ATL and CTL computed for `t` already include the workout on `t`. They must
never control an analysis of sleep or morning recovery on `t`, and they must
not control an analysis in which the workout on `t` is the outcome. The daily
frame therefore exposes:

- `atl_prior` and `ctl_prior`: load state through `t-1`, available before a
  workout on `t`;
- `ctl_pre_exposure`: load state through `t-2`, available before a prior-day
  load exposure on `t-1`.

Personal baselines also use history strictly before the current observation.
Current sleep is not allowed to pull its own baseline toward itself.

## Daily recovery families

### Prior-day behavior to next sleep/recovery

Exposures are prior-day TRIMP, prior-day steps, and prior-day flights climbed.
Flights add vertical activity that steps do not fully encode: in the current
data their correlation is 0.66, while walking/running distance is effectively a
duplicate of steps at 0.99. Outcomes are sleep shortfall relative to the prior
28-day median, sleep awake fraction, and respiratory-rate deviation relative to
its prior 28-day median. Finalized same-day RHR/HRV aggregates are excluded from
this directed family because a workout later on the outcome date can contribute
to their final value.

Each outcome controls its previous value and the pre-exposure chronic load.
TRIMP and steps control one another. The flights candidate controls both, so a
long active workout or high-step day cannot masquerade as an independent
stair-climbing effect. Flights is not forced into the established TRIMP and
steps candidates: it starts later, and complete-case deletion would silently
redefine those analyses around the newer sensor era.

### Co-measured sleep and recovery

Sleep shortfall, sleep-midpoint drift, and sleep awake fraction are screened
against RHR, HRV, and respiratory-rate deviation. These are explicitly
labelled co-measured associations. For RHR/HRV, “co-measured” means same-date
association with a finalized full-day aggregate, not a morning-readiness
measurement. Prior ATL and the previous outcome are controls.

## Workout-context families

Workout analyses use one row per workout with positive duration. Duration is
recorded independently of HR, so an otherwise valid workout is not discarded
merely because its HR stream is absent or incomplete. HR-derived outcomes have
a stricter population: positive TRIMP, at least five minutes of classified HR,
and classified-HR time between 90% and 105% of recorded duration. The upper
tolerance allows small timestamp/rounding disagreement but rejects internally
inconsistent records. This is a fixed measurement-quality rule, not a
data-tuned significance threshold. Rest days are not members of either
population. Multiple sessions on one local date remain separate workout
observations, but they share the same morning recovery exposure and parts of
the same daily environment. They therefore count as one date for
minimum-information gates and as one cluster for uncertainty.

Outcome eligibility does not erase event history. Every recorded workout,
including a short or HR-sparse session that cannot supply a stable outcome,
updates time since the previous workout and time since the previous workout of
that modality. Any positive measured TRIMP from such a session also contributes
to the load already accumulated before a later same-day outcome row. Previous-
modality HR-outcome controls remain restricted to HR-eligible rows because a
short or poorly covered session cannot supply a stable intensity ratio.
Duration history, however, advances on every positive-duration workout.

The outcomes deliberately separate different questions:

- total recorded TRIMP: the scheduled dose chosen for a session whose HR stream
  passes the completeness gate;
- duration: how long the session was;
- TRIMP per measured HR minute: recorded cardiovascular intensity. Dividing by
  full workout duration would silently treat every unmeasured second as zero
  effort. Duration remains adjusted because intensity and sustainable duration
  trade off;
- Apple energy intensity: the workout summary in `kcal/(hour·kg)` (numerically
  MET-like). It supplies a separate device-estimated effort outcome when HR is
  absent or incomplete. Only explicit MET or `kcal/hr·kg` units and values from
  0.5–25 are accepted; no value is reconstructed from energy or body weight;
- high-zone fraction: the fraction of measured HR time in zones 4-5.

Neither intensity measure nor high-zone fraction is labelled “capacity.”
Capacity would require a standardized task, pace/power, and preferably
perceived exertion. Apple energy intensity is also not measured mechanical
power; it is a device estimate. These outcomes answer how hard the recorded
session was, conditional on doing a workout.

Workout readiness candidates relate sleep shortfall, three-night mean
shortfall, sleep timing drift, sleep awake fraction,
previous-day finalized RHR/HRV, and sleep-associated respiratory-rate
deviation to duration, TRIMP per measured HR minute, and Apple energy
intensity. The three-night exposure requires three complete consecutive
calendar days; it is not imputed across a missing night. Prior acute load and
time since the previous workout are also screened as pre-workout state
candidates. Hours since waking is screened separately because clock time and
biological-day position are not the same exposure.

Every workout fit controls chronic and acute load through the prior day,
previous-day load, modality, time since the previous workout, time since the
previous workout of that modality, and any load already accumulated earlier
that day. A candidate is removed from its own control list. The same-day load
control is essential: an evening session is more likely than a morning session
to be a second session, and otherwise “time of day” could merely rediscover
accumulated same-day fatigue.

Same-day sleep, timing, continuity, and respiratory context enters a workout
row only when the recorded sleep end precedes the workout by no more than 20
hours. This prevents a late-night or early-morning workout from borrowing a
sleep episode that ends later. Previous-day finalized RHR/HRV and prior-load
state do not depend on that gate. Other missing measurements reduce a
candidate's own sample; they do not cause imputation.

### Workout time of day

Clock time is circular: 23:30 is close to 00:30, not 23 hours away. Timing is
therefore modelled with a 24-hour cosinor (sine and cosine jointly), never as a
raw linear hour or arbitrary morning/evening split. The joint two-degree-of-
freedom test reports:

- partial effect size after controls;
- the fitted peak clock time when a stable curve exists;
- bootstrap phase concentration, so a statistically non-zero but wandering
  peak does not surface.

Modality fixed effects, weekday, secular trend, prior load state, hours since
waking, and relevant duration are controls. Hours since waking is essential in
this data: it correlates 0.91 with clock time, so a clock-only fit would mostly
rediscover position in the waking day. These controls reduce—but cannot
eliminate—confounding from a schedule such as “rowing happens in the evening,
walking happens in the morning.” A result remains an association with recorded
training behavior, not proof of a circadian mechanism or a recommendation to
move every session.

The secular trend is elapsed calendar time, not workout row number. Two
sessions on one date receive the same trend value, and a week without training
still advances the trend by seven days.

## Inference gates

Daily and workout candidates are separate predeclared multiple-testing
families. Every candidate passes the same policy:

- at least 60 usable observations and at least 30 effective observations; a
  workout candidate additionally needs at least 60 distinct workout dates;
- for cosinor fits, at least 10 distinct workout dates represented in each of
  morning, afternoon, and evening/night so repeated sessions on a few dates
  cannot create apparent clock-time coverage;
- weekday, annual sine/cosine, and secular-trend adjustment;
- deterministic collapse of highly collinear controls;
- HAC/Newey-West uncertainty for ordered observations; workout fits also use
  date-clustered uncertainty and take the less favorable p-value and the
  confidence-interval envelope across the two estimators;
- Benjamini-Hochberg false-discovery control within the declared family;
- moving-block bootstrap stability (sign stability for scalar effects,
  circular phase stability for timing effects); workout blocks sample calendar
  days and retain every session from a sampled date together;
- Pearson/partial-Spearman agreement for scalar effects so one extreme day
  cannot promote an otherwise absent relationship;
- circular-shift placebo calibration;
- candidate-specific placebo suppression: a real candidate cannot promote when
  its own shifted null also clears the gates;
- seven consecutive qualifying nightly runs before promotion, plus symmetric
  demotion hysteresis.

Exploratory correlations remain a hypothesis-discovery surface. They use a
trailing 180-day window, effective-sample correction, rank-correlation
robustness, and FDR q-values. Workout-load outcomes include workout days only
at every lag. Lag zero is withheld when RHR or HRV is placed on the driver side;
their final same-day aggregate cannot precede performance.

## Measurement-time audit (2026-08-02)

Real `raw_payloads`, which outrank the vendor documentation, show RHR, HRV,
and respiratory rate arriving as one entry per local date stamped `00:00:00`.
Across the recent repeated exports, HRV changed on 22 of 23 re-exported dates
and RHR on 14 of 22. On eight workout dates, an HRV value had already been
exported before the workout and was revised by a later export. The ingest merge
correctly retains the latest non-null aggregate for display, but that final
value cannot be used retrospectively as if it had been observed before the
workout. Daily model version 4 and workout model version 7 enforce the
prior-day rule above. Workout version 7 additionally separates duration from
HR-outcome eligibility, normalizes HR intensity by measured time, and admits
the explicit Apple energy-intensity summary as a separate outcome.

## Current data implications (audit 2026-08-02)

- 577 daily rows are present; steps and walking distance are complete, while
  flights climbed has 442 days.
- Sleep has 281 days, RHR 259, HRV 311, and respiratory rate 286. RHR/HRV are
  eligible as co-measured daily aggregates and prior-day predictors, not as
  same-day readiness measurements.
- Active energy has 25 days, weight 39, wrist temperature 0, protein 1, and
  detailed gym sessions 5: these remain dormant.
- Prior-day flights candidates have 149–173 complete cases after outcome and
  control availability. None currently clears the multiplicity and stability
  gates; adding the variable did not manufacture a result.
- Workout temperature and humidity exist on 101 sessions across 70 dates, but
  most are indoor strength, rowing, cycling, or pool sessions and the historic
  running block lacks them. They are not treated as physiological ambient
  exposure until the source semantics and outdoor coverage are trustworthy.
- 224 positive-duration workouts across 190 dates can inform duration
  behavior. Of the 108 sessions that otherwise have positive HR-derived load
  and at least five classified minutes, 102 sessions across 73 dates pass the
  90% coverage gate. The six failures are outdoor walks with only 60.5%–87.8%
  coverage; leaving the old denominator in place would have made those gaps
  look like low effort.
- Complete waking-day timing frames currently contain 84 sessions on 56 dates
  for duration and 78 sessions on 53 dates for HR-derived intensity, so both
  remain dormant under the 60-date timing rule. Clock time and hours since
  waking correlate 0.91 in the observed frame, reinforcing the need for that
  control rather than a clock-only interpretation.
- Duration candidates now use measurements according to their own semantics:
  sleep continuity has 94 sessions on 63 dates, prior-day HRV has 103 on 72,
  and prior acute load / previous-workout gap have 217 on 184. Corresponding
  intensity candidates retain only HR-quality rows (85/58, 93/67, and 95/68,
  respectively). Three-night sleep shortfall remains dormant for both duration
  (71/46) and intensity (65/43). None clears multiplicity and stability gates;
  greater eligibility is not evidence of an effect.
- Apple energy intensity exists for 110 sessions on 77 dates across strength,
  rowing, cycling, walking, swimming, surfing, and one indoor run. It overlaps
  102 HR-quality sessions but correlates only 0.67 with HR-zone intensity, so it
  is related rather than redundant. Four of its 11 candidates are currently
  testable; none clears the gates. The expanded 35-candidate workout family has
  zero raw signals and zero watches, and zero of 39 tested shifted placebos
  fires.
- Two sessions with fewer than five classified HR minutes in the current
  workout era now contribute valid duration outcomes but remain ineligible for
  HR-derived outcomes. They also remain in event history: this corrects two
  later recovery intervals; the
  largest changed from 22.2 hours to 19 minutes, and the short session's 5.15
  TRIMP contributes to the later session's same-day prior load.
- With the measurement-time and coverage corrections, previous-day HRV has 103
  sessions on 72 dates for duration and 93 on 67 for intensity; neither shows
  a clear relationship. The former same-day HRV-to-intensity raw signal
  disappears; it was compatible with within-day aggregate revision rather than
  readiness.
- Decoupling exists for only 14 recent workouts and HRR60 for none, so neither
  is a promotable workout-context outcome yet.

These are eligibility facts, not tuned thresholds. The thresholds above stay
fixed as data accrues.

## Scientific anchors

- Rae, Stephenson & Roden (2015), randomized morning/evening swim time trials:
  chronotype and habitual training time altered the aggregate time-of-day
  result ([PubMed 25631930](https://pubmed.ncbi.nlm.nih.gov/25631930/)). This is
  why the app reports an adjusted schedule association and does not call the
  fitted clock peak an innate circadian optimum.
- Walsh et al. (2019), counterbalanced sleep extension/restriction in endurance
  cyclists: cumulative sleep changed time-trial performance
  ([PubMed 31246714](https://pubmed.ncbi.nlm.nih.gov/31246714/)). This supports
  screening relative sleep while preserving the capacity-vs-behavior caveat.
- Nuuttila et al. (2025), longitudinal overload monitoring: wearable HR, HRV,
  breathing rate and sleep responses showed substantial individual variation
  ([PubMed 39860902](https://pubmed.ncbi.nlm.nih.gov/39860902/)). This supports
  an N-of-1 model and respiratory-rate inclusion, not population effect sizes.
- Óskarsdóttir et al. (2022), six-month self-tracker study: stable individual
  summaries needed materially longer than common short observation windows
  ([PubMed 35191850](https://pubmed.ncbi.nlm.nih.gov/35191850/)). This supports
  the fixed minimum-n and persistence gates.
