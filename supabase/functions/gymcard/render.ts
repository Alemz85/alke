// Pure HTML renderer for the phone gym card — no I/O, unit tested.
//
// The card is the answer to one question, asked between sets on a phone:
// "what do I do next?" So exercise name, dose, and last logged sets lead
// every row; coaching notes collapse to previews; template cards fold.
// The whole page is one HTML document with inline styles and a single
// inline script (collapse persistence — progressive enhancement only):
// zero network dependencies, nothing to fail on gym Wi-Fi, which is also
// why type stays on the system stack. Tokens follow DESIGN.md (true-black
// canvas, luminance elevation, hairlines, sessions accent #FB923C).

export interface CardLastSet {
  reps: number | null;
  weight_kg: number | null;
  duration_s: number | null;
  /** Single-arm/-leg set: weight is PER SIDE, never comparable to bilateral sets (agent_log #31). */
  is_unilateral?: boolean;
}

/** The working sets last logged for this exercise ON THIS TEMPLATE (family). */
export interface CardLastLog {
  /** YYYY-MM-DD of the session the sets come from. */
  date: string;
  sets: CardLastSet[];
}

export interface CardTemplateItem {
  exercise_name: string;
  /** Dumbbell/kettlebell: stored weights are PER HAND (modes/_shared.md convention) and render "kg/hand". */
  per_hand?: boolean;
  position: number;
  target_sets: number | null;
  target_reps: number | null;
  target_duration_seconds: number | null;
  target_weight_kg: number | null;
  rest_after_s: number | null;
  note: string | null;
  last_log?: CardLastLog | null;
}

export interface CardTemplate {
  id: string;
  /** Version family — the stable identity used to persist collapse state. */
  family_id?: string;
  name: string;
  version: number;
  notes: string | null;
  default_rest_s: number | null;
  /** Started date of an open run (YYYY-MM-DD…), null when not running. */
  active_since: string | null;
  /** Most recent logged session date using this template, null when never. */
  last_done: string | null;
  done_count: number;
  items: CardTemplateItem[];
}

export interface CardRehabStep {
  name: string;
  sets: number | null;
  reps: number | null;
  duration_seconds: number | null;
  distance_m: number | null;
  per_side: boolean | null;
  note: string | null;
}

