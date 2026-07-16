-- updated_at was maintained by hand at every write site (db.ts, chatctx
-- helpers) — any forgotten path silently left it stale. One BEFORE UPDATE
-- trigger per carrying table makes the column self-maintaining; existing
-- manual sets stay harmless (the trigger overwrites them with now()).
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'goals', 'gym_sessions', 'gym_templates', 'injuries',
    'protein_log', 'recovery_plan_items', 'zone2_fitness_params'
  ]
  loop
    execute format(
      'create trigger %I before update on %I for each row execute function set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end $$;
