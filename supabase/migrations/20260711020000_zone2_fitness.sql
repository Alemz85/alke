-- Zone 2 fitness model (docs/zone2-fitness-model.md). A NEW, Zone-2-scoped
-- fitness estimate written by the nightly job — the existing whole-body
-- CTL/ATL/TSB/ACWR in computed_daily is untouched. Two independent numbers,
-- never summed: durable_base (slow, VO2max-anchored headline) and sharpness
-- (fast current-form companion). Same access model as every table: RLS
-- deny-all, service role bypasses.

create table computed_zone2_fitness (
  date                date primary key,
  -- the two numbers, never summed
  durable_base        numeric,        -- 0-100 headline "Zone 2 fitness level"
  durable_band_lo     numeric,        -- confidence band low (0-100)
  durable_band_hi     numeric,        -- confidence band high (0-100)
  sharpness           numeric,        -- 0-100 current-form companion
  -- provenance / anchor
  vo2max_anchor_score numeric,        -- vo2max_to_score(latest vo2max), 0-100
  anchor_beta         numeric,        -- weight on anchor that day (spec 4c)
  days_since_vo2max   int,
  -- internal state (rebuildable, stored for trail/projection + audit)
  durable_load        numeric,        -- raw slow EWMA (load units)
  sharp_load          numeric,        -- raw fast EWMA (load units)
  base_accum_b        numeric,        -- B in [0,1], accumulated-base consolidation (spec 3)
  tau_slow_days       numeric,        -- resolved tau_slow(B) that day
  floor_score         numeric,        -- FLOOR_score(B) that day
  -- confidence + evidence
  confidence          numeric,        -- 0-1 fused (drives band width)
  evidence_state      text default 'ok' check (evidence_state in ('ok','insufficient','ambiguous','low_confidence')),
  contributing        jsonb,          -- per-signal weights actually used that day
  -- personalization stage (spec 7)
  stage               text not null default 'literature' check (stage in ('literature','lightly_tuned','personalized')),
  -- maintenance / degradation warning (spec 5)
  maintenance_met     boolean,
  warn_after_days     int,
  flags               jsonb not null default '[]',   -- may hold {type:'zone2_maintenance', severity:'info', message}
  computed_at         timestamptz default now()
);

-- Fitted per-user parameters (stage 2/3). Single row, defaults = the locked
-- literature constants; the model reads these so tuning never requires a
-- code change.
create table zone2_fitness_params (
  id                smallint primary key default 1 check (id = 1),
  stage             text not null default 'literature' check (stage in ('literature','lightly_tuned','personalized')),
  tau_fast_days     numeric not null default 14,
  tau_slow_min_days numeric not null default 45,
  tau_slow_max_days numeric not null default 90,
  f_max             numeric not null default 0.55,
  floor_p           numeric not null default 1.5,
  b_ref_min_per_wk  numeric not null default 200,
  anchor_vo2_100    numeric not null default 62,
  fitted_from       jsonb,     -- episode ids / dates used to fit (stage 2/3)
  updated_at        timestamptz default now()
);

insert into zone2_fitness_params (id) values (1);

alter table computed_zone2_fitness enable row level security;
alter table zone2_fitness_params   enable row level security;
