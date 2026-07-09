// Tests for the pure parsing layer. No network, no Deno.env — fixtures only.
import { assertEquals, assertAlmostEquals, assertThrows } from "jsr:@std/assert@1";
import {
  mergeDailyMetric,
  type NormalizedDailyMetric,
  ParseError,
  parseIngestPayload,
} from "./parse.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workoutsExportFixture = {
  data: {
    workouts: [
      {
        id: "9C05B6E5-0000-0000-0000-000000000001",
        name: "Pool Swim",
        start: "2026-07-08 07:05:12 +0200",
        end: "2026-07-08 07:41:44 +0200",
        duration: 36.5, // minutes
        distance: { qty: 1500, units: "m" },
        activeEnergyBurned: { qty: 320, units: "kcal" },
        heartRateData: [
          { date: "2026-07-08 07:05:15 +0200", Avg: 118.0, Min: 100, Max: 130 },
          { date: "2026-07-08 07:06:15 +0200", Avg: 121.4, Min: 110, Max: 135 },
          // duplicate offset (same second as previous +60s -> different offset actually)
        ],
      },
    ],
    metrics: [],
  },
};

const metricsExportFixture = {
  data: {
    workouts: [],
    metrics: [
      {
        name: "resting_heart_rate",
        units: "bpm",
        data: [{ date: "2026-07-08 00:00:00 +0200", qty: 55.2 }],
      },
      {
        name: "step_count",
        units: "count",
        data: [
          { date: "2026-07-08 08:00:00 +0200", qty: 1200 },
          { date: "2026-07-08 14:00:00 +0200", qty: 3400.6 },
        ],
      },
      {
        name: "sleep_analysis",
        units: "hr",
        data: [
          {
            date: "2026-07-08 07:00:00 +0200",
            sleepStart: "2026-07-07 23:10:00 +0200",
            sleepEnd: "2026-07-08 07:00:00 +0200",
            totalSleep: 7.5,
            deep: 1.2,
            core: 4.5,
            rem: 1.5,
            awake: 0.3,
          },
        ],
      },
      {
        name: "some_unknown_future_metric",
        units: "widgets",
        data: [{ date: "2026-07-08 00:00:00 +0200", qty: 42 }],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Workouts export shape
// ---------------------------------------------------------------------------

Deno.test("parses a workouts export with HR data", () => {
  const result = parseIngestPayload(workoutsExportFixture);
  assertEquals(result.workouts.length, 1);
  const w = result.workouts[0];
  assertEquals(w.external_id, "9C05B6E5-0000-0000-0000-000000000001");
  assertEquals(w.type, "pool_swim");
  assertEquals(w.start_at, "2026-07-08T05:05:12.000Z");
  assertEquals(w.end_at, "2026-07-08T05:41:44.000Z");
  // duration inferred from end-start (36min32s = 2192s) since it's close-ish to the flat 36.5min value
  assertEquals(w.duration_s, 2192);
  assertEquals(w.distance_m, 1500);
  assertEquals(w.energy_kcal, 320);
  assertEquals(w.hrSamples.length, 2);
  assertEquals(w.hrSamples[0], { offset_s: 3, bpm: 118 });
  assertEquals(w.hrSamples[1], { offset_s: 63, bpm: 121 });
  assertAlmostEquals(w.avg_hr!, 119.5, 0.1);
  assertEquals(w.max_hr, 121);
});

Deno.test("prefers explicit avgHeartRate/maxHeartRate over sample-derived values", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "summary-hr",
          name: "Run",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
          avgHeartRate: { qty: 142.3, units: "bpm" },
          maxHeartRate: 171, // flat number variant
          heartRateData: [
            { date: "2026-07-08 07:00:10 +0200", Avg: 100 },
            { date: "2026-07-08 07:01:10 +0200", Avg: 110 },
          ],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const w = result.workouts[0];
  assertEquals(w.avg_hr, 142.3);
  assertEquals(w.max_hr, 171);
  // samples still normalized regardless
  assertEquals(w.hrSamples.length, 2);
});

Deno.test("uses summary HR fields when heartRateData is absent (e.g. strength workouts)", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "summary-only",
          name: "Traditional Strength Training",
          start: "2026-07-08 18:00:00 +0200",
          end: "2026-07-08 19:00:00 +0200",
          avgHeartRate: { qty: 98.5, units: "bpm" },
          maxHeartRate: { qty: 130, units: "bpm" },
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const w = result.workouts[0];
  assertEquals(w.avg_hr, 98.5);
  assertEquals(w.max_hr, 130);
  assertEquals(w.hrSamples, []);
});

Deno.test("falls back to sample-derived avg/max when no summary HR fields", () => {
  // The main workouts fixture has no avgHeartRate/maxHeartRate; re-assert
  // the fallback explicitly so the preference logic can't regress it.
  const result = parseIngestPayload(workoutsExportFixture);
  const w = result.workouts[0];
  assertAlmostEquals(w.avg_hr!, 119.5, 0.1);
  assertEquals(w.max_hr, 121);
});

Deno.test("strips bulky HR series keys from raw but keeps everything else", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "raw-strip",
          name: "Run",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
          heartRateData: [{ date: "2026-07-08 07:00:10 +0200", Avg: 100 }],
          heartRateRecovery: [{ date: "2026-07-08 08:00:30 +0200", Avg: 120 }],
          somethingElse: "kept",
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const raw = result.workouts[0].raw;
  assertEquals(raw.heartRateData, undefined);
  assertEquals(raw.heartRateRecovery, undefined);
  assertEquals(raw.somethingElse, "kept");
  assertEquals(raw.id, "raw-strip");
});

Deno.test("keeps unknown workout fields in raw jsonb", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "abc",
          name: "Run",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 07:30:00 +0200",
          somethingWeird: { nested: true },
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].raw.somethingWeird, { nested: true });
});

