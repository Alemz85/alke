alter table user_config
  add column sleep_goal_min smallint not null default 480
    check (sleep_goal_min between 60 and 1440),
  add column bedtime_goal_min smallint not null default 0
    check (bedtime_goal_min between 0 and 1439);

comment on column user_config.sleep_goal_min is
  'Target nightly sleep duration in minutes.';

comment on column user_config.bedtime_goal_min is
  'Target local bedtime as minutes after midnight.';
