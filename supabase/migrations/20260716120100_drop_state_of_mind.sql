-- state_of_mind never received a single value across the entire ingest
-- history (0 non-null rows) and had no reader anywhere in the app — the
-- column, its FIELD_MAP entry, parser branch, and shared type are removed
-- together. Re-adding is a small migration if mood export is ever enabled
-- in Health Auto Export.
alter table daily_metrics drop column state_of_mind;
