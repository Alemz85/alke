-- Owner-declared true end for a session the device kept recording past.
--
-- WHY. A workout you forget to stop keeps accruing: a pool swim can run on for
-- minutes past the last length your heart rate corroborates. Such a tail can
-- contain watch-fabricated "lengths"
-- (e.g. 25 m in 11 seconds — faster than the world record) recorded while
-- getting out of the pool, at a heart rate well below the swimming average.
--
-- That tail does NOT corrupt swim EF, HR drift, or Zone-2 eligibility: those
-- already read active set windows only (metrics/models.py swim_active_ef). What
-- it DOES inflate is TRIMP — the low-intensity tail adds Z1 seconds, which flows
-- into CTL/ATL/TSB/ACWR — and the daily/7-day duration totals behind the load
-- ratios. Left alone it reads as extra easy aerobic volume that never happened.
--
-- WHY A COLUMN AND NOT AN EDIT. Editing workouts.duration_s/end_at in place does
-- not survive: ingest upserts on external_id and rewrites exactly those columns
-- (supabase/functions/ingest/index.ts), and Health Auto Export re-delivers a
-- session for ~2 days after it happens (one swim arrived 3 times).
-- Deleting the tail's hr samples or swim_sets fares no better — both are
-- re-inserted by the same re-delivery. So the correction has to live in a column
-- ingest never writes, and be applied at COMPUTE time. This mirrors the
-- manual_* inputs added in 20260830120000 for exactly that reason.
--
-- The device's own record stays untouched: start_at, end_at, duration_s,
-- distance_m and every sample remain exactly as ingested. This column is an
-- overlay the metrics job reads, never a correction applied to the archive.

alter table workouts
  -- The instant the session ACTUALLY ended, as declared by the owner. Metrics
  -- treat everything at or after this timestamp as not-exercise: heart-rate
  -- samples past it stop contributing zone time (and therefore TRIMP), swim sets
  -- starting past it are dropped, and the effective duration becomes
  -- manual_end_at - start_at.
  --
  -- Only ever TRUNCATES. A value at or after the recorded end_at is inert rather
  -- than an error, so this can never invent training that was not recorded; the
  -- CHECK enforces only that it lands after the start.
  add column if not exists manual_end_at timestamptz
    check (manual_end_at > start_at);

comment on column workouts.manual_end_at is
  'Owner-declared true end of a session the device kept recording past (forgot to press stop). Metrics truncate duration, zone time/TRIMP and swim sets at this instant; the ingested columns and samples are never modified. Only truncates - a value >= end_at is inert. NULL = no correction. Never written by ingest.';
