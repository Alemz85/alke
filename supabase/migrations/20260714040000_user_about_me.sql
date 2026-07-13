-- Free-text "about me" the user maintains on the Profile tab, giving the chat
-- agent durable personal context. Kept in the DB (read by the agent), never
-- hardcoded into prompt files.
alter table user_config
  add column about_me text;
