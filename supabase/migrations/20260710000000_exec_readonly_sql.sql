-- Read-only SQL entry point for the chat helper (chatctx/db.py), which can
-- only speak PostgREST. Guarded to SELECT/WITH and revoked from every role
-- except service_role (which bypasses RLS anyway — this adds no new surface).
create or replace function exec_readonly_sql(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if query !~* '^\s*(select|with)\M' then
    raise exception 'only SELECT/WITH queries are allowed';
  end if;
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query) into result;
  return result;
end
$$;

revoke all on function exec_readonly_sql(text) from public, anon, authenticated;
