import { assert, assertEquals } from "jsr:@std/assert";
import {
  buildLastLogs,
  type CardRehabItem,
  type CardTemplate,
  currentPlanWeek,
  doseText,
  escapeHtml,
  isoWeekStart,
  lastLogText,
  type LoggedSetRow,
  rehabDoseText,
  renderGymCard,
  resolveWeeklyTarget,
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
  const html = renderGymCard([template()], [], NOW);
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
  const html = renderGymCard([idle, running], [], NOW);
  assert(html.indexOf("Z running") < html.indexOf("A idle"));
  // Same-year dates drop the year on the phone card.
  assert(html.includes("Active since Aug 16"));
  assert(!html.includes("Aug 16 2026"));
});

Deno.test("status falls back to last-done, then to not started", () => {
  const done = renderGymCard(
    [template({ last_done: "2026-08-09", done_count: 4 })],
    [],
    NOW,
  );
  assert(done.includes("Last done Aug 9"));
  assert(done.includes("done 4×"));
  assert(renderGymCard([template()], [], NOW).includes("Not started"));
  // A stale template keeps its year.
  assert(
    renderGymCard([template({ last_done: "2025-12-30" })], [], NOW)
      .includes("Last done Dec 30 2025"),
  );
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
    [],
    NOW,
  );
  assert(!html.includes("<img src=x"));
  assert(html.includes("&lt;img src=x"));
  assert(html.includes("a &amp; b &lt; c"));
  assert(html.includes("&lt;b&gt;Press&lt;/b&gt;"));
  assertEquals(escapeHtml('"quoted"'), "&quot;quoted&quot;");
});

Deno.test("an empty template set explains itself instead of a blank page", () => {
  assert(renderGymCard([], [], NOW).includes("No active templates"));
});

Deno.test("active templates start expanded, idle ones start collapsed", () => {
  const html = renderGymCard(
    [
      template({ id: "t1", name: "Idle day" }),
      template({ id: "t2", name: "Running day", active_since: "2026-08-16" }),
    ],
    [rehabItem()],
    NOW,
  );
  assert(html.includes('<details class="tcard is-active" data-key="t2" open>'));
  assert(html.includes('<details class="tcard" data-key="t1">'));
  // Rehab is accountable daily work: collapsible but open by default.
  assert(html.includes('<details class="tcard rehab" data-key="rehab" open>'));
});

// ── last logged sets per (template family, exercise) ────────────────────────

function setRow(overrides: Partial<LoggedSetRow> = {}): LoggedSetRow {
  return {
    session_id: "s1",
    exercise_id: "ex-press",
    position: 1,
    reps: 10,
    weight_kg: 60,
    duration_s: null,
    ...overrides,
  };
}

Deno.test("last-log text compresses uniform weight, lists mixed, handles bodyweight and holds", () => {
  const uniform = {
    date: "2026-08-20",
    sets: [
      { reps: 10, weight_kg: 60, duration_s: null },
      { reps: 10, weight_kg: 60, duration_s: null },
      { reps: 8, weight_kg: 60, duration_s: null },
    ],
  };
  assertEquals(lastLogText(uniform), "60 kg × 10, 10, 8");
  const mixed = {
    date: "2026-08-20",
    sets: [
      { reps: 10, weight_kg: 60, duration_s: null },
      { reps: 8, weight_kg: 65, duration_s: null },
    ],
  };
  assertEquals(lastLogText(mixed), "60kg×10 · 65kg×8");
  // Consecutive same-weight sets fold into one run.
  const dropSet = {
    date: "2026-08-20",
    sets: [
      { reps: 10, weight_kg: 45, duration_s: null },
      { reps: 10, weight_kg: 45, duration_s: null },
      { reps: 10, weight_kg: 40, duration_s: null },
      { reps: 9, weight_kg: 40, duration_s: null },
    ],
  };
  assertEquals(lastLogText(dropSet), "45kg×10,10 · 40kg×10,9");
  const bodyweight = {
    date: "2026-08-20",
    sets: [
      { reps: 12, weight_kg: null, duration_s: null },
      { reps: 11, weight_kg: null, duration_s: null },
    ],
  };
  assertEquals(lastLogText(bodyweight), "12, 11");
  const hold = {
    date: "2026-08-20",
    sets: [
      { reps: null, weight_kg: null, duration_s: 45 },
      { reps: null, weight_kg: null, duration_s: 40 },
    ],
  };
  assertEquals(lastLogText(hold), "45s, 40s");
});

