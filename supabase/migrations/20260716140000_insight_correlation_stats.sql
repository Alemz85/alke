-- Persistence for the corrected correlation statistics: p_value now stores
-- the autocorrelation-corrected p (effective-sample-size adjusted); these
-- columns keep the naive p for comparison, the effective n behind the
-- correction, and the Benjamini-Hochberg q-value across the sweep.
alter table insight_correlations
  add column n_eff numeric,
  add column p_value_naive numeric,
  add column q_value numeric;
