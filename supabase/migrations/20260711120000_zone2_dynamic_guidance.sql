-- Zone 2 fitness v4 (post-review round): ALL coaching guidance is derived in
-- the nightly job and stored on the row (docs/zone2-fitness-model.md v3 pt6),
-- so the renderer only places dates — it has nothing left to invent and can
-- never reintroduce fixed offsets (the DEFAULT_WARN_AFTER_DAYS=9 / 0.3/0.6
-- fraction / maintainBy=decay−1 class of violation).
--
--   warn_after_days → numeric   the CONTINUOUS projection-derived decay-onset
--                               horizon. The old int column made a legitimate
--                               0.x-day horizon round to 0, which the renderer
--                               then treated as "missing" and replaced with a
--                               fixed 9 — the fastest-easing state displayed
--                               the longest hold window.
--   maintain_horizon_days       horizon at which the projected index has fallen
--                               by ONE expected session's build increment — the
--                               last day a single session still holds the level.
--   build_interval_days         cadence at which a session's fast-layer build
--                               outpaces between-session fast decay (net
--                               accumulation), from τ_fast + the increment.
--   expected_session_build      the per-session index increment used above
--                               (median recent qualifying session), provenance.
--   anchor_beta dropped         v2 leftover; always NULL since v3 (no single
--                               VO2max beta — provenance lives in contributing).
alter table computed_zone2_fitness
  alter column warn_after_days type numeric using warn_after_days::numeric;
alter table computed_zone2_fitness add column maintain_horizon_days numeric;
alter table computed_zone2_fitness add column build_interval_days numeric;
alter table computed_zone2_fitness add column expected_session_build numeric;
alter table computed_zone2_fitness drop column anchor_beta;

-- Params the job already reads (fast_sat had no column — the code fallback
-- silently always won), plus the two scale-top anchors that were hardcoded in
-- compute.py; now tunable + auditable like their siblings. Values unchanged.
alter table zone2_fitness_params add column fast_sat        numeric not null default 26;
alter table zone2_fitness_params add column rhr_top_amateur numeric not null default 48;
alter table zone2_fitness_params add column ef_top_factor   numeric not null default 1.6;