Deno.test("lastLogText: unilateral sets carry ·uni and never merge with bilateral sets at the same weight", () => {
  // Uniform all-unilateral (e.g. a single-arm Seated Cable Row, weight per side).
  const uniform = {
    date: "2026-08-20",
    sets: [
      { reps: 12, weight_kg: 10, duration_s: null, is_unilateral: true },
      { reps: 12, weight_kg: 10, duration_s: null, is_unilateral: true },
      { reps: 12, weight_kg: 10, duration_s: null, is_unilateral: true },
    ],
  };
  assertEquals(lastLogText(uniform), "10 kg × 12, 12, 12 ·uni");
  // A unilateral and a bilateral set at the SAME weight are incomparable loads
  // (agent_log #31) — the flag is part of the grouping identity, so they must
  // stay separate runs instead of folding into "10 kg × 12, 10".
  const sameWeightMixed = {
    date: "2026-08-20",
    sets: [
      { reps: 12, weight_kg: 10, duration_s: null, is_unilateral: true },
      { reps: 10, weight_kg: 10, duration_s: null, is_unilateral: false },
    ],
  };
  assertEquals(lastLogText(sameWeightMixed), "10kg×12·uni · 10kg×10");
});

Deno.test("lastLogText: perHand renders dumbbell/kettlebell weights as kg/hand", () => {
  const uniform = {
    date: "2026-08-20",
    sets: [
      { reps: 10, weight_kg: 14, duration_s: null },
      { reps: 10, weight_kg: 14, duration_s: null },
    ],
  };
  assertEquals(lastLogText(uniform, true), "14 kg/hand × 10, 10");
  const mixed = {
    date: "2026-08-20",
    sets: [
      { reps: 10, weight_kg: 14, duration_s: null },
      { reps: 8, weight_kg: 16, duration_s: null },
    ],
  };
  assertEquals(lastLogText(mixed, true), "14kg/hand×10 · 16kg/hand×8");
});

Deno.test("a session logged under template A never surfaces on template B, even for a shared exercise", () => {
  const familyByVersion = new Map([["tplA", "famA"], ["tplB", "famB"]]);
  const logs = buildLastLogs(
    [{ template_id: "tplA", session_id: "s1", performed_at: "2026-08-20T18:00:00+00:00" }],
    [setRow()],
    familyByVersion,
  );
  assertEquals(logs.get("famA|ex-press")?.date, "2026-08-20");
  assertEquals(logs.get("famB|ex-press"), undefined);
});

Deno.test("the latest linked session wins and its sets keep position order", () => {
  const familyByVersion = new Map([["tplA", "famA"]]);
  const logs = buildLastLogs(
    [
      { template_id: "tplA", session_id: "s-old", performed_at: "2026-08-10T18:00:00+00:00" },
      { template_id: "tplA", session_id: "s-new", performed_at: "2026-08-20T18:00:00+00:00" },
    ],
    [
      setRow({ session_id: "s-old", reps: 8, weight_kg: 55 }),
      setRow({ session_id: "s-new", position: 2, reps: 9 }),
      setRow({ session_id: "s-new", position: 1, reps: 10 }),
    ],
    familyByVersion,
  );
  assertEquals(logs.get("famA|ex-press"), {
    date: "2026-08-20",
    sets: [
      { reps: 10, weight_kg: 60, duration_s: null, is_unilateral: false },
      { reps: 9, weight_kg: 60, duration_s: null, is_unilateral: false },
    ],
  });
});

Deno.test("sessions logged against an older template version still count for the family", () => {
  // tplA-v1 was superseded by tplA-v2; the card shows v2 but history is v1's.
  const familyByVersion = new Map([["tplA-v1", "famA"], ["tplA-v2", "famA"]]);
  const logs = buildLastLogs(
    [{ template_id: "tplA-v1", session_id: "s1", performed_at: "2026-08-20T18:00:00+00:00" }],
    [setRow({ weight_kg: "62.50" })], // numeric may arrive as a string
    familyByVersion,
  );
  assertEquals(logs.get("famA|ex-press")?.sets[0].weight_kg, 62.5);
});

Deno.test("the card renders the last log under its exercise row", () => {
  const withLog = template({
    items: [
      {
        exercise_name: "Leg Press",
        position: 1,
        target_sets: 4,
        target_reps: 10,
        target_duration_seconds: null,
        target_weight_kg: 80,
        rest_after_s: null,
        note: null,
        last_log: {
          date: "2026-08-14",
          sets: [
            { reps: 10, weight_kg: 77.5, duration_s: null },
            { reps: 9, weight_kg: 77.5, duration_s: null },
          ],
        },
      },
    ],
  });
  const html = renderGymCard([withLog], [], NOW);
  assert(html.includes("77.5 kg × 10, 9"));
  assert(html.includes(">Aug 14<")); // same-year date, no year
  assert(html.includes('class="last"'));
  // No log, no line.
  assert(!renderGymCard([template()], [], NOW).includes('class="last"'));
});

