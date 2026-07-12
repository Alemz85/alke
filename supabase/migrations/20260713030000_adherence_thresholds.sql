-- Per-item adherence thresholds (TODO #4): the blanket red 0 / yellow <75% /
-- green >=75% rating was provisional — the acceptable dose is case-by-case per
-- exercise (a daily mobility routine tolerates misses differently than a
-- 3x/wk tendon-loading progression).
--
-- Semantics (user decision 2026-07-10): the colors are EFFICACY claims, not
-- motivation. green_min = the weekly count that is a strictly acceptable
-- therapeutic dose; yellow_min = the true minimum-effective dose (maintenance
-- / slow progress). Below yellow_min rates red even when non-zero — a dose
-- with no therapeutic effect must never rate yellow just because it isn't 0.
-- The chat agent assigns both per item (injuries.py), reasoning from the
-- literature / knowledge library; items without thresholds keep the blanket
-- rule in the app.

alter table recovery_plan_items
  add column green_min  smallint check (green_min between 1 and 14),
  add column yellow_min smallint check (yellow_min between 1 and 14),
  add constraint recovery_plan_items_threshold_order
    check (green_min is null or yellow_min is null or green_min >= yellow_min),
  add constraint recovery_plan_items_green_within_target
    check (green_min is null or weekly_target is null or green_min <= weekly_target);
