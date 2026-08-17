import { assert, assertEquals } from "jsr:@std/assert";
import {
  type CardTemplate,
  doseText,
  escapeHtml,
  renderGymCard,
  restText,
} from "./render.ts";

const NOW = new Date("2026-08-17T12:00:00Z");

function template(overrides: Partial<CardTemplate> = {}): CardTemplate {
  return {
    id: "t1",
    name: "Template A - Lower + Push",
    version: 1,
    notes: null,
    default_rest_s: 90,
    active_since: null,
    last_done: null,
    done_count: 0,
    items: [
      {
        exercise_name: "Leg Press",
        position: 1,
        target_sets: 4,
        target_reps: 10,
        target_duration_seconds: null,
        target_weight_kg: 80,
        rest_after_s: null,
        note: "Control the range.",
      },
      {
        exercise_name: "Wall Sit",
        position: 2,
        target_sets: 3,
        target_reps: null,
        target_duration_seconds: 45,
        target_weight_kg: null,
        rest_after_s: 60,
        note: null,
      },
    ],
    ...overrides,
  };
}

Deno.test("a timed hold renders as seconds, never as reps", () => {
  assertEquals(
    doseText({
      exercise_name: "Wall Sit",
      position: 1,
      target_sets: 3,
      target_reps: null,
      target_duration_seconds: 45,
      target_weight_kg: null,
      rest_after_s: null,
      note: null,
    }),
    "3 × 45s",
  );
});

Deno.test("rest renders as m:ss above a minute and seconds below", () => {
  assertEquals(restText(90), "1:30");
  assertEquals(restText(60), "1:00");
  assertEquals(restText(45), "45s");
});

Deno.test("the card carries names, doses, weight, and per-item rest overrides", () => {
  const html = renderGymCard([template()], NOW);
  assert(html.includes("Template A - Lower + Push"));
  assert(html.includes("Leg Press"));
  assert(html.includes("4 × 10"));
  assert(html.includes("80 kg"));
  assert(html.includes("3 × 45s"));
  // Override rest surfaces on its item; the template default lives in a chip.
  assert(html.includes("rest 1:00"));
  assert(html.includes("rest 1:30"));
  assert(html.includes("Control the range."));
});

Deno.test("running templates sort before idle ones and read as active", () => {
  const idle = template({ id: "t1", name: "A idle" });
  const running = template({
    id: "t2",
    name: "Z running",
    active_since: "2026-08-16",
  });
  const html = renderGymCard([idle, running], NOW);
  assert(html.indexOf("Z running") < html.indexOf("A idle"));
  assert(html.includes("Active since Aug 16 2026"));
});

Deno.test("status falls back to last-done, then to not started", () => {
  const done = renderGymCard(
    [template({ last_done: "2026-08-09", done_count: 4 })],
    NOW,
  );
  assert(done.includes("Last done Aug 9 2026"));
  assert(done.includes("done 4×"));
  assert(renderGymCard([template()], NOW).includes("Not started"));
});

Deno.test("template and item text is HTML-escaped", () => {
  const html = renderGymCard(
    [
      template({
        name: '<img src=x onerror=alert(1)>',
        notes: "a & b < c",
        items: [
          {
            exercise_name: "<b>Press</b>",
            position: 1,
            target_sets: 3,
            target_reps: 10,
            target_duration_seconds: null,
            target_weight_kg: null,
            rest_after_s: null,
            note: null,
          },
        ],
      }),
    ],
    NOW,
  );
  assert(!html.includes("<img src=x"));
  assert(html.includes("&lt;img src=x"));
  assert(html.includes("a &amp; b &lt; c"));
  assert(html.includes("&lt;b&gt;Press&lt;/b&gt;"));
  assertEquals(escapeHtml('"quoted"'), "&quot;quoted&quot;");
});

Deno.test("an empty template set explains itself instead of a blank page", () => {
  assert(renderGymCard([], NOW).includes("No active templates"));
});
