#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
// One-off backfill: re-parses swim workouts from raw_payloads (which retain
// the swimDistance/swimStroke series the ingest used to strip) and writes
// workout_swim_samples + swim_sets for workouts that predate the swim-set
// ingest. Idempotent: wholesale replace per workout, same as the ingest.
//
// Usage: deno run --allow-net --allow-env --allow-read --env-file=.env scripts/backfill_swim_sets.ts
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
        if (w.swimSamples.length > 0) byExternalId.set(w.external_id, w);
      }
    } catch {
      // non-workout or malformed payload — skip
    }
  }
  if (data.length < PAGE) break;
}
console.log(`found ${byExternalId.size} swim workout(s) with series data`);

const externalIds = [...byExternalId.keys()];
const { data: workoutRows, error: wErr } = await supabase
  .from("workouts")
  .select("id, external_id, start_at")
  .in("external_id", externalIds);
if (wErr) throw new Error(`workouts lookup: ${wErr.message}`);

for (const row of workoutRows ?? []) {
  const w = byExternalId.get(row.external_id)!;
  for (const table of ["swim_sets", "workout_swim_samples"] as const) {
    const { error } = await supabase.from(table).delete().eq("workout_id", row.id);
    if (error) throw new Error(`clear ${table} for ${row.id}: ${error.message}`);
  }
  const sampleRows = w.swimSamples.map((s) => ({ workout_id: row.id, ...s }));
  for (let i = 0; i < sampleRows.length; i += 1000) {
    const { error } = await supabase.from("workout_swim_samples").insert(sampleRows.slice(i, i + 1000));
    if (error) throw new Error(`insert samples for ${row.id}: ${error.message}`);
  }
  const setRows = w.swimSets.map((s) => ({ workout_id: row.id, ...s }));
  if (setRows.length > 0) {
    const { error } = await supabase.from("swim_sets").insert(setRows);
    if (error) throw new Error(`insert sets for ${row.id}: ${error.message}`);
  }
  console.log(`${row.start_at}  ${row.external_id}: ${setRows.length} sets, ${sampleRows.length} samples`);
}
console.log("backfill complete");
