-- The RETURNS TABLE output column `log_date` is also a PL/pgSQL variable.
-- Naming it in ON CONFLICT therefore becomes ambiguous at runtime. Target the
-- primary-key constraint explicitly and alias the final read.
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
    on conflict on constraint protein_log_pkey do update
      set grams = protein_log.grams + excluded.grams,
          updated_at = now();
  end if;

  return query
    select p.log_date, p.grams
    from protein_log as p
    where p.log_date = p_log_date;
end;
$$;

revoke all on function apply_protein_delta(uuid, date, numeric) from public, anon, authenticated;
grant execute on function apply_protein_delta(uuid, date, numeric) to service_role;
