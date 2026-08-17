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
export function renderGymCard(templates: CardTemplate[], generatedAt: Date): string {
  // Running programmes first — that's what today's session is — then by name.
  const ordered = [...templates].sort((a, b) => {
    const runDiff = Number(b.active_since !== null) - Number(a.active_since !== null);
    return runDiff !== 0 ? runDiff : a.name.localeCompare(b.name);
  });
  const body = ordered.length === 0
    ? `<p class="empty">No active templates. Create one in the desktop app.</p>`
    : ordered.map(templateHtml).join("\n");
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
.name { color: #fff; font-size: 15px; font-weight: 600; }
.dose {
  color: #fff; font-size: 15px; font-variant-numeric: tabular-nums;
  text-align: right; white-space: nowrap; flex-shrink: 0;
}
.dose small { display: block; font-size: 11px; color: rgba(255,255,255,0.48); font-weight: 400; }
.note { margin-top: 6px; font-size: 12.5px; line-height: 1.5; color: rgba(255,255,255,0.48); }
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