Deno.test("handles flat numeric fields as well as {qty, units} objects", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "flat-1",
          name: "Cycling",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
          distance: 5000, // flat number, assume meters
          activeEnergyBurned: 400, // flat number
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const w = result.workouts[0];
  assertEquals(w.distance_m, 5000);
  assertEquals(w.energy_kcal, 400);
});

Deno.test("converts distance units: km, mi, yd, m, unknown->m", () => {
  const mk = (units: string, qty: number) => ({
    id: `dist-${units}`,
    name: "Walk",
    start: "2026-07-08 07:00:00 +0200",
    end: "2026-07-08 07:30:00 +0200",
    distance: { qty, units },
  });
  const payload = {
    data: {
      workouts: [
        mk("km", 5),
        mk("mi", 1),
        mk("yd", 100),
        mk("m", 10),
        mk("furlongs", 2), // unknown -> assume meters
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const [km, mi, yd, m, unknown] = result.workouts;
  assertAlmostEquals(km.distance_m!, 5000, 0.001);
  assertAlmostEquals(mi.distance_m!, 1609.344, 0.001);
  assertAlmostEquals(yd.distance_m!, 91.44, 0.001);
  assertEquals(m.distance_m, 10);
  assertEquals(unknown.distance_m, 2);
});

Deno.test("infers duration as minutes when seconds value would be implausibly small and no start/end", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "no-dates",
          name: "Elliptical",
          duration: 30, // no start/end to compare -> treat as minutes -> 1800s
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].duration_s, 1800);
});

Deno.test("drops HR samples before workout start (negative offset)", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "neg-offset",
          name: "Run",
          start: "2026-07-08 07:31:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
          heartRateData: [
            { date: "2026-07-08 07:30:00 +0200", Avg: 90 }, // before start -> dropped
            { date: "2026-07-08 07:31:10 +0200", Avg: 100 },
          ],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].hrSamples.length, 1);
  assertEquals(result.workouts[0].hrSamples[0], { offset_s: 10, bpm: 100 });
});

Deno.test("dedupes HR samples at same offset, last one wins", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "dupe-offset",
          name: "Run",
          start: "2026-07-08 07:31:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
          heartRateData: [
            { date: "2026-07-08 07:31:10 +0200", Avg: 100 },
            { date: "2026-07-08 07:31:10 +0200", Avg: 150 }, // same offset, wins
          ],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].hrSamples.length, 1);
  assertEquals(result.workouts[0].hrSamples[0], { offset_s: 10, bpm: 150 });
});

