// Deno.serve handler for POST /functions/v1/ingest.
// I/O shell only — all parsing/normalization logic lives in parse.ts (pure,
// unit tested). This file wires up auth, persistence, and the HTTP contract.
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type DailyMetricRow,
  mergeDailyMetric,
  type NormalizedWorkout,
  ParseError,
  parseIngestPayload,
} from "./parse.ts";

// Health Auto Export can send large backfills. Reject bodies above this
// size before attempting to buffer/parse them, and tell the user to narrow
// the export date range (the app sends backfills month-by-month).
const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized(): Response {
  return jsonResponse({ error: "unauthorized" }, 401);
}

function tooLarge(): Response {
  return jsonResponse(
    {
      error:
        "Payload too large. Please narrow the export date range and send backfills month-by-month.",
    },
    413,
  );
}

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function checkAuth(req: Request): boolean {
  const expected = Deno.env.get("INGEST_TOKEN");
  if (!expected) return false;
  const headerToken = req.headers.get("x-ingest-token");
  if (headerToken === expected) return true;
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  return queryToken === expected;
}

/** Reads the request body while enforcing MAX_BODY_BYTES without buffering unbounded data. */
async function readBodyWithLimit(req: Request): Promise<string | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return null;
  }
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  if (!checkAuth(req)) {
    return unauthorized();
  }

  const bodyText = await readBodyWithLimit(req);
  if (bodyText === null) {
    return tooLarge();
  }

  let payload: unknown;
  try {
    payload = bodyText.trim() === "" ? {} : JSON.parse(bodyText);
  } catch {
    // Oversized-but-under-limit or malformed JSON: still try to save the
    // raw text so nothing is lost, then report 422.
    return await saveRawAndFail(bodyText, "invalid JSON body");
  }

  const supabase = getSupabaseClient();

  // Store the raw payload FIRST — never lose a payload, even if parsing
  // fails afterward.
  const { error: rawInsertError } = await supabase
    .from("raw_payloads")
    .insert({ payload });
  if (rawInsertError) {
    return jsonResponse({ error: `failed to store raw payload: ${rawInsertError.message}` }, 500);
  }

  let parsed;
  try {
    parsed = parseIngestPayload(payload);
  } catch (e) {
    const reason = e instanceof ParseError ? e.message : "failed to parse payload";
    return jsonResponse({ error: reason }, 422);
  }

  let inserted = 0;
  let updated = 0;

  // --- Workouts: upsert on external_id -------------------------------
  if (parsed.workouts.length > 0) {
    const externalIds = parsed.workouts.map((w) => w.external_id);
    const { data: existingWorkouts, error: existingErr } = await supabase
      .from("workouts")
      .select("id, external_id")
      .in("external_id", externalIds);
    if (existingErr) {
      return jsonResponse({ error: `failed to read existing workouts: ${existingErr.message}` }, 500);
    }
    const existingByExternalId = new Map(
      (existingWorkouts ?? []).map((w: { id: string; external_id: string }) => [w.external_id, w.id]),
    );

    const rows = parsed.workouts.map((w: NormalizedWorkout) => {
      const { hrSamples: _hrSamples, swimSamples: _swimSamples, swimSets: _swimSets, ...workoutRow } = w;
      return workoutRow;
    });

    const { data: upserted, error: upsertErr } = await supabase
      .from("workouts")
      .upsert(rows, { onConflict: "external_id" })
      .select("id, external_id");
    if (upsertErr) {
      return jsonResponse({ error: `failed to upsert workouts: ${upsertErr.message}` }, 500);
    }

    for (const row of upserted ?? []) {
      if (existingByExternalId.has(row.external_id)) updated++;
      else inserted++;
    }

    const idByExternalId = new Map(
      (upserted ?? []).map((w: { id: string; external_id: string }) => [w.external_id, w.id]),
    );

    // --- HR samples: bulk insert, skip rows that already exist -------
    const hrRows: { workout_id: string; offset_s: number; bpm: number }[] = [];
    for (const w of parsed.workouts) {
      const workoutId = idByExternalId.get(w.external_id);
      if (!workoutId) continue;
      for (const sample of w.hrSamples) {
        hrRows.push({ workout_id: workoutId, offset_s: sample.offset_s, bpm: sample.bpm });
      }
    }
    if (hrRows.length > 0) {
      const { error: hrErr } = await supabase
        .from("workout_hr_samples")
        .upsert(hrRows, { onConflict: "workout_id,offset_s", ignoreDuplicates: true });
      if (hrErr) {
        return jsonResponse({ error: `failed to insert HR samples: ${hrErr.message}` }, 500);
      }
    }

    // --- Swim samples + sets: wholesale replace per workout --------------
    // Re-delivery may re-derive different set boundaries, so row-level
    // dedupe is wrong here: delete everything for the workout, re-insert.
    const swimWorkoutIds: string[] = [];
    const swimSampleRows: {
      workout_id: string;
      offset_s: number;
      distance_m: number;
      strokes: number;
    }[] = [];
    const swimSetRows: {
      workout_id: string;
      set_index: number;
      start_offset_s: number;
      duration_s: number;
      distance_m: number;
      strokes: number;
      rest_after_s: number | null;
    }[] = [];
    for (const w of parsed.workouts) {
      const workoutId = idByExternalId.get(w.external_id);
      if (!workoutId || w.swimSamples.length === 0) continue;
      swimWorkoutIds.push(workoutId);
      for (const s of w.swimSamples) {
        swimSampleRows.push({ workout_id: workoutId, ...s });
      }
      for (const s of w.swimSets) {
        swimSetRows.push({ workout_id: workoutId, ...s });
      }
    }
    if (swimWorkoutIds.length > 0) {
      for (const table of ["swim_sets", "workout_swim_samples"] as const) {
        const { error } = await supabase.from(table).delete().in("workout_id", swimWorkoutIds);
        if (error) {
          return jsonResponse({ error: `failed to clear ${table}: ${error.message}` }, 500);
        }
      }
      // ~1700 sample rows per swim; insert in chunks to keep request bodies sane.
      for (let i = 0; i < swimSampleRows.length; i += 1000) {
        const { error } = await supabase
          .from("workout_swim_samples")
          .insert(swimSampleRows.slice(i, i + 1000));
        if (error) {
          return jsonResponse({ error: `failed to insert swim samples: ${error.message}` }, 500);
        }
      }
      if (swimSetRows.length > 0) {
        const { error } = await supabase.from("swim_sets").insert(swimSetRows);
        if (error) {
          return jsonResponse({ error: `failed to insert swim sets: ${error.message}` }, 500);
        }
      }
    }
  }

  // --- Daily metrics: read existing, merge per column, upsert --------
  if (parsed.dailyMetrics.length > 0) {
    const dates = parsed.dailyMetrics.map((d) => d.date);
    const { data: existingRows, error: existingDailyErr } = await supabase
      .from("daily_metrics")
      .select("*")
      .in("date", dates);
    if (existingDailyErr) {
      return jsonResponse(
        { error: `failed to read existing daily_metrics: ${existingDailyErr.message}` },
        500,
      );
    }
    const existingByDate = new Map(
      (existingRows ?? []).map((r: DailyMetricRow) => [r.date, r]),
    );

    const mergedRows = parsed.dailyMetrics.map((incoming) =>
      mergeDailyMetric(existingByDate.get(incoming.date) ?? null, incoming)
    );

    const { error: dailyUpsertErr } = await supabase
      .from("daily_metrics")
      .upsert(mergedRows, { onConflict: "date" });
    if (dailyUpsertErr) {
      return jsonResponse({ error: `failed to upsert daily_metrics: ${dailyUpsertErr.message}` }, 500);
    }

    for (const d of parsed.dailyMetrics) {
      if (existingByDate.has(d.date)) updated++;
      else inserted++;
    }
  }

  return jsonResponse({ inserted, updated }, 200);

  async function saveRawAndFail(rawText: string, reason: string): Promise<Response> {
    const supabase = getSupabaseClient();
    let payload: unknown = null;
    try {
      payload = JSON.parse(rawText);
    } catch {
      // Truly not JSON — store as a wrapped string so nothing is lost.
      payload = { _unparsed_body: rawText };
    }
    const { error } = await supabase.from("raw_payloads").insert({ payload });
    if (error) {
      return jsonResponse({ error: `${reason}; also failed to store raw payload: ${error.message}` }, 422);
    }
    return jsonResponse({ error: reason }, 422);
  }
});
