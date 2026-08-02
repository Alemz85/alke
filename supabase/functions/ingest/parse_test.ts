// Tests for the pure parsing layer. No network, no Deno.env — fixtures only.
import {
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  downsampleRoute,
  mergeDailyMetric,
  type NormalizedDailyMetric,
  type NormalizedWorkout,
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

Deno.test("strips top-level arrays with more than 50 elements from raw, recording counts in _stripped", () => {
  const bulky = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      qty: i,
      date: "2026-07-08 07:00:00 +0200",
      units: "m",
      source: "Watch",
    }));
  const payload = {
    data: {
      workouts: [
        {
          id: "bulk-strip",
          name: "Pool Swim",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
          swimDistance: bulky(60),
          activeEnergy: bulky(55),
          stepCount: bulky(51),
          shortSeries: bulky(3), // <=50: kept
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const raw = result.workouts[0].raw;
  assertEquals(raw.swimDistance, undefined);
  assertEquals(raw.activeEnergy, undefined);
  assertEquals(raw.stepCount, undefined);
  assertEquals(Array.isArray(raw.shortSeries), true);
  assertEquals(raw._stripped, {
    swimDistance: 60,
    activeEnergy: 55,
    stepCount: 51,
  });
});

Deno.test("keeps short arrays (50 or fewer elements) in raw with no _stripped key", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "short-arrays",
          name: "Walk",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 07:30:00 +0200",
          elevation: Array.from({ length: 50 }, (_, i) => ({ qty: i })), // exactly 50: kept
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const raw = result.workouts[0].raw;
  assertEquals(Array.isArray(raw.elevation), true);
  assertEquals((raw.elevation as unknown[]).length, 50);
  assertEquals(raw._stripped, undefined);
});

Deno.test("extracts _route_start from first route point and strips route even when short", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "route-1",
          name: "Outdoor Walk",
          start: "2026-07-08 08:52:00 +0200",
          end: "2026-07-08 09:52:00 +0200",
          route: [
            {
              latitude: 43.2965,
              longitude: -2.9876,
              altitude: 12.4,
              timestamp: "2026-07-08 08:52:48 +0200",
              speed: 1.3,
              course: 180.2,
              horizontalAccuracy: 3.1,
            },
            {
              latitude: 43.2966,
              longitude: -2.9877,
              timestamp: "2026-07-08 08:52:49 +0200",
            },
          ],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const raw = result.workouts[0].raw;
  assertEquals(raw.route, undefined);
  assertEquals(raw._route_start, {
    latitude: 43.2965,
    longitude: -2.9876,
    timestamp: "2026-07-08 08:52:48 +0200",
  });
});

Deno.test("no _route_start key when route is absent", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "no-route",
          name: "Pool Swim",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const raw = result.workouts[0].raw;
  assertEquals("_route_start" in raw, false);
});

Deno.test("_route_start is null-tolerant when the first route point is malformed", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "route-malformed",
          name: "Outdoor Walk",
          start: "2026-07-08 08:52:00 +0200",
          end: "2026-07-08 09:52:00 +0200",
          route: [{ altitude: 5 }], // no lat/lon/timestamp
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const raw = result.workouts[0].raw;
  assertEquals(raw.route, undefined);
  assertEquals(raw._route_start, {
    latitude: null,
    longitude: null,
    timestamp: null,
  });
});