export interface CardRehabItem {
  name: string;
  /** Owning injury, shown as a small tag — the card lists rehab flat. */
  injury_name: string;
  /** Weekly target in force this plan week (phases resolved), null = untargeted. */
  weekly_target: number | null;
  /** Distinct days checked this ISO week. */
  done_this_week: number;
  target_sets: number | null;
  target_reps: number | null;
  steps: CardRehabStep[] | null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "3 × 10" / "3 × 45s" / "2 × 20 m"-free: templates carry reps or seconds. */
export function doseText(item: CardTemplateItem): string {
  const measure = item.target_reps != null
    ? String(item.target_reps)
    : item.target_duration_seconds != null
    ? `${item.target_duration_seconds}s`
    : null;
  if (measure === null) return item.target_sets != null ? `${item.target_sets} sets` : "—";
  return item.target_sets != null ? `${item.target_sets} × ${measure}` : measure;
}

/**
 * "60 kg × 10, 10, 8" — the sets actually done, compressed for one line.
 * Uniform weight leads once; mixed weights list per set; bodyweight lists
 * the bare measures (the row's prescription supplies the unit context).
 * Unilateral sets carry a "·uni" marker (weight is per SIDE — same vocabulary
 * as gym.py list and the app's Unilateral checkbox), and the marker is part of
 * a set's grouping identity: a unilateral and a bilateral set at the same
 * weight must never fold into one run, because their loads are incomparable
 * (agent_log #31). `perHand` renders dumbbell/kettlebell weights "kg/hand"
 * (per-hand storage convention, agent_log #30).
 */
export function lastLogText(log: CardLastLog, perHand = false): string {
  const measure = (s: CardLastSet) =>
    s.duration_s != null ? `${s.duration_s}s` : s.reps != null ? String(s.reps) : "—";
  const kgUnit = perHand ? "kg/hand" : "kg";
  const identity = (s: CardLastSet) =>
    `${s.weight_kg == null ? "bw" : String(s.weight_kg)}|${s.is_unilateral === true}`;
  const identities = new Set(log.sets.map(identity));
  if (identities.size <= 1) {
    const w = log.sets[0]?.weight_kg;
    const uni = log.sets[0]?.is_unilateral === true ? " ·uni" : "";
    const measures = log.sets.map(measure).join(", ");
    return w != null ? `${w} ${kgUnit} × ${measures}${uni}` : `${measures}${uni}`;
  }
  // Mixed weights: consecutive same-identity sets fold into one run, so a
  // drop-set day reads "45kg×10,10 · 40kg×10,10" instead of four tokens.
  const runs: { w: number | null; uni: boolean; ms: string[] }[] = [];
  for (const s of log.sets) {
    const w = s.weight_kg ?? null;
    const uni = s.is_unilateral === true;
    const prev = runs[runs.length - 1];
    if (prev && String(prev.w) === String(w) && prev.uni === uni) prev.ms.push(measure(s));
    else runs.push({ w, uni, ms: [measure(s)] });
  }
  return runs
    .map((r) =>
      `${r.w != null ? `${r.w}${kgUnit}` : "bw"}×${r.ms.join(",")}${r.uni ? "·uni" : ""}`
    )
    .join(" · ");
}

// Raw query rows the handlers feed into buildLastLogs — kept structural so
// both the Deno and Vercel handlers can pass their supabase-js results as-is.
export interface SessionLinkRow {
  /** Template VERSION id the session was logged against (any version). */
  template_id: string;
  session_id: string;
  performed_at: string | null;
}

export interface LoggedSetRow {
  session_id: string;
  exercise_id: string;
  position: number;
  reps: number | null;
  /** numeric comes back as number or string depending on the driver. */
  weight_kg: number | string | null;
  duration_s: number | null;
  is_unilateral?: boolean | null;
}

/**
 * Last logged working sets per (template family, exercise), keyed
 * `${family_id}|${exercise_id}`. Sessions count for a template only when
 * linked to it via gym_session_templates — so doing exercise A under
 * template A never surfaces on template B's card, even if B also lists A.
 * Matching by family keeps history across template version bumps.
 */
export function buildLastLogs(
  links: SessionLinkRow[],
  sets: LoggedSetRow[],
  familyByVersion: Map<string, string>,
): Map<string, CardLastLog> {
  const sessionDate = new Map<string, string>();
  const sessionFamilies = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.performed_at == null) continue;
    const family = familyByVersion.get(link.template_id);
    if (family === undefined) continue;
    sessionDate.set(link.session_id, String(link.performed_at));
    let families = sessionFamilies.get(link.session_id);
    if (!families) sessionFamilies.set(link.session_id, families = new Set());
    families.add(family);
  }

  const bySessionExercise = new Map<string, LoggedSetRow[]>();
  for (const set of sets) {
    const key = `${set.session_id}|${set.exercise_id}`;
    let group = bySessionExercise.get(key);
    if (!group) bySessionExercise.set(key, group = []);
    group.push(set);
  }

  const latest = new Map<string, { at: string; log: CardLastLog }>();
  for (const [key, group] of bySessionExercise) {
    const [sessionId, exerciseId] = key.split("|");
    const at = sessionDate.get(sessionId);
    if (at === undefined) continue;
    const log: CardLastLog = {
      date: at.slice(0, 10),
      sets: [...group]
        .sort((a, b) => a.position - b.position)
        .map((s) => ({
          reps: s.reps,
          weight_kg: s.weight_kg == null ? null : Number(s.weight_kg),
          duration_s: s.duration_s,
          is_unilateral: s.is_unilateral === true,
        })),
    };
    for (const family of sessionFamilies.get(sessionId) ?? []) {
      const target = `${family}|${exerciseId}`;
      const current = latest.get(target);
      if (!current || at > current.at) latest.set(target, { at, log });
    }
  }
  return new Map([...latest].map(([key, value]) => [key, value.log]));
}

