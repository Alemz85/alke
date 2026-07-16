#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
// One-off backfill: re-parses raw_payloads for the two daily activity metrics
// that ingest silently dropped until FIELD_MAP mapped them
// (walking_running_distance -> daily_metrics.walking_running_distance_m,
// flights_climbed -> daily_metrics.flights_climbed; see
// supabase/migrations/20260716120000_daily_walking_distance_flights.sql).
//
// Aggregation mirrors live ingest exactly, by reusing the same pure parser:
//   1. Within one payload, parseIngestPayload/parseMetrics already sums same-
//      date entries (multiple samples on one calendar date add up), and
//      converts distance to meters via FIELD_MAP.distanceUnitToMeters.
//   2. Across payloads (a date's activity total can be spread over more than
//      one raw_payloads row, e.g. incremental HAE syncs), this script walks
//      payloads OLDEST-FIRST and calls the same mergeDailyMetric() the live
//      ingest handler calls per POST. For these two columns mergeDailyMetric
//      does a plain "incoming non-null replaces existing" per-column merge
//      (same as `steps`) -- NOT an additive merge across payloads. That
//      matches ingest's real-world behavior: each HAE metrics export already
//      contains the FULL summed total for every date it covers (HAE resends
//      whole-date aggregates, not deltas), so the latest payload touching a
//      date wins for that date, exactly like it would if these payloads were
//      POSTed live in order today.
//
// Idempotent + surgical: re-running recomputes the same result and only ever
// writes walking_running_distance_m/flights_climbed via upsert(onConflict:
// "date") — no other daily_metrics column is read or written. Creates a
// daily_metrics row (date-only) if a date has activity data but no row yet,
// mirroring the ingest daily-metrics upsert path in index.ts.
//
// Usage:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/backfill_daily_activity.ts [--dry-run]
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type DailyMetricRow,
  mergeDailyMetric,
  parseIngestPayload,
} from "../supabase/functions/ingest/parse.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY required (use --env-file=.env)");
  Deno.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const DRY_RUN = Deno.args.includes("--dry-run");

// Only these two columns are ever touched by this script.
const COLUMNS = ["walking_running_distance_m", "flights_climbed"] as const;
type Row = { date: string } & Partial<Record<(typeof COLUMNS)[number], unknown>>;

// Running merged state per date, built up by walking raw_payloads oldest to
// newest and applying the SAME mergeDailyMetric() live ingest uses per POST.
const byDate = new Map<string, Row>();

const PAGE = 100;
let payloadsSeen = 0;
let payloadsWithActivity = 0;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase
    .from("raw_payloads")
    .select("id, payload, received_at")
    .order("received_at", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) throw new Error(`raw_payloads page ${from}: ${error.message}`);
  if (!data || data.length === 0) break;

  for (const row of data) {
    payloadsSeen++;
    let dailyMetrics;
    try {
      ({ dailyMetrics } = parseIngestPayload(row.payload));
    } catch {
      continue; // malformed/non-metrics payload — skip
    }

    let touchedThisPayload = false;
    for (const dm of dailyMetrics) {
      const hasDistance = dm.walking_running_distance_m !== null;
      const hasFlights = dm.flights_climbed !== null;
      if (!hasDistance && !hasFlights) continue;
      touchedThisPayload = true;

      const incoming: Row = {
        date: dm.date,
        walking_running_distance_m: dm.walking_running_distance_m,
        flights_climbed: dm.flights_climbed,
      };
      const existing = byDate.get(dm.date) ?? null;
      const merged = mergeDailyMetric(
        existing as DailyMetricRow | null,
        incoming as DailyMetricRow,
      );
      byDate.set(dm.date, merged as Row);
    }
    if (touchedThisPayload) payloadsWithActivity++;
  }
  if (data.length < PAGE) break;
}

const dates = [...byDate.keys()].sort();
console.log(
  `scanned ${payloadsSeen} raw_payloads (${payloadsWithActivity} contained walking_running_distance/flights_climbed data)`,
);
console.log(`${dates.length} distinct date(s) covered`);
if (dates.length > 0) {
  console.log(`date range: ${dates[0]} .. ${dates[dates.length - 1]}`);
}

if (DRY_RUN) {
  console.log("\n--dry-run: no writes performed. Sample of planned values:");
  const sample = dates.slice(0, 7);
  for (const d of sample) {
    const r = byDate.get(d)!;
    console.log(
      `  ${d}  walking_running_distance_m=${r.walking_running_distance_m ?? "null"}  flights_climbed=${r.flights_climbed ?? "null"}`,
    );
  }
  if (dates.length > sample.length) {
    console.log(`  ... and ${dates.length - sample.length} more date(s)`);
  }
  Deno.exit(0);
}

// --- Write: upsert only the two target columns, never touching others ------
const rows: Row[] = dates.map((d) => {
  const r = byDate.get(d)!;
  return {
    date: d,
    walking_running_distance_m: r.walking_running_distance_m ?? null,
    flights_climbed: r.flights_climbed ?? null,
  };
});

let written = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await supabase
    .from("daily_metrics")
    .upsert(chunk, { onConflict: "date" });
  if (error) throw new Error(`upsert daily_metrics chunk ${i}: ${error.message}`);
  written += chunk.length;
}

console.log(`\nwrote ${written} daily_metrics row(s) (walking_running_distance_m + flights_climbed only)`);
console.log("backfill complete");
