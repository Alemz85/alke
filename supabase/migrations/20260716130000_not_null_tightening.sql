-- Columns the shared types already declare non-null and every writer always
-- provides (verified zero nulls live): make the schema say so, closing the
-- types-vs-schema drift that left renderer crash sites reachable in theory.
-- The ingest parser drops workouts lacking type/start_at before upsert, so a
-- malformed HAE entry can't violate these and poison a batch.
alter table workouts
  alter column type set not null,
  alter column start_at set not null;

alter table computed_zone2_fitness
  alter column evidence_state set not null;