export function restText(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

// ── recovery-plan resolution ─────────────────────────────────────────────────
// Faithful ports of chatctx/injuries.py (current_plan_week / resolve_targets /
// step_dose_text / plan_item_dose_text) — keep the four implementations in
// step (the others: app lib/injuryStats.ts). The card must agree with the
// desktop app about which dose is in force, including symptom-gated phase
// steps: a pending gate never changes targets, an applied one counts from the
// week containing its applied_on.

export interface PhaseGate {
  max_pain: number;
  clear_days: number;
}

export interface PhaseStep {
  from_week?: number | null;
  gate?: PhaseGate | null;
  applied_on?: string | null;
  weekly_target: number;
  green_min: number;
  yellow_min: number;
}

/** 1-based cumulative plan week at `todayYMD`; 0 before start; null legacy. */
export function currentPlanWeek(planStartedAt: string | null, todayYMD: string): number | null {
  if (!planStartedAt) return null;
  const elapsed = Math.round(
    (Date.parse(`${todayYMD.slice(0, 10)}T12:00:00Z`) -
      Date.parse(`${planStartedAt.slice(0, 10)}T12:00:00Z`)) / 86_400_000,
  );
  return elapsed < 0 ? 0 : Math.floor(elapsed / 7) + 1;
}

function phaseEffectiveWeek(phase: PhaseStep, planStartedAt: string | null): number | null {
  if (phase.gate != null) {
    if (!phase.applied_on || !planStartedAt) return null;
    return currentPlanWeek(planStartedAt, phase.applied_on);
  }
  return phase.from_week ?? null;
}

/** The weekly target in force for `planWeek` — last started phase wins. */
export function resolveWeeklyTarget(
  base: number | null,
  phases: PhaseStep[] | null,
  planWeek: number | null,
  planStartedAt: string | null,
): number | null {
  if (planWeek == null || !phases || phases.length === 0) return base;
  const started = phases
    .map((phase, index) => ({ phase, index, week: phaseEffectiveWeek(phase, planStartedAt) }))
    .filter((s): s is { phase: PhaseStep; index: number; week: number } =>
      s.week != null && s.week <= planWeek
    )
    .sort((a, b) => a.week - b.week || a.index - b.index);
  const last = started[started.length - 1];
  return last ? last.phase.weekly_target : base;
}

/** Monday of the ISO week containing `ymd`. */
export function isoWeekStart(ymd: string): string {
  const date = new Date(`${ymd.slice(0, 10)}T12:00:00Z`);
  const dow = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dow);
  return date.toISOString().slice(0, 10);
}

function stepDoseText(step: CardRehabStep, fallbackSets: number | null): string {
  let measure: string;
  if (step.duration_seconds != null) measure = `${step.duration_seconds}s`;
  else if (step.distance_m != null) measure = `${step.distance_m} m`;
  else if (step.reps != null) measure = `${step.reps} reps`;
  else measure = "as directed";
  const sets = step.sets ?? fallbackSets;
  if (sets != null) measure = `${sets} × ${measure}`;
  if (step.per_side) measure += " / side";
  return measure;
}

/** The prescription in the measure it was given — a single step IS the dose. */
export function rehabDoseText(item: CardRehabItem): string {
  const steps = item.steps ?? [];
  if (steps.length === 1) return stepDoseText(steps[0], item.target_sets);
  if (steps.length > 1) return `${steps.length} movements`;
  if (item.target_sets != null && item.target_reps != null) {
    return `${item.target_sets} × ${item.target_reps}`;
  }
  return "—";
}

/** Month-day, year only when it differs from the render year: "Aug 18" / "Aug 18 2025". */
function fmtDay(iso: string, contextYear?: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const day = `${MONTHS[(m ?? 1) - 1]} ${d}`;
  return contextYear != null && y === contextYear ? day : `${day} ${y}`;
}

/**
 * A coaching note: short ones render whole; long ones collapse to a two-line
 * preview that expands on tap. <details> keeps the page script-free, and the
 * full text stays in the DOM (the clamp is visual only) for find-in-page
 * and screen readers.
 */
function noteHtml(note: string | null): string {
  if (!note) return "";
  if (note.length <= 140) return `<p class="note">${escapeHtml(note)}</p>`;
  return `<details class="cue"><summary><span class="txt">${
    escapeHtml(note)
  }</span><span class="chev" aria-hidden="true"></span></summary></details>`;
}

