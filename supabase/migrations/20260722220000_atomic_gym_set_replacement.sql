-- Replace one session's ordered set list inside a single Postgres transaction.
-- If any replacement row fails validation, the preceding delete rolls back and
-- the workout retains its previous sets.
create or replace function replace_gym_session_sets(
  p_session_id uuid,
  p_sets jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_sets is null or jsonb_typeof(p_sets) <> 'array' then
    raise exception 'sets must be a JSON array';
  end if;

  if jsonb_array_length(p_sets) > 200 then
    raise exception 'a session cannot contain more than 200 sets';
  end if;

  perform 1 from gym_sessions where id = p_session_id;
  if not found then
    raise exception 'gym session not found';
  end if;

  delete from gym_sets where session_id = p_session_id;

  insert into gym_sets (
    session_id,
    exercise_id,
    position,
    reps,
    weight_kg,
    rpe,
    is_warmup,
    is_eccentric,
    note
  )
  select
    p_session_id,
    (entry.value ->> 'exercise_id')::uuid,
    (entry.ordinality - 1)::smallint,
    nullif(entry.value ->> 'reps', '')::smallint,
    nullif(entry.value ->> 'weight_kg', '')::numeric(6, 2),
    nullif(entry.value ->> 'rpe', '')::numeric(3, 1),
    coalesce((entry.value ->> 'is_warmup')::boolean, false),
    coalesce((entry.value ->> 'is_eccentric')::boolean, false),
    entry.value ->> 'note'
  from jsonb_array_elements(p_sets) with ordinality as entry(value, ordinality);
end;
$$;

revoke all on function replace_gym_session_sets(uuid, jsonb) from public, anon, authenticated;
grant execute on function replace_gym_session_sets(uuid, jsonb) to service_role;
