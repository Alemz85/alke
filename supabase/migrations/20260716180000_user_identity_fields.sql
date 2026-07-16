-- Structured identity fields for the Profile "About me" section. All nullable
-- — the owner fills them in Settings; nothing derives from them yet (age
-- computes from birthdate at read time, never stored).
alter table user_config
  add column sex text check (sex in ('male', 'female', 'other')),
  add column birthdate date,
  add column height_cm numeric check (height_cm > 0 and height_cm < 300);
