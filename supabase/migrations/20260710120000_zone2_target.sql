-- Zone 2 tab's weekly target (minutes), previously hardcoded to 90 in the UI.
alter table user_config
  add column zone2_weekly_target_min smallint not null default 90;
