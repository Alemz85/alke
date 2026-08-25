-- Persist an explicit unilateral (single-arm/single-leg) flag for gym sets,
-- so a set's weight is never compared against bilateral sets of the same
-- exercise. Mirrors is_eccentric.
-- Existing logged sets retain the conservative non-unilateral default.
alter table gym_sets
  add column is_unilateral boolean not null default false;
