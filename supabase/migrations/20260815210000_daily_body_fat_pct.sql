-- Body fat percentage, one scalar per calendar date, alongside weight_kg.
-- HAE started sending `body_fat_percentage` partway through the record (it arrives from the
-- "Health" source, same as weight_body_mass) and ingest was dropping it as an
-- unmapped metric name. Stored as a percentage 0-100, NOT a 0-1 fraction --
-- that is the shape HAE sends (units "%", e.g. qty 22.0).
--
-- No historical backfill exists: this metric was never in the export before
-- that date, so the column is null for every prior day and fills forward from
-- the next sync onward.
alter table daily_metrics
  add column body_fat_pct numeric;