Deno.test("explicit HR strips are also recorded in _stripped", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "explicit-strip-count",
          name: "Run",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
          heartRateData: [
            { date: "2026-07-08 07:00:10 +0200", Avg: 100 },
            { date: "2026-07-08 07:01:10 +0200", Avg: 110 },
          ],
          heartRateRecovery: [{ date: "2026-07-08 08:00:30 +0200", Avg: 120 }],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const raw = result.workouts[0].raw;
  assertEquals(raw.heartRateData, undefined);
  assertEquals(raw.heartRateRecovery, undefined);
  assertEquals(raw._stripped, { heartRateData: 2, heartRateRecovery: 1 });
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

Deno.test("converts workout energy units: kJ->kcal, kcal/unknown pass through", () => {
  const mk = (id: string, activeEnergyBurned: unknown) => ({
    id,
    name: "Cycling",
    start: "2026-07-08 07:00:00 +0200",
    end: "2026-07-08 08:00:00 +0200",
    activeEnergyBurned,
  });
  const payload = {
    data: {
      workouts: [
        mk("e-kj", { qty: 764.056, units: "kJ" }),
        mk("e-kcal", { qty: 320, units: "kcal" }),
        mk("e-unknown", { qty: 250, units: "widgets" }),
      ],
    },
  };
  const byId = Object.fromEntries(
    parseIngestPayload(payload).workouts.map((w: NormalizedWorkout) => [
      w.external_id,
      w,
    ]),
  );
  assertAlmostEquals(byId["e-kj"].energy_kcal!, 764.056 / 4.184, 0.001);
  assertEquals(byId["e-kcal"].energy_kcal, 320);
  assertEquals(byId["e-unknown"].energy_kcal, 250);
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

Deno.test("infers duration-only (no start/end) as SECONDS, matching real HAE payloads", () => {
  // Real payloads have shown bare `duration` values (e.g. 1869.8, 3736.8)
  // matching end-start exactly when both were also present -- i.e. duration
  // is in seconds in this HAE version, not minutes.
  const payload = {
    data: {
      workouts: [
        {
          id: "no-end",
          name: "Elliptical",
          start: "2026-07-08 07:00:00 +0200", // start required (NOT NULL guard); no end -> bare duration
          duration: 1869.8, // seconds, rounded
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].duration_s, 1870);
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
  assertEquals(
    result1.workouts[0].external_id,
    result2.workouts[0].external_id,
  );
  assertEquals(
    result1.workouts[0].external_id,
    "surfing-2026-07-08T05:00:00.000Z",
  );
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
  assertEquals(dm.sleep_stages, {
    deep: 1.2,
    core: 4.5,
    rem: 1.5,
    awake: 0.3,
    _sleep_end_timezone_offset_min: 120,
  });
  assertEquals(dm.sleep_start, "2026-07-07T21:10:00.000Z");
  assertEquals(dm.sleep_end, "2026-07-08T05:00:00.000Z");
});

Deno.test("preserves a negative sleep-end timezone offset without sleep stages", () => {
  const result = parseIngestPayload({
    data: {
      workouts: [],
      metrics: [{
        name: "sleep_analysis",
        units: "hr",
        data: [{
          date: "2026-07-08 07:00:00 -0430",
          sleepStart: "2026-07-07 23:10:00 -0430",
          sleepEnd: "2026-07-08 07:00:00 -0430",
          totalSleep: 7.5,
        }],
      }],
    },
  });

  assertEquals(result.dailyMetrics[0].sleep_stages, {
    _sleep_end_timezone_offset_min: -270,
  });
});

Deno.test("ignores unknown metric names gracefully without throwing", () => {
  const result = parseIngestPayload(metricsExportFixture);
  // some_unknown_future_metric must not appear on any known column
  const dm = result.dailyMetrics[0];
  assertEquals(
    (dm as unknown as Record<string, unknown>).some_unknown_future_metric,
    undefined,
  );
});

Deno.test("maps walking_running_distance (km->m, summed per date) and flights_climbed (summed, integer)", () => {
  const payload = {
    data: {
      workouts: [],
      metrics: [
        {
          name: "walking_running_distance",
          units: "km",
          data: [
            { date: "2026-07-08 08:00:00 +0200", qty: 5.2 },
            { date: "2026-07-08 18:00:00 +0200", qty: 0.975 },
          ],
        },
        {
          name: "flights_climbed",
          units: "count",
          data: [
            { date: "2026-07-08 08:00:00 +0200", qty: 8 },
            { date: "2026-07-08 18:00:00 +0200", qty: 2 },
          ],
        },
        // Include one known metric so a dailyMetrics row actually exists to
        // inspect (an all-unknown payload would produce zero rows).
        {
          name: "resting_heart_rate",
          units: "bpm",
          data: [{ date: "2026-07-08 00:00:00 +0200", qty: 54 }],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.dailyMetrics.length, 1);
  const dm = result.dailyMetrics[0];
  // (5.2 + 0.975) km * 1000 -> meters, summed across the two same-date entries.
  assertAlmostEquals(dm.walking_running_distance_m!, 6175, 0.0001);
  assertEquals(dm.flights_climbed, 10); // 8 + 2, summed and rounded to an integer
  // The known metric alongside them still parses normally.
  assertEquals(dm.resting_hr, 54);
});

Deno.test("walking_running_distance defaults to meters (unitless/unknown units assumed meters)", () => {
  const payload = {
    data: {
      workouts: [],
      metrics: [
        {
          name: "walking_running_distance",
          units: "m",
          data: [{ date: "2026-07-09 08:00:00 +0200", qty: 850 }],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.dailyMetrics[0].walking_running_distance_m, 850);
});

Deno.test("documents current behavior: daily heart_rate metric's Avg/Min/Max shape (no qty) is ignored, not null-poisoned", () => {
  // The daily `heart_rate` metric (distinct from resting_heart_rate) arrives
  // shaped like { Avg, Min, Max } per entry with no `qty` field -- the same
  // shape workout-level heartRateData samples use. heart_rate has no
  // FIELD_MAP.metricNameToColumn entry, so today it's skipped by the
  // `if (!column) continue` unknown-metric-name path before qty is even
  // read; this test locks in that it produces no row/column at all rather
  // than a row with a null value from a failed qty read.
  const payload = {
    data: {
      workouts: [],
      metrics: [
        {
          name: "heart_rate",
          units: "bpm",
          data: [
            { date: "2026-07-08 09:00:00 +0200", Avg: 72.5, Min: 60, Max: 110 },
          ],
        },
        {
          name: "resting_heart_rate",
          units: "bpm",
          data: [{ date: "2026-07-08 00:00:00 +0200", qty: 54 }],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.dailyMetrics.length, 1);
  const dm = result.dailyMetrics[0] as unknown as Record<string, unknown>;
  assertEquals(dm.heart_rate, undefined);
  assertEquals(dm.resting_hr, 54);
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

Deno.test("converts active_energy from kJ to kcal (HAE's real unit)", () => {
  const payload = {
    data: {
      metrics: [
        {
          name: "active_energy",
          units: "kJ",
          data: [
            { date: "2026-07-13 08:00:00 +0200", qty: 2000 },
            { date: "2026-07-13 20:00:00 +0200", qty: 953.123 },
          ],
        },
      ],
      workouts: [],
    },
  };
  const result = parseIngestPayload(payload);
  // 2953.123 kJ / 4.184 = 705.8 kcal — the plausible daily figure, not the
  // raw kJ number that agent_log #8 flagged as implausible.
  assertAlmostEquals(
    result.dailyMetrics[0].active_energy_kcal!,
    2953.123 / 4.184,
    0.001,
  );
});

Deno.test("maps vo2_max, hrv, respiratory_rate, wrist temp metrics", () => {
  const payload = {
    data: {
      metrics: [
        {
          name: "vo2_max",
          units: "ml/kg/min",
          data: [{ date: "2026-07-08 00:00:00 +0200", qty: 45.1 }],
        },
        {
          name: "heart_rate_variability",
          units: "ms",
          data: [{ date: "2026-07-08 00:00:00 +0200", qty: 62.3 }],
        },
        {
          name: "respiratory_rate",
          units: "count/min",
          data: [{ date: "2026-07-08 00:00:00 +0200", qty: 14.5 }],
        },
        {
          name: "apple_sleeping_wrist_temperature",
          units: "degC",
          data: [{ date: "2026-07-08 00:00:00 +0200", qty: 0.3 }],
        },
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

Deno.test("maps weight_body_mass in kg as a scalar (last value per date wins)", () => {
  const payload = {
    data: {
      metrics: [
        {
          name: "weight_body_mass",
          units: "kg",
          data: [
            { date: "2026-07-08 07:00:00 +0200", qty: 78.4 },
            { date: "2026-07-08 20:00:00 +0200", qty: 78.9 },
          ],
        },
      ],
      workouts: [],
    },
  };
  const result = parseIngestPayload(payload);
  const dm = result.dailyMetrics[0];
  assertEquals(dm.weight_kg, 78.9); // last-wins, NOT summed
});

Deno.test("converts weight_body_mass from lb to kg when units say lb", () => {
  const payload = {
    data: {
      metrics: [
        {
          name: "weight_body_mass",
          units: "lb",
          data: [{ date: "2026-07-08 07:00:00 +0200", qty: 172.84 }],
        },
      ],
      workouts: [],
    },
  };
  const result = parseIngestPayload(payload);
  const dm = result.dailyMetrics[0];
  assertAlmostEquals(dm.weight_kg!, 172.84 * 0.45359237, 0.0001);
});

Deno.test("state_of_mind metric name is unmapped (column dropped) and ignored gracefully", () => {
  // state_of_mind never received a single value across ingest history and had
  // no reader anywhere in the app; the daily_metrics column was dropped
  // (migration 20260716120100_drop_state_of_mind.sql). It's no longer in
  // FIELD_MAP.metricNameToColumn, so it now falls into the generic
  // unknown-metric-name path -- this locks in that receiving it doesn't 500
  // the batch (writing to a dropped column would).
  const payload = {
    data: {
      metrics: [
        {
          name: "state_of_mind",
          units: "",
          data: [{
            date: "2026-07-08 00:00:00 +0200",
            valence: 0.5,
            labels: ["happy"],
          }],
        },
        {
          name: "resting_heart_rate",
          units: "bpm",
          data: [{ date: "2026-07-08 00:00:00 +0200", qty: 54 }],
        },
      ],
      workouts: [],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.dailyMetrics.length, 1);
  const dm = result.dailyMetrics[0] as unknown as Record<string, unknown>;
  assertEquals(dm.state_of_mind, undefined);
  assertEquals(dm.resting_hr, 54);
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
  // A workout with no type/start at all is dropped (NOT NULL guard), never
  // thrown on — the minimal keepable workout carries name + start and nulls
  // everywhere else.
  const bare = parseIngestPayload({ data: { workouts: [{ id: "bare-1" }] } });
  assertEquals(bare.workouts, []);

  const payload = {
    data: { workouts: [{ id: "bare-2", name: "Run", start: "2026-07-08 07:00:00 +0200" }] },
  };
  const w = parseIngestPayload(payload).workouts[0];
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
  const incoming = {
    date: "2026-07-08",
    resting_hr: null,
    hrv_sdnn_ms: undefined,
  };
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

Deno.test("mergeDailyMetric: walking_running_distance_m and flights_climbed merge like steps (incoming replaces, null never clobbers)", () => {
  // These columns are already-summed-per-date totals by the time they reach
  // mergeDailyMetric (summing across metric entries happens in parseMetrics
  // per payload); the merge step itself does whole-value replace-if-non-null,
  // identical to steps -- it does NOT add across re-deliveries.
  const existing = {
    date: "2026-07-08",
    walking_running_distance_m: 6175,
    flights_climbed: 10,
  };
  const incoming = {
    date: "2026-07-08",
    walking_running_distance_m: 7000,
    flights_climbed: 12,
  };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.walking_running_distance_m, 7000);
  assertEquals(merged.flights_climbed, 12);

  // A re-delivery with nulls (e.g. a payload that doesn't cover this date's
  // activity data at all) must not clobber the stored totals.
  const incomingNull = {
    date: "2026-07-08",
    walking_running_distance_m: null,
    flights_climbed: null,
  };
  const mergedAgain = mergeDailyMetric(merged, incomingNull);
  assertEquals(mergedAgain.walking_running_distance_m, 7000);
  assertEquals(mergedAgain.flights_climbed, 12);
});

// ---------------------------------------------------------------------------
// mergeDailyMetric — sleep is a group, and a shorter re-export of the same
// night must not clobber a more complete one already stored (HAE incremental
// syncs re-send shrinking aggregates of the same night).
// ---------------------------------------------------------------------------

const FULL_NIGHT = {
  sleep_start: "2026-07-10T00:30:00+00:00",
  sleep_end: "2026-07-10T07:00:00+00:00",
  sleep_duration_min: 365.5,
  sleep_stages: { rem: 1.8, core: 3.9, deep: 0.4, awake: 0.3 },
};

const SHRUNK_NIGHT = {
  sleep_start: "2026-07-10T02:30:00+00:00",
  sleep_end: "2026-07-10T07:00:00+00:00",
  sleep_duration_min: 250.5,
  sleep_stages: { rem: 1.4, core: 2.6, deep: 0.2, awake: 0.3 },
};

Deno.test("mergeDailyMetric: shorter incoming sleep never clobbers a longer stored night", () => {
  const existing = { date: "2026-07-10", ...FULL_NIGHT };
  const incoming = { date: "2026-07-10", ...SHRUNK_NIGHT, steps: 4200 };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.sleep_start, FULL_NIGHT.sleep_start);
  assertEquals(merged.sleep_end, FULL_NIGHT.sleep_end);
  assertEquals(merged.sleep_duration_min, FULL_NIGHT.sleep_duration_min);
  assertEquals(merged.sleep_stages, FULL_NIGHT.sleep_stages);
  // non-sleep columns still merge normally
  assertEquals(merged.steps, 4200);
});

Deno.test("mergeDailyMetric: longer incoming sleep replaces the whole sleep group", () => {
  const existing = { date: "2026-07-10", ...SHRUNK_NIGHT };
  const incoming = { date: "2026-07-10", ...FULL_NIGHT };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.sleep_start, FULL_NIGHT.sleep_start);
  assertEquals(merged.sleep_duration_min, FULL_NIGHT.sleep_duration_min);
  assertEquals(merged.sleep_stages, FULL_NIGHT.sleep_stages);
});

Deno.test("mergeDailyMetric: incoming sleep fills a row that has none", () => {
  const existing = { date: "2026-07-10", resting_hr: 50 };
  const incoming = { date: "2026-07-10", ...SHRUNK_NIGHT };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.sleep_duration_min, SHRUNK_NIGHT.sleep_duration_min);
  assertEquals(merged.sleep_start, SHRUNK_NIGHT.sleep_start);
  assertEquals(merged.resting_hr, 50);
});

Deno.test("mergeDailyMetric: sleep group is not mixed across exports", () => {
  // Incoming has start/end but no duration: with a stored night present we
  // keep the stored group wholesale rather than splicing fields together.
  const existing = { date: "2026-07-10", ...FULL_NIGHT };
  const incoming = {
    date: "2026-07-10",
    sleep_start: "2026-07-10T05:00:00+00:00",
    sleep_end: "2026-07-10T07:00:00+00:00",
    sleep_duration_min: null,
    sleep_stages: null,
  };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.sleep_start, FULL_NIGHT.sleep_start);
  assertEquals(merged.sleep_end, FULL_NIGHT.sleep_end);
  assertEquals(merged.sleep_duration_min, FULL_NIGHT.sleep_duration_min);
});

Deno.test("mergeDailyMetric: equal-duration incoming sleep refreshes the group", () => {
  // Same length, later export — adopt it (stage breakdown may be refined).
  const refreshed = {
    ...FULL_NIGHT,
    sleep_stages: { rem: 1.9, core: 3.8, deep: 0.4, awake: 0.3 },
  };
  const existing = { date: "2026-07-10", ...FULL_NIGHT };
  const incoming = { date: "2026-07-10", ...refreshed };
  const merged = mergeDailyMetric(existing, incoming);
  assertEquals(merged.sleep_stages, refreshed.sleep_stages);
});

// ---------------------------------------------------------------------------
// Swim series -> samples + set detection
// ---------------------------------------------------------------------------

/** Builds per-second swim series entries starting at the given offset. */
function swimSeries(
  startIso: string, // e.g. "2026-07-11 17:00:09 +0200"
  segments: {
    fromS: number;
    seconds: number;
    mPerS?: number;
    strokesPerS?: number;
  }[],
): { distance: unknown[]; stroke: unknown[] } {
  const base = new Date(startIso.replace(" ", "T").replace(" +", "+"))
    .getTime();
  const stamp = (offset: number): string => {
    const d = new Date(base + offset * 1000);
    const p = (n: number): string => String(n).padStart(2, "0");
    // Series timestamps arrive in local time +0200 in fixtures; emit UTC with +0000.
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${
      p(d.getUTCDate())
    } ` +
      `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${
        p(d.getUTCSeconds())
      } +0000`;
  };
  const distance: unknown[] = [];
  const stroke: unknown[] = [];
  for (const seg of segments) {
    for (let i = 0; i < seg.seconds; i++) {
      distance.push({
        date: stamp(seg.fromS + i),
        qty: seg.mPerS ?? 0.9,
        units: "m",
      });
      stroke.push({
        date: stamp(seg.fromS + i),
        qty: seg.strokesPerS ?? 0.4,
        units: "count",
      });
    }
  }
  return { distance, stroke };
}

function swimWorkoutFixture(
  series: { distance: unknown[]; stroke: unknown[] },
) {
  return {
    data: {
      workouts: [
        {
          id: "SWIM-0000-0000-0000-000000000001",
          name: "Pool Swim",
          start: "2026-07-11 17:00:00 +0200",
          end: "2026-07-11 17:45:00 +0200",
          distance: { qty: 1.0, units: "km" },
          swimDistance: series.distance,
          swimStroke: series.stroke,
        },
      ],
      metrics: [],
    },
  };
}

Deno.test("parses swim series into per-second samples with offsets from workout start", () => {
  const series = swimSeries("2026-07-11 17:00:00 +0200", [{
    fromS: 9,
    seconds: 3,
  }]);
  const { workouts } = parseIngestPayload(swimWorkoutFixture(series));
  assertEquals(workouts[0].swimSamples, [
    { offset_s: 9, distance_m: 0.9, strokes: 0.4 },
    { offset_s: 10, distance_m: 0.9, strokes: 0.4 },
    { offset_s: 11, distance_m: 0.9, strokes: 0.4 },
  ]);
});

Deno.test("splits sets on gaps > 10s and reports rest_after_s; last set has null rest", () => {
  // Two 60s blocks 40s apart: set 1 [9..68], rest 40s, set 2 [109..168].
  const series = swimSeries("2026-07-11 17:00:00 +0200", [
    { fromS: 9, seconds: 60 },
    { fromS: 109, seconds: 60 },
  ]);
  const { workouts } = parseIngestPayload(swimWorkoutFixture(series));
  assertEquals(workouts[0].swimSets.length, 2);
  const [s1, s2] = workouts[0].swimSets;
  assertEquals(s1.set_index, 1);
  assertEquals(s1.start_offset_s, 9);
  assertEquals(s1.duration_s, 60);
  assertAlmostEquals(s1.distance_m, 54); // 60 × 0.9 (binary FP sum, not exact)
  assertAlmostEquals(s1.strokes, 24); // 60 × 0.4
  assertEquals(s1.rest_after_s, 40); // 109 - (68 + 1)
  assertEquals(s2.set_index, 2);
  assertEquals(s2.rest_after_s, null);
});

Deno.test("keeps turn jitter (gaps <= 10s) inside one set", () => {
  // 30s + 4s hole + 30s -> ONE set spanning [0..63].
  const series = swimSeries("2026-07-11 17:00:00 +0200", [
    { fromS: 0, seconds: 30 },
    { fromS: 34, seconds: 30 },
  ]);
  const { workouts } = parseIngestPayload(swimWorkoutFixture(series));
  assertEquals(workouts[0].swimSets.length, 1);
  assertEquals(workouts[0].swimSets[0].duration_s, 64);
  assertAlmostEquals(workouts[0].swimSets[0].distance_m, 54); // 60 × 0.9 (binary FP sum, not exact)
});

Deno.test("drops sub-10m artifact blocks; rest spans across the dropped block", () => {
  // 60s set, then a 5s blip (4.5m < 10m) mid-rest, then a 60s set.
  const series = swimSeries("2026-07-11 17:00:00 +0200", [
    { fromS: 0, seconds: 60 },
    { fromS: 90, seconds: 5 },
    { fromS: 130, seconds: 60 },
  ]);
  const { workouts } = parseIngestPayload(swimWorkoutFixture(series));
  const sets = workouts[0].swimSets;
  assertEquals(sets.length, 2);
  assertEquals(sets[0].rest_after_s, 70); // 130 - (59 + 1): blip is not a set
  assertEquals(sets[1].set_index, 2);
});

Deno.test("swim series are stripped from raw and workouts without series get empty swim fields", () => {
  const series = swimSeries("2026-07-11 17:00:00 +0200", [{
    fromS: 0,
    seconds: 60,
  }]);
  const { workouts } = parseIngestPayload(swimWorkoutFixture(series));
  assertEquals("swimDistance" in workouts[0].raw, false);
  assertEquals("swimStroke" in workouts[0].raw, false);
  const stripped = workouts[0].raw._stripped as Record<string, number>;
  assertEquals(stripped.swimDistance, 60);
  assertEquals(stripped.swimStroke, 60);

  const { workouts: plain } = parseIngestPayload(workoutsExportFixture);
  assertEquals(plain[0].swimSamples, []);
  assertEquals(plain[0].swimSets, []);
});

// ---------------------------------------------------------------------------
// GPS route downsampling — downsampleRoute (pure, RDP-based)
// ---------------------------------------------------------------------------

/** Builds a wiggly outdoor route with `n` points, roughly a zig-zag path. */
function makeRoute(
  n: number,
): { latitude: number; longitude: number; altitude: number }[] {
  const points: { latitude: number; longitude: number; altitude: number }[] =
    [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    points.push({
      latitude: 43.3 + t * 0.05 + (i % 7 === 0 ? 0.002 : 0), // occasional turns
      longitude: -2.98 + t * 0.08 + (i % 11 === 0 ? -0.003 : 0),
      altitude: 10 + Math.sin(t * 10) * 5,
    });
  }
  return points;
}

Deno.test("downsampleRoute: returns [] for non-array input", () => {
  assertEquals(downsampleRoute(undefined), []);
  assertEquals(downsampleRoute(null), []);
  assertEquals(downsampleRoute("not-an-array"), []);
  assertEquals(downsampleRoute(42), []);
});

Deno.test("downsampleRoute: returns [] for an empty array", () => {
  assertEquals(downsampleRoute([]), []);
});

Deno.test("downsampleRoute: caps at <= 300 points and preserves exact first & last coordinate", () => {
  const raw = makeRoute(4100);
  const result = downsampleRoute(raw);
  assertEquals(result.length <= 300, true);
  assertEquals(result[0].lat, raw[0].latitude);
  assertEquals(result[0].lon, raw[0].longitude);
  assertEquals(result[result.length - 1].lat, raw[raw.length - 1].latitude);
  assertEquals(result[result.length - 1].lon, raw[raw.length - 1].longitude);
});

Deno.test("downsampleRoute: input at or below cap is returned as-is (mapped), no thinning", () => {
  const raw = makeRoute(250);
  const result = downsampleRoute(raw, 300);
  assertEquals(result.length, 250);
  for (let i = 0; i < raw.length; i++) {
    assertEquals(result[i].lat, raw[i].latitude);
    assertEquals(result[i].lon, raw[i].longitude);
  }
});

Deno.test("downsampleRoute: maps altitude to elevation_m, and null when altitude absent", () => {
  const raw = [
    { latitude: 1, longitude: 2, altitude: 12.5 },
    { latitude: 1.001, longitude: 2.001 }, // no altitude
  ];
  const result = downsampleRoute(raw);
  assertEquals(result[0].elevation_m, 12.5);
  assertEquals(result[1].elevation_m, null);
});

Deno.test("downsampleRoute: skips points with missing or non-finite lat/lon", () => {
  const raw = [
    { latitude: 1, longitude: 2, altitude: 1 },
    { latitude: null, longitude: 2, altitude: 1 }, // missing lat: skipped
    { longitude: 2, altitude: 1 }, // missing lat: skipped
    { latitude: NaN, longitude: 2, altitude: 1 }, // non-finite: skipped
    { latitude: 1.002, longitude: 2.002, altitude: 1 },
  ];
  const result = downsampleRoute(raw);
  assertEquals(result.length, 2);
});

Deno.test("downsampleRoute: seq is 0-based and strictly monotonic", () => {
  const raw = makeRoute(1000);
  const result = downsampleRoute(raw, 300);
  assertEquals(result[0].seq, 0);
  for (let i = 1; i < result.length; i++) {
    assertEquals(result[i].seq, result[i - 1].seq + 1);
  }
  assertEquals(result[result.length - 1].seq, result.length - 1);
});

Deno.test("downsampleRoute: preserves a sharp turn vertex rather than striding past it", () => {
  // A route that goes straight, then sharply turns, then straight again.
  // A naive every-Nth stride could skip the turn vertex entirely (leaving a
  // multi-hundred-point gap either side); RDP must keep a point right at
  // the bend since it's the point of maximum deviation from any chord that
  // spans across it.
  const raw: { latitude: number; longitude: number }[] = [];
  for (let i = 0; i <= 500; i++) {
    raw.push({ latitude: 43.0, longitude: -2.0 + i * 0.0001 });
  }
  const turnIndex = raw.length; // index of the corner point itself
  raw.push({ latitude: 43.05, longitude: raw[raw.length - 1].longitude }); // sharp corner
  for (let i = 1; i <= 500; i++) {
    raw.push({
      latitude: 43.05 + i * 0.0001,
      longitude: raw[turnIndex].longitude,
    });
  }
  const result = downsampleRoute(raw, 50);
  // A kept point should land within a couple of samples of the true corner
  // (not hundreds away, as a naive stride could produce).
  const closestOffset = Math.min(
    ...result.map((p) => {
      const idx = raw.findIndex((r) =>
        r.latitude === p.lat && r.longitude === p.lon
      );
      return Math.abs(idx - turnIndex);
    }),
  );
  assertEquals(closestOffset <= 2, true);
});

Deno.test("parseWorkout: a workout WITH a route yields a non-empty route array", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "route-outdoor",
          name: "Outdoor Run",
          start: "2026-07-08 08:00:00 +0200",
          end: "2026-07-08 09:00:00 +0200",
          route: [
            {
              latitude: 43.29,
              longitude: -2.98,
              altitude: 10,
              timestamp: "2026-07-08 08:00:01 +0200",
            },
            {
              latitude: 43.291,
              longitude: -2.981,
              altitude: 11,
              timestamp: "2026-07-08 08:00:02 +0200",
            },
            {
              latitude: 43.292,
              longitude: -2.982,
              altitude: 12,
              timestamp: "2026-07-08 08:00:03 +0200",
            },
          ],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const w = result.workouts[0];
  assertEquals(w.route.length, 3);
  assertEquals(w.route[0], { seq: 0, lat: 43.29, lon: -2.98, elevation_m: 10 });
  assertEquals(w.route[2], {
    seq: 2,
    lat: 43.292,
    lon: -2.982,
    elevation_m: 12,
  });
});

Deno.test("parseWorkout: a workout WITHOUT a route (e.g. indoor) yields route: []", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "indoor-strength",
          name: "Traditional Strength Training",
          start: "2026-07-08 18:00:00 +0200",
          end: "2026-07-08 19:00:00 +0200",
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts[0].route, []);
});

Deno.test("regression: a workout with a route still strips raw.route and keeps _route_start", () => {
  const payload = {
    data: {
      workouts: [
        {
          id: "route-regression",
          name: "Outdoor Walk",
          start: "2026-07-08 08:52:00 +0200",
          end: "2026-07-08 09:52:00 +0200",
          route: [
            {
              latitude: 43.2965,
              longitude: -2.9876,
              altitude: 12.4,
              timestamp: "2026-07-08 08:52:48 +0200",
            },
            {
              latitude: 43.2966,
              longitude: -2.9877,
              timestamp: "2026-07-08 08:52:49 +0200",
            },
          ],
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  const w = result.workouts[0];
  // raw.route must remain stripped exactly as before this feature.
  assertEquals(w.raw.route, undefined);
  const routeStart = w.raw._route_start as Record<string, unknown>;
  assertEquals(routeStart.latitude, 43.2965);
  assertEquals(routeStart.longitude, -2.9876);
  // route (the new normalized field) is populated independently of raw.
  assertEquals(w.route.length, 2);
});

Deno.test("drops workouts lacking a type or resolvable start (NOT NULL guard)", () => {
  const payload = {
    data: {
      workouts: [
        { id: "no-name", start: "2026-07-08 07:00:00 +0200", end: "2026-07-08 08:00:00 +0200" },
        { id: "no-start", name: "Run", duration: 1800 },
        {
          id: "keeper",
          name: "Run",
          start: "2026-07-08 07:00:00 +0200",
          end: "2026-07-08 08:00:00 +0200",
        },
      ],
    },
  };
  const result = parseIngestPayload(payload);
  assertEquals(result.workouts.length, 1);
  assertEquals(result.workouts[0].external_id, "keeper");
});
