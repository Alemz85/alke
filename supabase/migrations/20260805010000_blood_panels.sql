-- Blood panels / lab reports. The owner's own lab results, kept alongside every
-- other health fact so the one storage location serves all three consumers: the
-- desktop app (Profile section), the chat agent (chatctx/db.py runs unrestricted
-- read-only SQL, so a table is readable the moment it exists), and future trend
-- charts once more than one panel exists.
--
-- The SOURCE PDFs deliberately do not live here or in git — they carry name,
-- date of birth and national ID number, and git history is forever. They stay on disk
-- under /Health (gitignored); only the extracted results are stored. `source_file`
-- records which report a row came from, as provenance, not as a fetchable path.
--
-- Same access model as gym/injuries/goals: RLS deny-all, service role bypasses.
create table if not exists blood_panels (
  id           uuid primary key default gen_random_uuid(),
  -- Date the sample was taken (or the report's accession date when that is all
  -- the report gives). This is the axis everything is ordered and trended on.
  collected_on date not null,
  lab          text,
  -- e.g. 'Complete blood count', 'Lipid panel'. One physical report can
  -- carry several logical panels; each gets a row so they can be shown apart.
  panel_name   text not null,
  source_file  text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (collected_on, panel_name)
);

-- One row per analyte. Values are stored BOTH parsed and raw on purpose:
--   value_num / ref_low / ref_high  drive charts, comparisons and the flag
--   value_text / ref_text           preserve exactly what the report printed
-- Lab reports state reference ranges in wildly varying shapes — "4,0-10,0",
-- "22 - 322 (sex-specific)", "up to 1,20", "< 34", multi-tier vitamin-D bands. Anything the
-- importer cannot reduce to numeric bounds keeps ref_text alone and leaves the
-- numeric columns null, so an unparseable range NEVER silently becomes a wrong
-- number. Same principle as the ingest function's FIELD_MAP: centralise the
-- format assumptions and keep the raw payload.
create table if not exists blood_markers (
  id         uuid primary key default gen_random_uuid(),
  panel_id   uuid not null references blood_panels(id) on delete cascade,
  -- Canonical snake_case analyte key ('hemoglobin', 'ferritin', 'vitamin_d').
  -- This is what makes the data usable: it lets the app trend one marker across
  -- panels and lets the chat agent ask about ferritin without reading the report's language or
  -- knowing which lab produced the row.
  code       text not null,
  -- The analyte name exactly as the report printed it ('HAEMOGLOBIN'). Provenance:
  -- a canonical mapping can be corrected later only if the original survives.
  label_raw  text not null,
  -- Report section: 'haematology', 'lipids', 'chemistry', ...
  category   text,
  value_num  double precision,
  value_text text,
  unit       text,
  ref_low    double precision,
  ref_high   double precision,
  ref_text   text,
  -- Whether the value sits outside its reference range. 'abnormal' covers reports
  -- that flag a result (some labs print '**') without giving a parseable direction.
  flag       text check (flag in ('low', 'normal', 'high', 'abnormal')),
  method     text,
  -- Preserves the report's own ordering, which groups related analytes.
  position   integer not null default 0,
  unique (panel_id, code)
);

create index if not exists blood_markers_panel_idx on blood_markers (panel_id);
-- Trending one analyte over time is the main query once several panels exist.
create index if not exists blood_markers_code_idx on blood_markers (code);

alter table blood_panels enable row level security;
alter table blood_markers enable row level security;

create trigger blood_panels_set_updated_at
  before update on blood_panels
  for each row execute function set_updated_at();
