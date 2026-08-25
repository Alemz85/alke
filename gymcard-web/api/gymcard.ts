// Vercel serverless port of supabase/functions/gymcard — same auth, same
// queries, same render.ts. Lives on Vercel because Supabase rewrites any
// text/html Edge Function response to text/plain on the shared *.supabase.co
// domain (anti-phishing policy; rendered HTML needs Pro + custom domain).
// The Deno original stays in-repo as the render.ts source of truth and test
// host; deploy.sh copies render.ts here so there is exactly ONE renderer.
//
// Env (Vercel project settings): SUPABASE_URL, SUPABASE_SERVICE_KEY (or
// SUPABASE_SERVICE_ROLE_KEY), GYMCARD_TOKEN. Rotation:
// `vercel env rm/add GYMCARD_TOKEN production` + re-deploy.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import {
  buildLastLogs,
  type CardRehabItem,
  type CardTemplate,
  currentPlanWeek,
  isoWeekStart,
  type LoggedSetRow,
  renderGymCard,
  resolveWeeklyTarget,
  type SessionLinkRow,
} from "../render";

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Same constant-time comparison as the ingest function (see its doc comment
// for the timing rationale). Kept per-deployment: this bundle shares no
// module path with the Supabase functions.
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

function checkAuth(req: VercelRequest): boolean {
  const expected = process.env.GYMCARD_TOKEN;
  if (!expected) return false;
  const key = req.query.key;
  return typeof key === "string" && timingSafeEqual(key, expected);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).send("method not allowed");
    return;
  }
  if (!checkAuth(req)) {
    res.status(401).send("unauthorized");
    return;
  }

  const supabase = getSupabaseClient();

  const { data: templates, error } = await supabase
    .from("gym_templates")
    .select("id, family_id, name, version, notes, default_rest_s, archived, is_current")
    .eq("is_current", true)
    .eq("archived", false)
    .order("created_at", { ascending: true });
  if (error) {
    res.status(500).send(`query failed: ${error.message}`);
    return;
  }

  const ids = (templates ?? []).map((t) => t.id);
  const familyIds = [...new Set((templates ?? []).map((t) => t.family_id as string))];

  // Every version in each family: sessions stay linked to the version they
  // were logged against, so per-template history has to match family-wide.
  const family = familyIds.length
    ? await supabase.from("gym_templates").select("id, family_id").in("family_id", familyIds)
    : { data: [], error: null };
  if (family.error) {
    res.status(500).send(`query failed: ${family.error.message}`);
    return;
  }
  const familyByVersion = new Map(
    (family.data ?? []).map((row) => [row.id as string, row.family_id as string]),
  );
  const allVersionIds = [...familyByVersion.keys()];

  const [items, runs, sessions] = await Promise.all([
    ids.length
      ? supabase
        .from("gym_template_exercises")
        .select(
          "template_id, exercise_id, position, target_sets, target_reps, target_duration_seconds, target_weight_kg, rest_after_s, note, exercise:exercises(name, equipment)",
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
    // Sessions link to templates via the gym_session_templates join table
    // (gym_sessions.template_id is only the legacy/primary link) — same source
    // the app's own template stats read. Fetched family-wide for the last-set
    // lookup; the done-count/last-done stats below still filter to t.id.
    allVersionIds.length
      ? supabase
        .from("gym_session_templates")
        .select("template_id, session_id, session:gym_sessions(performed_at)")
        .in("template_id", allVersionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [items, runs, sessions]) {
    if (result.error) {
      res.status(500).send(`query failed: ${result.error.message}`);
      return;
    }
  }

  // ── Last logged working sets per (family, exercise) ──────────────────────
  const linkRows: SessionLinkRow[] = (sessions.data ?? []).map((link) => ({
    template_id: link.template_id as string,
    session_id: link.session_id as string,
    performed_at:
      (link.session as unknown as { performed_at: string } | null)?.performed_at ?? null,
  }));
  // Newest-first unique sessions, capped so the sets query's URL stays
  // bounded; an exercise absent from the last 80 linked sessions shows none.
  const seenSessions = new Set<string>();
  const recentSessionIds = linkRows
    .filter((row) => row.performed_at != null)
    .sort((a, b) => String(b.performed_at).localeCompare(String(a.performed_at)))
    .filter((row) =>
      seenSessions.has(row.session_id) ? false : (seenSessions.add(row.session_id), true)
    )
    .slice(0, 80)
    .map((row) => row.session_id);
  const exerciseIds = [
    ...new Set((items.data ?? []).map((row) => row.exercise_id as string)),
  ];
  const sets = recentSessionIds.length && exerciseIds.length
    ? await supabase
      .from("gym_sets")
      .select("session_id, exercise_id, position, reps, weight_kg, duration_s, is_unilateral")
      .in("session_id", recentSessionIds)
      .in("exercise_id", exerciseIds)
      .eq("is_warmup", false)
    : { data: [], error: null };
  if (sets.error) {
    res.status(500).send(`query failed: ${sets.error.message}`);
    return;
  }
  const lastLogs = buildLastLogs(
    linkRows,
    (sets.data ?? []) as LoggedSetRow[],
    familyByVersion,
  );

  const cards: CardTemplate[] = (templates ?? []).map((t) => {
    const activeRun = (runs.data ?? []).find(
      (r) => r.template_id === t.id && r.ended_at === null,
    );
    let lastDone: string | null = null;
    let doneCount = 0;
    for (const link of sessions.data ?? []) {
      if (link.template_id !== t.id) continue;
      const performedAt =
        (link.session as unknown as { performed_at: string } | null)
          ?.performed_at;
      if (performedAt == null) continue;
      doneCount += 1;
      const day = String(performedAt).slice(0, 10);
      if (lastDone === null || day > lastDone) lastDone = day;
    }
    return {
      id: t.id,
      family_id: t.family_id as string,
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
          // Dumbbell/kettlebell loads are stored PER HAND (modes/_shared.md);
          // the renderer stamps "kg/hand" so a per-hand load can't read as the pair's total.
          per_hand: ["dumbbell", "kettlebell"].includes(
            (row.exercise as unknown as { equipment?: string | null } | null)?.equipment ?? "",
          ),
          position: row.position,
          target_sets: row.target_sets,
          target_reps: row.target_reps,
          target_duration_seconds: row.target_duration_seconds,
          target_weight_kg: row.target_weight_kg,
          rest_after_s: row.rest_after_s,
          note: row.note,
          last_log: lastLogs.get(`${t.family_id}|${row.exercise_id}`) ?? null,
        })),
    };
  });

  // ── Recovery plan: accountable rehab exercises, dose in force this week ──
  // The card must agree with the desktop app and the chat agent about which
  // target applies (calendar and symptom-gated phase steps both resolve in
  // render.ts's ports of resolve_targets / current_plan_week).
  const [config, injuries, planItems] = await Promise.all([
    supabase.from("user_config").select("timezone").eq("id", 1).maybeSingle(),
    supabase
      .from("injuries")
      .select("id, name, status, plan_started_at")
      .neq("status", "resolved"),
    supabase
      .from("recovery_plan_items")
      .select(
        "id, injury_id, name, kind, start_week, weekly_target, phases, target_sets, target_reps, steps, active",
      )
      .eq("active", true)
      .eq("kind", "exercise"),
  ]);
  for (const result of [config, injuries, planItems]) {
    if (result.error) {
      res.status(500).send(`query failed: ${result.error.message}`);
      return;
    }
  }

  const timezone = config.data?.timezone ?? "UTC";
  // en-CA formats as YYYY-MM-DD — "today" in the OWNER's timezone, so plan
  // weeks and the check-count week roll over at their midnight, not UTC's.
  const todayYMD = new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
    .format(new Date());
  const weekStart = isoWeekStart(todayYMD);

  const { data: checks, error: checksError } = await supabase
    .from("plan_item_checks")
    .select("item_id, done_date")
    .gte("done_date", weekStart);
  if (checksError) {
    res.status(500).send(`query failed: ${checksError.message}`);
    return;
  }

  const injuryById = new Map(
    (injuries.data ?? []).map((row) => [row.id, row]),
  );
  const rehab: CardRehabItem[] = [];
  for (const item of planItems.data ?? []) {
    const injury = injuryById.get(item.injury_id);
    if (!injury) continue; // resolved injury — its rehab is history, not a card
    const planWeek = currentPlanWeek(injury.plan_started_at, todayYMD);
    // Future-phase items exist in the plan but are not due yet; a legacy plan
    // (no start date) treats every active item as accountable.
    if (planWeek != null && (item.start_week ?? 1) > planWeek) continue;
    const doneDays = new Set(
      (checks ?? [])
        .filter((c) =>
          c.item_id === item.id && String(c.done_date).slice(0, 10) <= todayYMD
        )
        .map((c) => String(c.done_date).slice(0, 10)),
    );
    rehab.push({
      name: item.name,
      injury_name: injury.name,
      weekly_target: resolveWeeklyTarget(
        item.weekly_target,
        item.phases,
        planWeek,
        injury.plan_started_at,
      ),
      done_this_week: doneDays.size,
      target_sets: item.target_sets,
      target_reps: item.target_reps,
      steps: item.steps,
    });
  }
  rehab.sort((a, b) =>
    a.injury_name.localeCompare(b.injury_name) || a.name.localeCompare(b.name)
  );

  res
    .status(200)
    .setHeader("content-type", "text/html; charset=utf-8")
    // Always current — the whole point over a photographed screen.
    .setHeader("cache-control", "no-store")
    .send(renderGymCard(cards, rehab, new Date()));
}