function rehabItemHtml(item: CardRehabItem): string {
  const steps = item.steps ?? [];
  const target = item.weekly_target;
  const done = target != null ? Math.min(item.done_this_week, target) : 0;
  // Weekly adherence as a dot meter (filled = days done); the count text
  // carries the meaning, the dots are the glance.
  const dots = target != null && target >= 1 && target <= 10
    ? `<span class="wk" aria-hidden="true">${
      Array.from({ length: target }, (_, i) => `<i${i < done ? ' class="on"' : ""}></i>`).join("")
    }</span>`
    : "";
  const week = target != null
    ? `<div class="last"><span class="lk">Week</span><b>${
      escapeHtml(`${item.done_this_week}/${target} this week`)
    }</b>${dots}</div>`
    : "";
  return `<li>
<span class="name">${escapeHtml(item.name)}<span class="tag">${escapeHtml(item.injury_name)}</span></span>
<span class="dose">${escapeHtml(rehabDoseText(item))}</span>
<div class="sub">
${week}
${
    steps.length > 1
      ? `<ul class="steps">${
        steps.map((step) =>
          `<li><span>${escapeHtml(step.name)}</span><span>${
            escapeHtml(stepDoseText(step, null))
          }</span></li>`
        ).join("")
      }</ul>`
      : ""
  }
${steps.length === 1 && steps[0].note ? noteHtml(steps[0].note) : ""}
</div>
</li>`;
}

function rehabSectionHtml(items: CardRehabItem[]): string {
  if (items.length === 0) return "";
  return `<details class="tcard rehab" data-key="rehab" open>
<summary>
<h2>Recovery plan</h2>
<p class="meta">Accountable rehab · this week's dose in force</p>
<i class="chev" aria-hidden="true"></i>
</summary>
<ol class="rlist">
${items.map(rehabItemHtml).join("\n")}
</ol>
</details>`;
}

function statusText(template: CardTemplate, year: number): string {
  if (template.active_since) return `Active since ${fmtDay(template.active_since, year)}`;
  if (template.last_done) return `Last done ${fmtDay(template.last_done, year)}`;
  return "Not started";
}

function itemHtml(
  item: CardTemplateItem,
  defaultRest: number | null,
  index: number,
  year: number,
): string {
  const rest = item.rest_after_s ?? defaultRest;
  const meta: string[] = [];
  if (item.target_weight_kg != null) {
    meta.push(`${item.target_weight_kg} ${item.per_hand ? "kg/hand" : "kg"}`);
  }
  if (item.rest_after_s != null && rest != null) meta.push(`rest ${restText(rest)}`);
  const last = item.last_log
    ? `<div class="last"><span class="lk">Last</span><b>${
      escapeHtml(lastLogText(item.last_log, item.per_hand === true))
    }</b><span class="when">${escapeHtml(fmtDay(item.last_log.date, year))}</span></div>`
    : "";
  return `<li>
<span class="idx">${index}</span>
<span class="name">${escapeHtml(item.exercise_name)}</span>
<span class="dose">${escapeHtml(doseText(item))}${
    meta.length ? `<small>${escapeHtml(meta.join(" · "))}</small>` : ""
  }</span>
<div class="sub">
${last}
${noteHtml(item.note)}
</div>
</li>`;
}

function templateHtml(template: CardTemplate, year: number): string {
  const items = [...template.items].sort((a, b) => a.position - b.position);
  const facts = [
    template.version > 1 ? `v${template.version}` : null,
    `${items.length} exercise${items.length === 1 ? "" : "s"}`,
    template.default_rest_s != null ? `rest ${restText(template.default_rest_s)}` : null,
    template.done_count > 0 ? `done ${template.done_count}×` : null,
  ].filter((fact): fact is string => fact !== null);
  const active = template.active_since !== null;
  // Active templates open (that's today's session); idle ones fold to a bar.
  // data-key lets the inline script remember manual folds across refreshes.
  return `<details class="tcard${active ? " is-active" : ""}" data-key="${
    escapeHtml(template.family_id ?? template.id)
  }"${active ? " open" : ""}>
<summary>
<h2>${escapeHtml(template.name)}</h2>
<p class="meta"><span class="status${active ? " is-active" : ""}">${
    active ? '<i class="dot"></i>' : ""
  }${escapeHtml(statusText(template, year))}</span>${
    facts.map((fact) => ` · ${escapeHtml(fact)}`).join("")
  }</p>
<i class="chev" aria-hidden="true"></i>
</summary>
${
    template.notes
      ? `<details class="tnotes"><summary>Programme notes</summary><p>${
        escapeHtml(template.notes)
      }</p></details>`
      : ""
  }
<ol class="items">
${items.map((item, i) => itemHtml(item, template.default_rest_s, i + 1, year)).join("\n")}
</ol>
</details>`;
}