Deno.test("long coaching notes collapse to a preview; short ones render whole", () => {
  const long = "Slow 3s lowering, full range, no yanking the weight up. ".repeat(4);
  const html = renderGymCard(
    [
      template({
        items: [
          {
            exercise_name: "RDL",
            position: 1,
            target_sets: 3,
            target_reps: 8,
            target_duration_seconds: null,
            target_weight_kg: null,
            rest_after_s: null,
            note: long,
          },
        ],
      }),
    ],
    [],
    NOW,
  );
  assert(html.includes('<details class="cue">'));
  assert(html.includes("Slow 3s lowering"));
  const short = renderGymCard([template()], [], NOW);
  // template()'s "Control the range." note is short: plain, not collapsible.
  assert(short.includes('<p class="note">Control the range.</p>'));
  assert(!short.includes('class="cue"'));
});

// ── recovery-plan resolution (ports of chatctx/injuries.py) ─────────────────

function rehabItem(overrides: Partial<CardRehabItem> = {}): CardRehabItem {
  return {
    name: "Heel walks",
    injury_name: "Plantar fasciitis",
    weekly_target: 3,
    done_this_week: 1,
    target_sets: 2,
    target_reps: null,
    steps: [
      {
        name: "Heel walks",
        sets: 2,
        reps: null,
        duration_seconds: null,
        distance_m: 20,
        per_side: null,
        note: "walk on heels, toes lifted",
      },
    ],
    ...overrides,
  };
}

Deno.test("plan weeks are 1-based from the start date, 0 before, null legacy", () => {
  assertEquals(currentPlanWeek("2026-07-05", "2026-07-05"), 1);
  assertEquals(currentPlanWeek("2026-07-05", "2026-08-16"), 7);
  assertEquals(currentPlanWeek("2026-07-05", "2026-07-01"), 0);
  assertEquals(currentPlanWeek(null, "2026-08-16"), null);
});

Deno.test("a pending symptom gate never changes the target; an applied one counts from its week", () => {
  const gated = [{
    gate: { max_pain: 1, clear_days: 14 },
    applied_on: null as string | null,
    weekly_target: 3,
    green_min: 2,
    yellow_min: 1,
  }];
  assertEquals(resolveWeeklyTarget(7, gated, 40, "2026-08-05"), 7);
  const applied = [{ ...gated[0], applied_on: "2026-08-16" }];
  // Plan started 2026-07-05 → applied in week 7: week 6 keeps the acute dose.
  assertEquals(resolveWeeklyTarget(4, applied, 6, "2026-07-05"), 4);
  assertEquals(resolveWeeklyTarget(4, applied, 7, "2026-07-05"), 3);
});

Deno.test("calendar phases override from their from_week, last started wins", () => {
  const phases = [
    { from_week: 2, weekly_target: 7, green_min: 6, yellow_min: 4 },
  ];
  assertEquals(resolveWeeklyTarget(3, phases, 1, "2026-08-05"), 3);
  assertEquals(resolveWeeklyTarget(3, phases, 2, "2026-08-05"), 7);
});

Deno.test("iso week starts on Monday", () => {
  assertEquals(isoWeekStart("2026-08-17"), "2026-08-17"); // a Monday
  assertEquals(isoWeekStart("2026-08-16"), "2026-08-10"); // a Sunday
});

Deno.test("a single-step rehab dose renders in its own measure with the item's sets", () => {
  assertEquals(rehabDoseText(rehabItem()), "2 × 20 m");
  const hold = rehabItem({
    target_sets: 3,
    steps: [{
      name: "Wall sit",
      sets: null,
      reps: null,
      duration_seconds: 45,
      distance_m: null,
      per_side: null,
      note: null,
    }],
  });
  assertEquals(rehabDoseText(hold), "3 × 45s");
});

Deno.test("the rehab section shows weekly progress, the injury tag, and multi-step routines", () => {
  const routine = rehabItem({
    name: "Ankle mobility routine",
    weekly_target: 7,
    done_this_week: 0,
    steps: [
      {
        name: "Calf stretch",
        sets: 2,
        reps: null,
        duration_seconds: 30,
        distance_m: null,
        per_side: true,
        note: null,
      },
      {
        name: "Ankle circles",
        sets: null,
        reps: 10,
        duration_seconds: null,
        distance_m: null,
        per_side: true,
        note: null,
      },
    ],
  });
  const html = renderGymCard([template()], [rehabItem(), routine], NOW);
  assert(html.includes("Recovery plan"));
  assert(html.includes("1/3 this week"));
  assert(html.includes("Plantar fasciitis"));
  assert(html.includes("2 movements"));
  assert(html.includes("2 × 30s / side"));
  assert(html.includes("10 reps / side"));
  assert(html.includes("walk on heels, toes lifted"));
});

Deno.test("no rehab items means no recovery section at all", () => {
  assert(!renderGymCard([template()], [], NOW).includes("Recovery plan"));
});