Deno.test("drops HR samples with no usable value", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "no-value",
          name: "Run",
          start: "2026-07-08 07:31:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
          heartRateData: [
            { date: "2026-07-08 07:31:10 +0200" }, // no Avg/qty
            { date: "2026-07-08 07:31:20 +0200", qty: 105 }, // fallback field
          ],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].hrSamples.length, 1);
  assertEquals(result.workouts[0].hrSamples[0], { offset_s: 20, bpm: 105 });
});

Deno.test("falls back to deterministic external_id when id missing, idempotently", () => {
  const payload = {
    data: {
      workouts: [
        {
          name: "Surfing",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
        },
      ],
    },
  };
  const result1 = parseIngestPayload(payload);
  const result2 = parseIngestPayload(payload);
  assertEquals(result1.workouts[0].external_id, result2.workouts[0].external_id);
  assertEquals(result1.workouts[0].external_id, "surfing-2026-07-08T05:00:00.000Z");
});

Deno.test("normalizes name with mixed case and spaces to lowercase snake_case", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "case-1",
          name: "Traditional Strength Training",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].type, "traditional_strength_training");
});

Deno.test("parses date offset variant with colon (±HH:MM)", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "colon-offset",
          name: "Walk",
          start: "2026-07-08 07:00:00 +02:00",
          end: "2026-07-08 07:30:00 +02:00",
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].start_at, "2026-07-08T05:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Metrics export shape
// ---------------------------------------------------------------------------

Deno.test("parses a metrics export covering sleep, summed steps, and a scalar", () => {
  const result = parseIngestPayload(metricsExportFixture);
  assertEquals(result.dailyMetrics.length, 1);
  const dm = result.dailyMetrics[0];
  assertEquals(dm.date, "2026-07-08");
  assertEquals(dm.resting_hr, 55.2);
  assertEquals(dm.steps, 4601); // 1200 + 3400.6 rounded
  assertEquals(dm.sleep_duration_min, 450); // 7.5h * 60
  assertEquals(dm.sleep_stages, { deep: 1.2, core: 4.5, rem: 1.5, awake: 0.3 });
  assertEquals(dm.sleep_start, "2026-07-07T21:10:00.000Z");
  assertEquals(dm.sleep_end, "2026-07-08T05:00:00.000Z");
});

Deno.test("ignores unknown metric names gracefully without throwing", () => {
  const result = parseIngestPayload(metricsExportFixture);
  // some_unknown_future_metric must not appear on any known column
  const dm = result.dailyMetrics[0];
  assertEquals((dm as unknown as Record<string, unknown>).some_unknown_future_metric, undefined);
});

Deno.test("daily metric date uses the LOCAL date part of the sample timestamp, not UTC", () => {
  // 23:30 +0200 local is still 2026-07-08 local, but 21:30 UTC -> still July 8 UTC too;
  // pick a case where UTC date would differ from local date.
  const payload = {
    data: {
      metrics: [
        {
          name: "resting_heart_rate",
          units: "bpm",
          data: [{ date: "2026-07-08 23:30:00 -0700", qty: 60 }],
        },
      ],
      workouts: [],
    },
  };
  const result = parseIngestPayload(payload);
  // Local date string is 2026-07-08 even though UTC instant is 2026-07-09T06:30:00Z
  assertEquals(result.dailyMetrics[0].date, "2026-07-08");
});

Deno.test("sums active_energy per date across multiple samples", () => {
  const payload = {
    data: {
      metrics: [
        {
          name: "active_energy",
          units: "kcal",
          data: [
            { date: "2026-07-08 08:00:00 +0200", qty: 100.2 },
            { date: "2026-07-08 20:00:00 +0200", qty: 50.3 },
            { date: "2026-07-09 08:00:00 +0200", qty: 10 },
          ],
        },
      ],
      workouts: [],
    },
  };
  const result = parseIngestPayload(payload);
  const byDate = Object.fromEntries(
    result.dailyMetrics.map((d: NormalizedDailyMetric) => [d.date, d]),
  );
  assertAlmostEquals(byDate["2026-07-08"].active_energy_kcal!, 150.5, 0.001);
  assertEquals(byDate["2026-07-09"].active_energy_kcal, 10);
});

