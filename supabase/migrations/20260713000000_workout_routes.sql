-- GPS routes + reverse-geocoded location for outdoor workouts
-- (docs/superpowers plan: graceful-orbiting-pebble).
--
-- Two concerns, two tables, deliberately split by WHO writes them:
--
--   workout_route_points  — the downsampled GPS polyline. Written by the ingest
--     (future outdoor workouts), the raw_payloads backfill, and the RunKeeper
--     importer, always as a wholesale delete+replace per workout (re-derivation
--     may re-downsample to different vertices), mirroring workout_swim_samples.
--
--   workout_geo — the "City, Country" reverse-geocoded from the start point.
--     Written ONLY by the nightly Python job. It is a SEPARATE table (not columns
--     on `workouts`) precisely because the ingest full-row upserts `workouts` on
--     external_id on every HAE re-delivery, which would null any geo column. A
--     table the ingest never touches is the only re-delivery-safe home.
--
-- No PostGIS: single-user, offline, no spatial queries. Plain numeric lat/lon;
-- `seq` reconstructs the line order.

create table workout_route_points (
  workout_id  uuid not null references workouts (id) on delete cascade,
  seq         int  not null,          -- 0-based, chronological
  lat         numeric not null,
  lon         numeric not null,
  elevation_m numeric,                -- nullable: HAE altitude / GPX <ele>, may be absent
  primary key (workout_id, seq)
);

create table workout_geo (
  workout_id  uuid primary key references workouts (id) on delete cascade,
  city        text,
  country     text,                   -- human-readable country name
  admin       text,                   -- state/province/region (GeoNames admin1)
  lat         numeric not null,       -- the start coordinate that was geocoded
  lon         numeric not null,
  geocoded_at timestamptz not null default now()
);

alter table workout_route_points enable row level security;
alter table workout_geo          enable row level security;
