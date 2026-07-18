-- Robustness columns for the exploratory sweep: Spearman rank correlation
-- (immune to single outlier days and monotone nonlinearity) and a flag set
-- when Pearson and Spearman tell materially different stories — disagreement
-- marks a pair whose Pearson r is outlier-driven or nonlinear.
alter table insight_correlations
  add column spearman_r numeric,
  add column rank_disagree boolean;
