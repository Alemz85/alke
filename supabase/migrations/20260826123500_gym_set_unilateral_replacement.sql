-- Carry is_unilateral through the atomic set-replacement path.
--
-- 20260826120001 added gym_sets.is_unilateral, but replace_gym_session_sets
-- builds its INSERT from an explicit column list — so editing a session
-- through the app would silently drop the flag from every set it rewrote,
-- the same shape as the duration_s drop fixed in 20260805150100.
-- Same body as 20260805150100 plus the new column.
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
    duration_s,
    weight_kg,
    rpe,
    is_warmup,
    is_eccentric,
    is_unilateral,
    note
  )
  select
    p_session_id,
    (entry.value ->> 'exercise_id')::uuid,
    (entry.ordinality - 1)::smallint,
    nullif(entry.value ->> 'reps', '')::smallint,
    nullif(entry.value ->> 'duration_s', '')::smallint,
    nullif(entry.value ->> 'weight_kg', '')::numeric(6, 2),
    nullif(entry.value ->> 'rpe', '')::numeric(3, 1),
    coalesce((entry.value ->> 'is_warmup')::boolean, false),
    coalesce((entry.value ->> 'is_eccentric')::boolean, false),
    coalesce((entry.value ->> 'is_unilateral')::boolean, false),
    entry.value ->> 'note'
  from jsonb_array_elements(p_sets) with ordinality as entry(value, ordinality);
end;
$$;

revoke all on function replace_gym_session_sets(uuid, jsonb) from public, anon, authenticated;
grant execute on function replace_gym_session_sets(uuid, jsonb) to service_role;
