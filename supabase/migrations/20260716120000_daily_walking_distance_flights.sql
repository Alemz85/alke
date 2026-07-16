-- Daily passive-activity metrics HAE has been sending all along (582 / 446
-- occurrences in raw_payloads) but ingest silently dropped: total
-- walking+running distance and flights climbed, one value per calendar date,
-- summed per date like steps. Distance is stored in meters (ingest converts
-- from the payload's configurable unit), matching workouts.distance_m.
alter table daily_metrics
  add column walking_running_distance_m numeric,
  add column flights_climbed integer;
