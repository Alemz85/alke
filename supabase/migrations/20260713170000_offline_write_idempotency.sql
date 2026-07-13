-- Durable Electron write queue support. Stable client mutation ids make
-- ambiguous network retries safe: a request may have reached Postgres even
-- when the desktop process never received its response.

alter table injury_notes
  add column if not exists client_mutation_id uuid unique;

create table offline_mutation_receipts (
  id         uuid primary key,
  kind       text not null,
  applied_at timestamptz not null default now()
);

alter table offline_mutation_receipts enable row level security;

create or replace function apply_protein_delta(
  p_mutation_id uuid,
  p_log_date date,
  p_grams numeric
)
returns table (log_date date, grams numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
begin
  if p_grams < 0 or p_grams > 2000 then
    raise exception 'protein delta out of range';
  end if;

  insert into offline_mutation_receipts (id, kind)
  values (p_mutation_id, 'protein_delta')
  on conflict (id) do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    insert into protein_log (log_date, grams, updated_at)
    values (p_log_date, p_grams, now())
    on conflict (log_date) do update
      set grams = protein_log.grams + excluded.grams,
          updated_at = now();
  end if;

  return query
    select protein_log.log_date, protein_log.grams
    from protein_log
    where protein_log.log_date = p_log_date;
end;
$$;

revoke all on function apply_protein_delta(uuid, date, numeric) from public, anon, authenticated;
grant execute on function apply_protein_delta(uuid, date, numeric) to service_role;