/** `generatedAt` is injected for testability; pass `new Date()` in the handler. */
export function renderGymCard(
  templates: CardTemplate[],
  rehab: CardRehabItem[],
  generatedAt: Date,
): string {
  // Running programmes first — that's what today's session is — then by name.
  const ordered = [...templates].sort((a, b) => {
    const runDiff = Number(b.active_since !== null) - Number(a.active_since !== null);
    return runDiff !== 0 ? runDiff : a.name.localeCompare(b.name);
  });
  const year = generatedAt.getUTCFullYear();
  const body = (ordered.length === 0
    ? `<p class="empty">No active templates. Create one in the desktop app.</p>`
    : ordered.map((t) => templateHtml(t, year)).join("\n")) + rehabSectionHtml(rehab);
  const iso = generatedAt.toISOString();
  const stamp = `Updated ${fmtDay(iso, year)} · ${iso.slice(11, 16)} UTC`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>Alke · Gym card</title>
<style>
/* Tokens from DESIGN.md: true-black canvas, luminance elevation (no shadows),
   hairline dividers, tabular figures, sessions/adherence accent #FB923C.
   System stack on purpose: the page must render whole on gym Wi-Fi. */
:root {
  color-scheme: dark;
  --t1: #fff; --t2: rgba(255,255,255,0.72); --t3: rgba(255,255,255,0.48);
  --t4: rgba(255,255,255,0.30); --card: #16181A; --inset: #0A0A0A;
  --hair: rgba(255,255,255,0.12); --soft: rgba(255,255,255,0.06);
  --acc: #FB923C; --acc-dim: rgba(251,146,60,0.15);
}
* { box-sizing: border-box; margin: 0; }
body {
  background: #000; color: var(--t2);
  font: 400 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  padding: 24px 16px calc(48px + env(safe-area-inset-bottom)); max-width: 560px; margin: 0 auto;
  -webkit-text-size-adjust: 100%;
}
h1 { color: var(--t1); font-size: 22px; font-weight: 650; letter-spacing: -0.3px; }
.generated { color: var(--t3); font-size: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; }
/* Collapsible template cards. The summary is the whole header: name + meta,
   one tap target. It stays pinned while the open card's exercises scroll
   past, so mid-set you always know which day you're looking at. */
.tcard { margin-top: 16px; border-radius: 20px; background: var(--card); }
.tcard.is-active { border: 1px solid var(--hair); }
.tcard > summary {
  list-style: none; display: block; position: sticky; top: 0; z-index: 2;
  background: var(--card); border-radius: 20px; padding: 15px 44px 13px 16px;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
}
.tcard > summary:active { background: #1D2023; }
.tcard > summary::-webkit-details-marker { display: none; }
.tcard[open] > summary { border-radius: 20px 20px 0 0; border-bottom: 1px solid var(--soft); }
h2 { color: var(--t1); font-size: 18px; font-weight: 600; letter-spacing: -0.2px; }
.meta {
  margin-top: 4px; font-size: 12px; color: var(--t3);
  font-variant-numeric: tabular-nums; line-height: 1.6;
}
.status.is-active { color: var(--acc); font-weight: 500; }
.dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 999px;
  background: currentColor; margin-right: 6px; vertical-align: 1px;
}
.tcard > summary .chev {
  position: absolute; right: 19px; top: 25px; width: 8px; height: 8px;
  border-right: 1.5px solid var(--t3); border-bottom: 1.5px solid var(--t3);
  transform: rotate(45deg); transition: transform 150ms ease-out;
}
.tcard[open] > summary .chev { transform: rotate(225deg); top: 29px; }
.tnotes { border-bottom: 1px solid var(--soft); padding: 10px 16px; }
.tnotes summary { font-size: 12px; color: var(--t3); cursor: pointer; }
.tnotes p { font-size: 13px; line-height: 1.55; padding: 8px 0 4px; white-space: pre-wrap; color: var(--t2); }
ol, ul { list-style: none; padding: 0; }
.items > li, .rlist > li {
  display: grid; column-gap: 10px; padding: 12px 16px 13px;
  border-top: 1px solid var(--soft);
}
.items > li:first-child, .rlist > li:first-child { border-top: 0; }
.items > li { grid-template-columns: 20px minmax(0,1fr) auto; grid-template-areas: "idx name dose" ". sub sub"; }
.rlist > li { grid-template-columns: minmax(0,1fr) auto; grid-template-areas: "name dose" "sub sub"; }
.idx {
  grid-area: idx; padding-top: 3.5px; font-size: 11px; font-weight: 500;
  color: var(--t3); font-variant-numeric: tabular-nums;
}
.name {
  grid-area: name; color: var(--t1); font-size: 16px; font-weight: 600;
  letter-spacing: -0.1px; min-width: 0; overflow-wrap: anywhere;
}
.dose {
  grid-area: dose; color: var(--t1); font-size: 16px; font-weight: 600;
  font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap;
  letter-spacing: -0.1px;
}
.dose small { display: block; font-size: 11px; color: var(--t3); font-weight: 400; margin-top: 1px; }
.sub { grid-area: sub; min-width: 0; }
/* The reality line: what was actually lifted, last time this template ran. */
.last { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; min-width: 0; }
.lk {
  font-size: 10px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase;
  color: var(--t3); flex-shrink: 0;
}
.last b {
  font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.85);
  font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere;
}
.when { margin-left: auto; padding-left: 8px; font-size: 11px; color: var(--t3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.wk { margin-left: auto; padding-left: 8px; display: flex; gap: 3px; align-items: center; }
.wk i { width: 6px; height: 6px; border-radius: 2px; background: var(--acc-dim); }
.wk i.on { background: var(--acc); }
.note { margin-top: 6px; font-size: 12.5px; line-height: 1.5; color: var(--t3); white-space: pre-wrap; }
/* Long coaching notes: two-line preview, tap to expand. Script-free. */
.cue { margin-top: 6px; }
.cue summary { list-style: none; cursor: pointer; position: relative; padding-right: 22px; -webkit-tap-highlight-color: transparent; }
.cue summary::-webkit-details-marker { display: none; }
.cue .txt {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; font-size: 12.5px; line-height: 1.5; color: var(--t3);
  white-space: pre-wrap;
}
.cue[open] .txt { display: block; }
.cue .chev {
  position: absolute; right: 4px; top: 5px; width: 7px; height: 7px;
  border-right: 1.5px solid var(--t4); border-bottom: 1.5px solid var(--t4);
  transform: rotate(45deg); transition: transform 150ms ease-out;
}
.cue[open] .chev { transform: rotate(225deg); top: 8px; }
@media (prefers-reduced-motion: reduce) { .cue .chev { transition: none; } }
summary:focus-visible { outline: 1px solid rgba(255,255,255,0.4); outline-offset: 2px; border-radius: 4px; }
.tag {
  display: block; font-size: 11px; font-weight: 400; color: var(--t3);
  margin-top: 2px; letter-spacing: 0; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;
}
.steps { margin-top: 8px; background: var(--inset); border-radius: 12px; }
.steps li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; font-size: 13px; }
.steps li span:first-child { min-width: 0; overflow-wrap: anywhere; }
.steps li + li { border-top: 1px solid var(--soft); }
.steps li span:last-child { color: var(--t2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.empty { margin-top: 24px; color: var(--t3); }
</style>
</head>
<body>
<header class="page">
<h1>Gym card</h1>
<p class="generated">${escapeHtml(stamp)} · pull to refresh</p>
</header>
${body}
<script>
// Progressive enhancement only: remember which cards were folded, because
// pull-to-refresh reloads the page. Inline and network-free by design; with
// JS off the server defaults (active = open) simply apply on every load.
document.querySelectorAll("details.tcard").forEach((d) => {
  const key = "gymcard:" + d.dataset.key;
  try {
    const saved = localStorage.getItem(key);
    if (saved === "1") d.open = true;
    else if (saved === "0") d.open = false;
  } catch {}
  d.addEventListener("toggle", () => {
    try { localStorage.setItem(key, d.open ? "1" : "0"); } catch {}
  });
});
</script>
</body>
</html>`;
}
