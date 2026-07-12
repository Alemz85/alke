#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
// One-off backfill: re-parses outdoor workouts from raw_payloads (which retain
// the full route array the ingest downsamples/strips) and writes
// workout_route_points for workouts that predate the route ingest. Re-parsing
// with the same parser as live ingest means the downsampled route written
// here is IDENTICAL to what ingest would produce today. Idempotent: wholesale
// replace per workout, same as the ingest.
//
// Usage: deno run --allow-net --allow-env --allow-read --env-file=.env scripts/backfill_route_points.ts
import { createClient } from "npm:@supabase/supabase-js@2";
import { type NormalizedWorkout, parseIngestPayload } from "../supabase/functions/ingest/parse.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY required (use --env-file=.env)");
  Deno.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

// Page through raw_payloads oldest-first; later payloads override earlier
// ones per external_id (matches ingest upsert semantics).
const byExternalId = new Map<string, NormalizedWorkout>();
const PAGE = 20;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase
    .from("raw_payloads")
    .select("id, payload")
    .order("received_at", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) throw new Error(`raw_payloads page ${from}: ${error.message}`);
  if (!data || data.length === 0) break;
  for (const row of data) {
    try {
      const { workouts } = parseIngestPayload(row.payload);
      for (const w of workouts) {
        if (w.route.length > 0) byExternalId.set(w.external_id, w);
      }
    } catch {
      // non-workout or malformed payload — skip
    }
  }
  if (data.length < PAGE) break;
}
console.log(`found ${byExternalId.size} outdoor workout(s) with route data`);

const externalIds = [...byExternalId.keys()];
const { data: workoutRows, error: wErr } = await supabase
  .from("workouts")
  .select("id, external_id, start_at")
  .in("external_id", externalIds);
if (wErr) throw new Error(`workouts lookup: ${wErr.message}`);

let totalPoints = 0;
for (const row of workoutRows ?? []) {
  const w = byExternalId.get(row.external_id)!;
  const { error } = await supabase.from("workout_route_points").delete().eq("workout_id", row.id);
  if (error) throw new Error(`clear workout_route_points for ${row.id}: ${error.message}`);

  const pointRows = w.route.map((p) => ({ workout_id: row.id, ...p }));
  for (let i = 0; i < pointRows.length; i += 1000) {
    const { error } = await supabase.from("workout_route_points").insert(pointRows.slice(i, i + 1000));
    if (error) throw new Error(`insert route points for ${row.id}: ${error.message}`);
  }
  totalPoints += pointRows.length;
  console.log(`${row.start_at}  ${row.external_id}: ${pointRows.length} route points`);
}
console.log(`backfill complete: ${workoutRows?.length ?? 0} workouts, ${totalPoints} route points written`);
