-- zone2_fitness_params: owner-ratified EF detrained baselines.
--
-- An EF signal (run/bike) enters the Zone-2 level fusion only when its
-- detrained baseline is ratified here. Deriving the baseline from the first
-- stored observation proved wrong the day the signal woke (the
-- first-ever outdoor-ride EF became its own baseline, so elevation ≡ 0 fused
-- at the model's strongest weight — crashing the durable calibration below
-- the floor while the confidence band falsely collapsed 2.5×). A signal born
-- mid-training has no detrained-era observation to derive a baseline from, and
-- no observation count fixes that, so ratification is an explicit owner
-- decision. NULL = unidentified: the signal is collected, stored and displayed
-- but withheld from the fusion (the swim-EF treatment). Natural ratification
-- candidate: the first post-gap easy Z1-Z2 session's EF, taken while
-- genuinely detrained.
alter table zone2_fitness_params
  add column if not exists run_ef_baseline numeric,
  add column if not exists bike_ef_baseline numeric;
