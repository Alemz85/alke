// Deno.serve handler for GET /functions/v1/gymcard?key=<GYMCARD_TOKEN>.
//
// Read-only phone view of the active gym templates — the "what do I do at
// the gym" card, bookmarked on the owner's home screen. I/O shell only: all
// HTML assembly lives in render.ts (pure, unit tested). Auth is a shared
// secret carried in the URL so a plain browser bookmark works; the endpoint
// serves nothing but exercise prescriptions (no health metrics, no injury
// prose), which is the deal that makes a capability URL acceptable.
// Rotation: `supabase secrets set GYMCARD_TOKEN=...`.
import { createClient } from "npm:@supabase/supabase-js@2";
import { type CardTemplate, renderGymCard } from "./render.ts";

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Same constant-time comparison as the ingest function (see its doc comment
// for the timing rationale). Kept per-function: the two functions deploy as
// independent bundles and share no module path.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    const x = i < aBytes.length ? aBytes[i] : 0;
    const y = i < bBytes.length ? bBytes[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

function checkAuth(req: Request): boolean {
  const expected = Deno.env.get("GYMCARD_TOKEN");
  if (!expected) return false;
  const key = new URL(req.url).searchParams.get("key");
  return key !== null && timingSafeEqual(key, expected);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!checkAuth(req)) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabase = getSupabaseClient();

  const { data: templates, error } = await supabase
    .from("gym_templates")
    .select("id, name, version, notes, default_rest_s, archived, is_current")
    .eq("is_current", true)
    .eq("archived", false)
    .order("created_at", { ascending: true });
  if (error) return new Response(`query failed: ${error.message}`, { status: 500 });

  const ids = (templates ?? []).map((t) => t.id);
  const [items, runs, sessions] = await Promise.all([
    ids.length
      ? supabase
        .from("gym_template_exercises")
        .select(
          "template_id, position, target_sets, target_reps, target_duration_seconds, target_weight_kg, rest_after_s, note, exercise:exercises(name)",
        )
        .in("template_id", ids)
        .order("position", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? supabase
        .from("gym_template_runs")
        .select("template_id, started_at, ended_at")
        .in("template_id", ids)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("gym_sessions").select("performed_at, template_ids"),
  ]);
  for (const result of [items, runs, sessions]) {
    if (result.error) {
      return new Response(`query failed: ${result.error.message}`, { status: 500 });
    }
  }

  const cards: CardTemplate[] = (templates ?? []).map((t) => {
    const activeRun = (runs.data ?? []).find(
      (r) => r.template_id === t.id && r.ended_at === null,
    );
    let lastDone: string | null = null;
    let doneCount = 0;
    for (const s of sessions.data ?? []) {
      if (!(s.template_ids ?? []).includes(t.id)) continue;
      doneCount += 1;
      const day = String(s.performed_at).slice(0, 10);
      if (lastDone === null || day > lastDone) lastDone = day;
    }
    return {
      id: t.id,
      name: t.name,
      version: t.version,
      notes: t.notes,
      default_rest_s: t.default_rest_s,
      active_since: activeRun ? String(activeRun.started_at) : null,
      last_done: lastDone,
      done_count: doneCount,
      items: (items.data ?? [])
        .filter((row) => row.template_id === t.id)
        .map((row) => ({
          exercise_name:
            (row.exercise as unknown as { name: string } | null)?.name ?? "?",
          position: row.position,
          target_sets: row.target_sets,
          target_reps: row.target_reps,
          target_duration_seconds: row.target_duration_seconds,
          target_weight_kg: row.target_weight_kg,
          rest_after_s: row.rest_after_s,
          note: row.note,
        })),
    };
  });

  return new Response(renderGymCard(cards, new Date()), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Always current — the whole point over a photographed screen.
      "cache-control": "no-store",
    },
  });
});
