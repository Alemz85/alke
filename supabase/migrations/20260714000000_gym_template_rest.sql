-- Gym template rest time (structured). A template carries a default rest that
-- applies to every exercise; individual exercises may override it. The agent
-- (chatctx/gym.py) sets the template default as the norm and only writes a
-- per-exercise rest_after_s when that exercise genuinely differs — it must not
-- stamp the same value onto every row.
alter table gym_templates
  add column default_rest_s smallint check (default_rest_s between 0 and 3600);

alter table gym_template_exercises
  add column rest_after_s smallint check (rest_after_s between 0 and 3600);
