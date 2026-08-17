// Pure HTML renderer for the phone gym card — no I/O, unit tested.
//
// The card is the answer to one question, asked between sets on a phone:
// "what do I do next?" So exercise name and dose lead every row, technique
// notes stay attached but recede, and the whole page is a single static HTML
// document with inline styles — no scripts, no external assets, nothing to
// fail on gym Wi-Fi. Dark like the desktop app; system font stack because
// the page must be self-contained.

export interface CardTemplateItem {
  exercise_name: string;
  position: number;
  target_sets: number | null;
  target_reps: number | null;
  target_duration_seconds: number | null;
  target_weight_kg: number | null;
  rest_after_s: number | null;
  note: string | null;
}

export interface CardTemplate {
  id: string;
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

function rehabItemHtml(item: CardRehabItem): string {
  const steps = item.steps ?? [];
  const week = item.weekly_target != null
    ? `${item.done_this_week}/${item.weekly_target} this week`
    : null;
  return `<li>
<div class="row">
<span class="name">${escapeHtml(item.name)}<small class="tag">${escapeHtml(item.injury_name)}</small></span>
<span class="dose">${escapeHtml(rehabDoseText(item))}${
    week ? `<small>${escapeHtml(week)}</small>` : ""
  }</span>
</div>
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
${steps.length === 1 && steps[0].note ? `<p class="note">${escapeHtml(steps[0].note)}</p>` : ""}
</li>`;
}

function rehabSectionHtml(items: CardRehabItem[]): string {
  if (items.length === 0) return "";
  return `<section>
<header>
<h2>Recovery plan</h2>
<p class="status">Accountable rehab, current-week dose in force</p>
</header>
<ol>
${items.map(rehabItemHtml).join("\n")}
</ol>
</section>`;
}

function fmtDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${MONTHS[(m ?? 1) - 1]} ${d} ${y}`;
}

function statusText(template: CardTemplate): string {
  if (template.active_since) return `Active since ${fmtDay(template.active_since)}`;
  if (template.last_done) return `Last done ${fmtDay(template.last_done)}`;
  return "Not started";
}

function itemHtml(item: CardTemplateItem, defaultRest: number | null): string {
  const rest = item.rest_after_s ?? defaultRest;
  const meta: string[] = [];
  if (item.target_weight_kg != null) meta.push(`${item.target_weight_kg} kg`);
  if (item.rest_after_s != null && rest != null) meta.push(`rest ${restText(rest)}`);
  return `<li>
<div class="row">
<span class="name">${escapeHtml(item.exercise_name)}</span>
<span class="dose">${escapeHtml(doseText(item))}${
    meta.length ? `<small>${escapeHtml(meta.join(" · "))}</small>` : ""
  }</span>
</div>
${item.note ? `<p class="note">${escapeHtml(item.note)}</p>` : ""}
</li>`;
}

function templateHtml(template: CardTemplate): string {
  const items = [...template.items].sort((a, b) => a.position - b.position);
  const chips = [
    template.version > 1 ? `v${template.version}` : null,
    `${items.length} exercise${items.length === 1 ? "" : "s"}`,
    template.default_rest_s != null ? `rest ${restText(template.default_rest_s)}` : null,
    template.done_count > 0 ? `done ${template.done_count}×` : null,
  ].filter((chip): chip is string => chip !== null);
  return `<section>
<header>
<h2>${escapeHtml(template.name)}</h2>
<p class="status${template.active_since ? " is-active" : ""}">${escapeHtml(statusText(template))}</p>
<p class="chips">${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}</p>
</header>
${
    template.notes
      ? `<details><summary>Programme notes</summary><p>${escapeHtml(template.notes)}</p></details>`
      : ""
  }
<ol>
${items.map((item) => itemHtml(item, template.default_rest_s)).join("\n")}
</ol>
</section>`;
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
  const body = (ordered.length === 0
    ? `<p class="empty">No active templates. Create one in the desktop app.</p>`
    : ordered.map(templateHtml).join("\n")) + rehabSectionHtml(rehab);
  const stamp = generatedAt.toISOString().slice(0, 16).replace("T", " ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#000000">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>Alke · Gym card</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body {
  background: #000; color: rgba(255,255,255,0.72);
  font: 400 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  padding: 20px 16px 48px; max-width: 560px; margin: 0 auto;
}
h1 { color: #fff; font-size: 20px; font-weight: 600; letter-spacing: -0.2px; }
.generated { color: rgba(255,255,255,0.48); font-size: 12px; margin-top: 2px; }
section {
  margin-top: 24px; border: 1px solid rgba(255,255,255,0.12);
  border-radius: 16px; background: #0a0a0a; overflow: hidden;
}
section > header { padding: 16px 16px 12px; }
h2 { color: #fff; font-size: 17px; font-weight: 600; }
.status { font-size: 12px; color: rgba(255,255,255,0.48); margin-top: 3px; }
.status.is-active { color: #a5b4fc; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chips span {
  font-size: 11px; padding: 3px 9px; border-radius: 999px;
  background: #16181a; color: rgba(255,255,255,0.72);
  font-variant-numeric: tabular-nums;
}
details { border-top: 1px solid rgba(255,255,255,0.06); padding: 10px 16px; }
summary { font-size: 12px; color: rgba(255,255,255,0.48); cursor: pointer; }
details p { font-size: 13px; line-height: 1.55; padding: 8px 0 4px; white-space: pre-wrap; }
ol { list-style: none; padding: 0; }
li { padding: 12px 16px; border-top: 1px solid rgba(255,255,255,0.06); }
.row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
/* min-width: 0 lets long names shrink and wrap instead of pushing the nowrap
   dose column past a phone viewport (flex min-width:auto refuses to shrink). */
.name { color: #fff; font-size: 15px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.dose {
  color: #fff; font-size: 15px; font-variant-numeric: tabular-nums;
  text-align: right; white-space: nowrap; flex-shrink: 0;
}
.dose small { display: block; font-size: 11px; color: rgba(255,255,255,0.48); font-weight: 400; }
.note { margin-top: 6px; font-size: 12.5px; line-height: 1.5; color: rgba(255,255,255,0.48); }
.tag { display: block; font-size: 11px; font-weight: 400; color: rgba(255,255,255,0.48); margin-top: 1px; }
.steps { list-style: none; padding: 0; margin-top: 8px; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
.steps li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 10px; font-size: 13px; }
.steps li span:first-child { min-width: 0; overflow-wrap: anywhere; }
.steps li + li { border-top: 1px solid rgba(255,255,255,0.06); }
.steps li span:last-child { color: rgba(255,255,255,0.72); font-variant-numeric: tabular-nums; white-space: nowrap; }
.empty { margin-top: 24px; color: rgba(255,255,255,0.48); }
</style>
</head>
<body>
<h1>Gym card</h1>
<p class="generated">As of ${escapeHtml(stamp)} UTC · pull to refresh</p>
${body}
</body>
</html>`;
}
