-- Preserve the clock offset at the recorded sleep location. timestamptz keeps
-- the instant but not the source offset, which otherwise makes travel look
-- like a change in sleep timing when analytics localize everything to the
-- configured home timezone.
--
-- New ingests write this metadata inside the atomic sleep_stages JSON group.
-- Backfill only when an archived sleep aggregate matches the stored start AND
-- end instants exactly, so a shrunken HAE re-export cannot donate the wrong
-- offset to the keep-most-complete stored night.
with metric_groups as (
  select rp.received_at, metric
  from raw_payloads rp
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(rp.payload->'data'->'metrics') = 'array'
        then rp.payload->'data'->'metrics'
      else '[]'::jsonb
    end
  ) metric
  where metric->>'name' = 'sleep_analysis'
), sleep_entries as (
  select received_at, entry
  from metric_groups
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(metric->'data') = 'array' then metric->'data'
      else '[]'::jsonb
    end
  ) entry
), parsed as (
  select
    received_at,
    case
      when entry->>'sleepStart' ~ '^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d [+-]\d{2}:?\d{2}$'
        then (entry->>'sleepStart')::timestamptz
    end as sleep_start,
    case
      when entry->>'sleepEnd' ~ '^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d [+-]\d{2}:?\d{2}$'
        then (entry->>'sleepEnd')::timestamptz
    end as sleep_end,
    regexp_match(entry->>'sleepEnd', '([+-])(\d{2}):?(\d{2})$') as offset_parts
  from sleep_entries
), exact_matches as (
  select distinct on (dm.date)
    dm.date,
    (case when parsed.offset_parts[1] = '-' then -1 else 1 end)
      * (parsed.offset_parts[2]::int * 60 + parsed.offset_parts[3]::int)
      as offset_minutes
  from daily_metrics dm
  join parsed
    on parsed.sleep_start = dm.sleep_start
   and parsed.sleep_end = dm.sleep_end
  where parsed.offset_parts is not null
    and parsed.offset_parts[2]::int <= 14
    and parsed.offset_parts[3]::int <= 59
    and not (
      parsed.offset_parts[2]::int = 14
      and parsed.offset_parts[3]::int <> 0
    )
  order by dm.date, parsed.received_at desc
)
update daily_metrics dm
set sleep_stages = coalesce(dm.sleep_stages, '{}'::jsonb)
  || jsonb_build_object(
    '_sleep_end_timezone_offset_min', exact_matches.offset_minutes
  )
from exact_matches
where dm.date = exact_matches.date;
