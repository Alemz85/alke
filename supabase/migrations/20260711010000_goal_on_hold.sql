-- Goals can be put on hold: paused, not failed. On-hold goals keep their
-- metric and history but the nightly job stops re-evaluating them (it only
-- processes status='active'), so the curve freezes until the goal resumes.
alter table goals drop constraint goals_status_check;
alter table goals add constraint goals_status_check
  check (status in ('active', 'on_hold', 'completed', 'abandoned'));
