-- daily_metrics: total daily cycling distance in meters, from the HAE
-- `cycling_distance` metric (already present in every payload; the ingest
-- dropped it until now). Captures TOTAL riding including unrecorded rides —
-- the watch tracks cycling distance passively, and on one observed day the
-- day total was ~2x the recorded ride. Observational: the
-- Zone-2 model does not read it (unlogged ride ENERGY already flows through
-- the ambient channel at the deliberate discount); its purpose is display
-- honesty and quantifying the unlogged share before any model decision.
alter table daily_metrics
  add column if not exists cycling_distance_m numeric;