Deno.test("maps vo2_max, hrv, respiratory_rate, wrist temp metrics", () => {
  const payload = {
    data: {
      metrics: [
        { name: "vo2_max", units: "ml/kg/min", data: [{ date: "2026-07-08 00:00:00 +0200", qty: 45.1 }] },
        { name: "heart_rate_variability", units: "ms", data: [{ date: "2026-07-08 00:00:00 +0200", qty: 62.3 }] },
        { name: "respiratory_rate", units: "count/min", data: [{ date: "2026-07-08 00:00:00 +0200", qty: 14.5 }] },
        { name: "apple_sleeping_wrist_temperature", units: "degC", data: [{ date: "2026-07-08 00:00:00 +0200", qty: 0.3 }] },
      ],
      workouts: [],
    },
  };
  const result = parseIngestPayload(payload);
  const dm = result.dailyMetrics[0];
  assertEquals(dm.vo2max, 45.1);
  assertEquals(dm.hrv_sdnn_ms, 62.3);
  assertEquals(dm.respiratory_rate, 14.5);
  assertEquals(dm.wrist_temp_deviation_c, 0.3);
});

Deno.test("maps state_of_mind metric into jsonb", () => {
  const payload = {
    data: {
      metrics: [
        {
          name: "state_of_mind",
          units: "",
          data: [{ date: "2026-07-08 00:00:00 +0200", valence: 0.5, labels: ["happy"] }],
        },
      ],
      workouts: [],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.dailyMetrics[0].state_of_mind, { valence: 0.5, labels: ["happy"] });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("empty payload produces empty arrays, no throw", () => {
  const result = parseIngestPayload({ data: {} });
  assertEquals(result.workouts, []);
  assertEquals(result.dailyMetrics, []);
});

Deno.test("missing data key throws a ParseError", () => {
  assertThrows(() => parseIngestPayload({}), ParseError);
});

Deno.test("non-object payload throws a ParseError", () => {
  assertThrows(() => parseIngestPayload(null), ParseError);
  assertThrows(() => parseIngestPayload("garbage"), ParseError);
});

Deno.test("missing fields on a workout become null rather than throwing", () => {
  const payload = { data: { workouts: [{ id: "bare-1" }] } };
  const result = parseIngestPayload(payload);
  const w = result.workouts[0];
  assertEquals(w.start_at, null);
  assertEquals(w.end_at, null);
  assertEquals(w.duration_s, null);
  assertEquals(w.distance_m, null);
  assertEquals(w.energy_kcal, null);
  assertEquals(w.avg_hr, null);
  assertEquals(w.max_hr, null);
  assertEquals(w.hrSamples, []);
});

// ---------------------------------------------------------------------------
// mergeDailyMetric — pure per-column merge, null never clobbers
// ---------------------------------------------------------------------------

Deno.test("mergeDailyMetric: incoming non-null overwrites existing", () => {
  const existing = { date: "2026-07-08", resting_hr: 50, steps: null };
  const incoming = { date: "2026-07-08", resting_hr: 55, steps: 1000 };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.resting_hr, 55);
  assertEquals(merged.steps, 1000);
});

Deno.test("mergeDailyMetric: incoming null never clobbers existing value", () => {
  const existing = { date: "2026-07-08", resting_hr: 50, hrv_sdnn_ms: 60 };
  const incoming = { date: "2026-07-08", resting_hr: null, hrv_sdnn_ms: undefined };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.resting_hr, 50);
  assertEquals(merged.hrv_sdnn_ms, 60);
});

Deno.test("mergeDailyMetric: null existing + null incoming stays null", () => {
  const existing = { date: "2026-07-08", vo2max: null };
  const incoming = { date: "2026-07-08", vo2max: null };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.vo2max, null);
});

Deno.test("mergeDailyMetric: no existing row -> incoming values pass through", () => {
  const incoming = { date: "2026-07-08", resting_hr: 52, steps: null };
  const merged = mergeDailyMetric(null, incoming);
  assertEquals(merged.resting_hr, 52);
  assertEquals(merged.steps, null);
});
