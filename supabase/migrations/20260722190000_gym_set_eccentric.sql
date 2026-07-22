-- Persist an explicit eccentric-only flag for gym-set fatigue modeling.
-- Existing logged sets retain the conservative non-eccentric default.
alter table gym_sets
  add column is_eccentric boolean not null default false;
