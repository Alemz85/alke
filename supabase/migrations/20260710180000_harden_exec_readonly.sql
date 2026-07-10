-- Defense-in-depth for exec_readonly_sql: the subquery wrapping already makes
-- data-modifying CTEs impossible (Postgres 0A000: "WITH clause containing a
-- data-modifying statement must be at the top level" — verified), but that is
-- an incidental property of the wrapping. Pin the transaction read-only
-- explicitly so any future refactor of the wrapping cannot reopen the hole.
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
  perform set_config('transaction_read_only', 'on', true);
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query) into result;
  return result;
end
$$;

revoke all on function exec_readonly_sql(text) from public, anon, authenticated;
