-- One injury log per day: the highest-pain reading wins. Collapse any existing
-- multiple-per-day rows down to the single highest-pain row (tie broken by the
-- most recent id) before enforcing the rule as a uniqueness constraint. The
-- day-merge itself lives in the app write path (addInjuryLog) since Postgres
-- upserts can't express "only overwrite when the new pain is >=".
delete from injury_notes a
using injury_notes b
where a.injury_id = b.injury_id
  and a.entry_date = b.entry_date
  and a.id <> b.id
  and (
    coalesce(b.pain_level, -1) > coalesce(a.pain_level, -1)
    or (coalesce(b.pain_level, -1) = coalesce(a.pain_level, -1) and b.id > a.id)
  );

alter table injury_notes
  add constraint injury_notes_injury_date_unique unique (injury_id, entry_date);
