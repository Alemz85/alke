-- Zone 2 fitness v2 (docs/zone2-fitness-model.md v2 amendment): the headline
-- index is the sum of two FIXED-ceiling components. durable_base holds the
-- durable component (0..durable_ceiling), sharpness holds the fast component
-- (0..fast_ceiling). Ceilings are design constants, tunable here without a code
-- change; defaults 70/30.
alter table zone2_fitness_params add column durable_ceiling numeric not null default 70;
alter table zone2_fitness_params add column fast_ceiling    numeric not null default 30;
