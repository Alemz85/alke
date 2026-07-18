// Pure parsing layer for Health Auto Export (Export Version 2) payloads.
// No network calls, no Deno.env access — everything here is a pure function
// of its inputs so it can be unit tested without a database or server.

/** Thrown when the top-level payload shape can't be understood at all. */
export class ParseError extends Error {}

export interface NormalizedHrSample {
  offset_s: number;
  bpm: number;
}

export interface NormalizedSwimSample {
  offset_s: number;
  distance_m: number;
  strokes: number;
}

export interface NormalizedSwimSet {
  set_index: number; // 1-based, chronological
  start_offset_s: number;
  duration_s: number;
  distance_m: number;
  strokes: number;
  rest_after_s: number | null; // null for the last set
}

export interface NormalizedRoutePoint {
  seq: number; // 0-based, chronological
  lat: number;
  lon: number;
  elevation_m: number | null;
}

export interface NormalizedWorkout {
  external_id: string;
  type: string | null;
  start_at: string | null; // ISO 8601 UTC
  end_at: string | null; // ISO 8601 UTC
  duration_s: number | null;
  distance_m: number | null;
  energy_kcal: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  source: string;
  raw: Record<string, unknown>;
  hrSamples: NormalizedHrSample[];
  swimSamples: NormalizedSwimSample[];
  swimSets: NormalizedSwimSet[];
  route: NormalizedRoutePoint[];
}

export interface NormalizedDailyMetric {
  date: string; // YYYY-MM-DD, LOCAL date of the sample timestamp
  resting_hr: number | null;
  hrv_sdnn_ms: number | null;
  respiratory_rate: number | null;
  sleep_start: string | null;
  sleep_end: string | null;
  sleep_duration_min: number | null;
  sleep_stages: Record<string, unknown> | null;
  vo2max: number | null;
  steps: number | null;
  active_energy_kcal: number | null;
  wrist_temp_deviation_c: number | null;
  weight_kg: number | null;
  walking_running_distance_m: number | null;
  flights_climbed: number | null;
}

export interface ParsedResult {
  workouts: NormalizedWorkout[];
  dailyMetrics: NormalizedDailyMetric[];
}

// ===========================================================================
// FIELD-NAME ASSUMPTIONS — centralized here. Health Auto Export's exact
// export shape varies by version; when real payloads are inspected during
// live testing, corrections should start here.
// ===========================================================================
const FIELD_MAP = {
  // Metric `name` -> daily_metrics column(s). Unknown names are ignored.
  metricNameToColumn: {
    resting_heart_rate: "resting_hr",
    heart_rate_variability: "hrv_sdnn_ms",
    respiratory_rate: "respiratory_rate",
    vo2_max: "vo2max",
    step_count: "steps", // summed per date
    active_energy: "active_energy_kcal", // summed per date; unit-converted to kcal
    apple_sleeping_wrist_temperature: "wrist_temp_deviation_c",
    weight_body_mass: "weight_kg", // scalar per date, last-wins; unit-converted to kg
    walking_running_distance: "walking_running_distance_m", // summed per date; unit-converted to meters
    flights_climbed: "flights_climbed", // summed per date; integer count
    // sleep_analysis is handled specially (multi-field).
  } as Record<string, keyof NormalizedDailyMetric>,
  sleepAnalysisMetricName: "sleep_analysis",
  // Workout field candidates, in preference order, for values that may
  // appear under different keys or as flat numbers vs {qty, units} objects.
  workout: {
    id: "id",
    name: "name",
    start: "start",
    end: "end",
    duration: "duration",
    distance: "distance",
    energy: "activeEnergyBurned",
    avgHr: "avgHeartRate", // summary field; preferred over sample-derived avg
    maxHr: "maxHeartRate", // summary field; preferred over sample-derived max
    hrSeries: "heartRateData",
    hrRecoverySeries: "heartRateRecovery",
    swimDistanceSeries: "swimDistance", // per-second meters (HAE smears per-length samples)
    swimStrokeSeries: "swimStroke", // per-second watch-arm strokes
    route: "route", // GPS trace: [{latitude, longitude, altitude, timestamp, ...}]
  },
  // Bulky per-sample series always stripped from workouts.raw (already
  // preserved verbatim in raw_payloads, and the HR series is normalized
  // into workout_hr_samples). Route is stripped separately (see
  // routeStartFields) so its first point can be summarized first.
  workoutRawStripKeys: [
    "heartRateData",
    "heartRateRecovery",
    "swimDistance",
    "swimStroke",
  ],
  // Fields copied from the first route point into raw._route_start.
  routeStartFields: ["latitude", "longitude", "timestamp"],
  // Per-sample HR value candidates, in preference order.
  hrSampleValueKeys: ["Avg", "avg", "qty"],
  hrSampleDateKey: "date",
  // Sleep sub-fields within a sleep_analysis data entry.
  sleep: {
    start: "sleepStart",
    end: "sleepEnd",
    totalHours: "totalSleep", // fallback: "asleep"
    totalHoursAlt: "asleep",
    stageKeys: ["deep", "core", "rem", "awake"],
  },
  // Distance unit -> meters conversion factor. Unknown units assume meters.
  distanceUnitToMeters: {
    m: 1,
    km: 1000,
    mi: 1609.344,
    yd: 0.9144,
  } as Record<string, number>,
  // Mass unit -> kilograms conversion factor, for weight_body_mass. Unknown
  // units (including absent/kg) assume kilograms already.
  massUnitToKg: {
    kg: 1,
    lb: 0.45359237,
    lbs: 0.45359237,
    st: 6.35029318,
  } as Record<string, number>,
  // Energy unit -> kcal conversion factor. HAE sends energy in kJ (observed
  // on every real payload for both workout activeEnergyBurned and the
  // active_energy metric); "cal" from Health means dietary Calories = kcal.
  // Unknown/absent units assume kcal already.
  energyUnitToKcal: {
    kj: 1 / 4.184,
    kcal: 1,
    cal: 1,
  } as Record<string, number>,
} as const;

// Real workouts carry many per-second series at the top level (swimDistance,
// activeEnergy, stepCount, speed, ...) with thousands of entries each. Any
// top-level array longer than this is stripped from workouts.raw and noted
// in raw._stripped; the full data stays recoverable from raw_payloads.
const MAX_RAW_ARRAY_ENTRIES = 50;

// Swim set detection: HAE swim series sample once per second while swimming
// and not at all while resting. Gaps ≤ SWIM_REST_SPLIT_S are turn jitter
// (observed 2–5s mid-set); real rests observed ≥16s. Blocks shorter than
// SWIM_MIN_SET_DISTANCE_M are sensor artifacts, not sets.
const SWIM_REST_SPLIT_S = 10;
const SWIM_MIN_SET_DISTANCE_M = 10;

// ===========================================================================
// Date parsing
// ===========================================================================

/**
 * Parses Health Auto Export's "YYYY-MM-DD HH:mm:ss ±HHMM" or "±HH:MM" date
 * strings into a real Date. Returns null for anything unparseable rather
 * than throwing — callers must tolerate missing/garbled dates.
 */
function parseHaeDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}):?(\d{2})$/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, offH, offM] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offH}:${offM}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** The local date part (first 10 chars) of a HAE timestamp string, verbatim. */
function localDatePart(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function toIso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

// ===========================================================================
// Generic helpers
// ===========================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Reads a value that may be a flat number or a {qty, units} object. */
function readQtyUnits(
  v: unknown,
): { qty: number | null; units: string | null } {
  if (isPlainObject(v)) {
    return {
      qty: toNumber(v.qty),
      units: typeof v.units === "string" ? v.units : null,
    };
  }
  const qty = toNumber(v);
  return { qty, units: null };
}

function toSnakeCase(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function metersFromDistance(v: unknown): number | null {
  const { qty, units } = readQtyUnits(v);
  if (qty === null) return null;
  const factor = units
    ? FIELD_MAP.distanceUnitToMeters[units.toLowerCase()] ?? 1
    : 1;
  return qty * factor;
}

function kcalFromEnergy(v: unknown): number | null {
  const { qty, units } = readQtyUnits(v);
  if (qty === null) return null;
  const factor = units
    ? FIELD_MAP.energyUnitToKcal[units.toLowerCase()] ?? 1
    : 1;
  return qty * factor;
}

// ===========================================================================
// Workout parsing
// ===========================================================================

function parseWorkout(entry: unknown): NormalizedWorkout {
  const w = isPlainObject(entry) ? entry : {};

  const idRaw = w[FIELD_MAP.workout.id];
  const nameRaw = w[FIELD_MAP.workout.name];
  const type = typeof nameRaw === "string" && nameRaw.trim() !== ""
    ? toSnakeCase(nameRaw)
    : null;

  const startDate = parseHaeDate(w[FIELD_MAP.workout.start]);
  const endDate = parseHaeDate(w[FIELD_MAP.workout.end]);

  const external_id = typeof idRaw === "string" && idRaw.trim() !== ""
    ? idRaw
    : `${type ?? "unknown"}-${
      startDate ? startDate.toISOString() : "no-start"
    }`;

  const duration_s = inferDurationSeconds(
    w[FIELD_MAP.workout.duration],
    startDate,
    endDate,
  );
  const distance_m = metersFromDistance(w[FIELD_MAP.workout.distance]);
  const energy_kcal = kcalFromEnergy(w[FIELD_MAP.workout.energy]);

  const hrSamples = parseHrSamples(w[FIELD_MAP.workout.hrSeries], startDate);
  // Explicit summary fields win over sample-derived values: some workout
  // types (e.g. strength) carry summary HR with a sparse or absent series.
  const summaryAvgHr = readQtyUnits(w[FIELD_MAP.workout.avgHr]).qty;
  const summaryMaxHr = readQtyUnits(w[FIELD_MAP.workout.maxHr]).qty;
  const avg_hr = summaryAvgHr ??
    (hrSamples.length > 0
      ? hrSamples.reduce((sum, s) => sum + s.bpm, 0) / hrSamples.length
      : null);
  const max_hr = summaryMaxHr ??
    (hrSamples.length > 0 ? Math.max(...hrSamples.map((s) => s.bpm)) : null);

  const swimSamples = parseSwimSamples(
    w[FIELD_MAP.workout.swimDistanceSeries],
    w[FIELD_MAP.workout.swimStrokeSeries],
    startDate,
  );
  const swimSets = detectSwimSets(swimSamples);

  const route = downsampleRoute(w[FIELD_MAP.workout.route]);

  const raw = buildWorkoutRaw(w);

  return {
    external_id,
    type,
    start_at: toIso(startDate),
    end_at: toIso(endDate),
    duration_s,
    distance_m,
    energy_kcal,
    avg_hr,
    max_hr,
    source: "apple_watch",
    raw,
    hrSamples,
    swimSamples,
    swimSets,
    route,
  };
}

/**
 * Builds the slimmed-down `raw` jsonb for a workout: keeps everything from
 * the original entry except bulky per-sample series, which are removed and
 * tallied in `_stripped` ({key: entryCount}). The `route` GPS trace is
 * always stripped (regardless of length), but its first point is first
 * summarized into `_route_start` for cheap "where was this workout" queries.
 * All stripped data remains recoverable from the raw_payloads table.
 */
function buildWorkoutRaw(w: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...w };
  const stripped: Record<string, number> = {};

  const strip = (key: string): void => {
    const value = raw[key];
    stripped[key] = Array.isArray(value) ? value.length : 0;
    delete raw[key];
  };

  // Route: summarize the first point, then strip even when short.
  const routeKey = FIELD_MAP.workout.route;
  if (routeKey in raw) {
    const route = raw[routeKey];
    if (Array.isArray(route) && route.length > 0) {
      const first = isPlainObject(route[0]) ? route[0] : {};
      const routeStart: Record<string, unknown> = {};
      for (const field of FIELD_MAP.routeStartFields) {
        routeStart[field] = first[field] ?? null;
      }
      raw._route_start = routeStart;
    }
    strip(routeKey);
  }

  // Explicitly known bulky series.
  for (const key of FIELD_MAP.workoutRawStripKeys) {
    if (key in raw) strip(key);
  }

  // Generic rule: any remaining top-level array with too many entries.
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value) && value.length > MAX_RAW_ARRAY_ENTRIES) {
      strip(key);
    }
  }

  if (Object.keys(stripped).length > 0) raw._stripped = stripped;
  return raw;
}

/**
 * Prefer end-start when both are known — it's always in seconds and doesn't
 * depend on guessing `duration`'s unit. When only bare `duration` is present,
 * treat it as SECONDS: real payloads in this HAE version have shown bare
 * `duration` values (e.g. 1869.8, 3736.8) matching end−start exactly, and the
 * vendored HAE docs (docs/vendor/hae-wiki/API-Export---JSON-Format.md) also
 * document workout `duration` as seconds. An earlier version of this function
 * assumed minutes as a defensive default against older HAE versions that may
 * have used minutes, but that assumption is contradicted by every real
 * payload observed so far. Today start+end is present on every real workout,
 * so this fallback is dormant; it's fixed anyway so it's correct if it ever
 * fires. No magnitude guard: a workout with only `duration` and no start/end
 * has nothing to sanity-check the value against, so guessing a threshold
 * would just be speculative complexity.
 */
function inferDurationSeconds(
  rawDuration: unknown,
  start: Date | null,
  end: Date | null,
): number | null {
  if (start && end) {
    const diffS = Math.round((end.getTime() - start.getTime()) / 1000);
    if (diffS >= 0) return diffS;
  }
  const n = toNumber(rawDuration);
  if (n === null) return null;
  // No start/end to corroborate: treat as seconds (real-payload evidence).
  return Math.round(n);
}

function parseHrSamples(
  raw: unknown,
  start: Date | null,
): NormalizedHrSample[] {
  if (!Array.isArray(raw) || !start) return [];
  const byOffset = new Map<number, number>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const sampleDate = parseHaeDate(entry[FIELD_MAP.hrSampleDateKey]);
    if (!sampleDate) continue;
    const offset_s = Math.round(
      (sampleDate.getTime() - start.getTime()) / 1000,
    );
    if (offset_s < 0) continue;

    let value: number | null = null;
    for (const key of FIELD_MAP.hrSampleValueKeys) {
      const candidate = toNumber(entry[key]);
      if (candidate !== null) {
        value = candidate;
        break;
      }
    }
    if (value === null) continue;

    byOffset.set(offset_s, Math.round(value)); // last one wins (map overwrite)
  }
  return [...byOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset_s, bpm]) => ({ offset_s, bpm }));
}

/**
 * Joins the swimDistance/swimStroke per-second series into per-second samples
 * keyed on offset from workout start. Multiple entries landing on the same
 * second are summed (boundary seconds can carry two partial samples).
 */
function parseSwimSamples(
  distanceRaw: unknown,
  strokeRaw: unknown,
  start: Date | null,
): NormalizedSwimSample[] {
  if (!Array.isArray(distanceRaw) || distanceRaw.length === 0 || !start) {
    return [];
  }

  const readSeries = (raw: unknown): Map<number, number> => {
    const byOffset = new Map<number, number>();
    if (!Array.isArray(raw)) return byOffset;
    for (const entry of raw) {
      if (!isPlainObject(entry)) continue;
      const sampleDate = parseHaeDate(entry[FIELD_MAP.hrSampleDateKey]);
      if (!sampleDate) continue;
      const offset_s = Math.round(
        (sampleDate.getTime() - start.getTime()) / 1000,
      );
      if (offset_s < 0) continue;
      const qty = toNumber(entry.qty);
      if (qty === null) continue;
      byOffset.set(offset_s, (byOffset.get(offset_s) ?? 0) + qty);
    }
    return byOffset;
  };

  const distance = readSeries(distanceRaw);
  const strokes = readSeries(strokeRaw);
  return [...distance.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset_s, distance_m]) => ({
      offset_s,
      distance_m,
      strokes: strokes.get(offset_s) ?? 0,
    }));
}

/**
 * Splits per-second swim samples into sets: a new set starts after a sampling
 * gap > SWIM_REST_SPLIT_S (rest), blocks under SWIM_MIN_SET_DISTANCE_M are
 * dropped as artifacts (their span melts into the surrounding rest), and
 * rest_after_s measures to the next kept set (null for the last).
 */
export function detectSwimSets(
  samples: NormalizedSwimSample[],
): NormalizedSwimSet[] {
  const blocks: NormalizedSwimSample[][] = [];
  let current: NormalizedSwimSample[] = [];
  for (const sample of samples) {
    const prev = current[current.length - 1];
    if (prev && sample.offset_s - prev.offset_s > SWIM_REST_SPLIT_S) {
      blocks.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length > 0) blocks.push(current);

  const sum = (
    block: NormalizedSwimSample[],
    key: "distance_m" | "strokes",
  ): number => block.reduce((total, s) => total + s[key], 0);

  const kept = blocks.filter((b) =>
    sum(b, "distance_m") >= SWIM_MIN_SET_DISTANCE_M
  );
  return kept.map((block, i) => {
    const first = block[0];
    const last = block[block.length - 1];
    const next = kept[i + 1];
    return {
      set_index: i + 1,
      start_offset_s: first.offset_s,
      duration_s: last.offset_s - first.offset_s + 1,
      distance_m: sum(block, "distance_m"),
      strokes: sum(block, "strokes"),
      rest_after_s: next ? next[0].offset_s - (last.offset_s + 1) : null,
    };
  });
}

// ===========================================================================
// GPS route downsampling — Ramer–Douglas–Peucker, pure/self-contained.
// ===========================================================================

// Routes can carry up to ~4100 points; capping keeps workout_route_points
// rows bounded while RDP preserves the shape of the track (turns) rather
// than a naive every-Nth stride.
const ROUTE_POINT_CAP = 300;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Perpendicular distance from point `p` to the line through `a`/`b`, in a
 * planar approximation: longitude is scaled by cos(mean latitude) so degrees
 * of lat/lon are comparable regardless of where on the globe the route is.
 */
function perpendicularDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  // Distance from p to the infinite line through a/b (not the segment).
  const numerator = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
  return numerator / Math.sqrt(lengthSq);
}

/** Standard recursive RDP over planar {x, y} points; keeps endpoints always. */
function rdp(points: { x: number; y: number }[], epsilon: number): boolean[] {
  const keep = new Array<boolean>(points.length).fill(false);
  if (points.length < 3) {
    keep.fill(true);
    return keep;
  }
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const dist = perpendicularDistance(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxDist > epsilon) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }
  return keep;
}

function rdpPointCount(
  points: { x: number; y: number }[],
  epsilon: number,
): number {
  return rdp(points, epsilon).filter(Boolean).length;
}

/**
 * Downsamples a raw HAE `route` array to at most `cap` points using RDP,
 * preserving the first/last point and the route's turns rather than an
 * every-Nth stride. Pure and self-contained: no I/O, unit-testable in
 * isolation.
 */
export function downsampleRoute(
  points: unknown,
  cap = ROUTE_POINT_CAP,
): NormalizedRoutePoint[] {
  if (!Array.isArray(points) || points.length === 0) return [];

  const mapped: { lat: number; lon: number; elevation_m: number | null }[] = [];
  for (const entry of points) {
    if (!isPlainObject(entry)) continue;
    const lat = toNumber(entry.latitude);
    const lon = toNumber(entry.longitude);
    if (
      lat === null || lon === null || !isFiniteNumber(lat) ||
      !isFiniteNumber(lon)
    ) continue;
    const elevation_m = toNumber(entry.altitude);
    mapped.push({ lat, lon, elevation_m });
  }
  if (mapped.length === 0) return [];
  if (mapped.length <= cap) {
    return mapped.map((p, seq) => ({
      seq,
      lat: p.lat,
      lon: p.lon,
      elevation_m: p.elevation_m,
    }));
  }

  // Planar projection: scale longitude by cos(mean latitude) so RDP's
  // Euclidean distance is meaningful across latitudes.
  const meanLatRad =
    (mapped.reduce((sum, p) => sum + p.lat, 0) / mapped.length) *
    (Math.PI / 180);
  const lonScale = Math.cos(meanLatRad);
  const planar = mapped.map((p) => ({ x: p.lon * lonScale, y: p.lat }));

  // Binary search for the smallest epsilon that yields <= cap points. RDP
  // always keeps both endpoints, so epsilon=0 is the floor (max points) and
  // increasing epsilon monotonically thins the result.
  let lo = 0;
  let hi = 1; // degrees in planar-projected units; route spans are always << 1
  while (rdpPointCount(planar, hi) > cap) {
    hi *= 2;
    if (hi > 1e6) break; // pathological input guard
  }
  let bestKeep = rdp(planar, hi);
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const keep = rdp(planar, mid);
    const count = keep.filter(Boolean).length;
    if (count <= cap) {
      hi = mid;
      bestKeep = keep;
    } else {
      lo = mid;
    }
  }

  const result: NormalizedRoutePoint[] = [];
  let seq = 0;
  for (let i = 0; i < mapped.length; i++) {
    if (bestKeep[i]) {
      const p = mapped[i];
      result.push({
        seq: seq++,
        lat: p.lat,
        lon: p.lon,
        elevation_m: p.elevation_m,
      });
    }
  }
  return result;
}

// ===========================================================================
// Daily metrics parsing
// ===========================================================================

function emptyDailyMetric(date: string): NormalizedDailyMetric {
  return {
    date,
    resting_hr: null,
    hrv_sdnn_ms: null,
    respiratory_rate: null,
    sleep_start: null,
    sleep_end: null,
    sleep_duration_min: null,
    sleep_stages: null,
    vo2max: null,
    steps: null,
    active_energy_kcal: null,
    wrist_temp_deviation_c: null,
    weight_kg: null,
    walking_running_distance_m: null,
    flights_climbed: null,
  };
}

/** Accumulates metric entries into a map of date -> NormalizedDailyMetric. */
function parseMetrics(metrics: unknown): Map<string, NormalizedDailyMetric> {
  const byDate = new Map<string, NormalizedDailyMetric>();
  // Track running sums separately for metrics that must be summed per date
  // (step_count, active_energy) since NormalizedDailyMetric only stores the
  // latest merged value.
  const sums = new Map<string, Map<string, number>>();

  const getRow = (date: string): NormalizedDailyMetric => {
    let row = byDate.get(date);
    if (!row) {
      row = emptyDailyMetric(date);
      byDate.set(date, row);
    }
    return row;
  };

  const addSum = (date: string, column: string, amount: number): number => {
    let dateSums = sums.get(date);
    if (!dateSums) {
      dateSums = new Map();
      sums.set(date, dateSums);
    }
    const next = (dateSums.get(column) ?? 0) + amount;
    dateSums.set(column, next);
    return next;
  };

  if (!Array.isArray(metrics)) return byDate;

  for (const metric of metrics) {
    if (!isPlainObject(metric)) continue;
    const name = typeof metric.name === "string" ? metric.name : null;
    const data = Array.isArray(metric.data) ? metric.data : [];
    if (!name) continue;

    if (name === FIELD_MAP.sleepAnalysisMetricName) {
      for (const entry of data) parseSleepEntry(entry, getRow);
      continue;
    }

    const column = FIELD_MAP.metricNameToColumn[name];
    if (!column) continue; // unknown metric name: ignore gracefully

    const summed = column === "steps" || column === "active_energy_kcal" ||
      column === "walking_running_distance_m" || column === "flights_climbed";
    const isWeight = column === "weight_kg";
    const isDistance = column === "walking_running_distance_m";
    const isEnergy = column === "active_energy_kcal";
    // The metric-level `units` field applies to every entry in `data`
    // (Health Auto Export doesn't vary units per-entry within one metric).
    const metricUnits = typeof metric.units === "string"
      ? metric.units.toLowerCase()
      : null;

    for (const entry of data) {
      if (!isPlainObject(entry)) continue;
      const date = localDatePart(entry.date);
      if (!date) continue;
      let qty = toNumber(entry.qty);
      if (qty === null) continue;

      if (isWeight) {
        const entryUnits = typeof entry.units === "string"
          ? entry.units.toLowerCase()
          : metricUnits;
        const factor = entryUnits ? FIELD_MAP.massUnitToKg[entryUnits] ?? 1 : 1;
        qty = qty * factor;
      }
      if (isDistance) {
        const entryUnits = typeof entry.units === "string"
          ? entry.units.toLowerCase()
          : metricUnits;
        const factor = entryUnits
          ? FIELD_MAP.distanceUnitToMeters[entryUnits] ?? 1
          : 1;
        qty = qty * factor;
      }
      if (isEnergy) {
        const entryUnits = typeof entry.units === "string"
          ? entry.units.toLowerCase()
          : metricUnits;
        const factor = entryUnits
          ? FIELD_MAP.energyUnitToKcal[entryUnits] ?? 1
          : 1;
        qty = qty * factor;
      }

      const row = getRow(date) as unknown as Record<string, unknown>;
      if (summed) {
        const total = addSum(date, column, qty);
        row[column] = column === "steps" || column === "flights_climbed"
          ? Math.round(total)
          : total;
      } else {
        row[column] = qty;
      }
    }
  }

  return byDate;
}

function parseSleepEntry(
  entry: unknown,
  getRow: (date: string) => NormalizedDailyMetric,
): void {
  if (!isPlainObject(entry)) return;
  const date = localDatePart(entry.date);
  if (!date) return;
  const row = getRow(date);

  const sleepStart = parseHaeDate(entry[FIELD_MAP.sleep.start]);
  const sleepEnd = parseHaeDate(entry[FIELD_MAP.sleep.end]);
  if (sleepStart) row.sleep_start = toIso(sleepStart);
  if (sleepEnd) row.sleep_end = toIso(sleepEnd);

  const totalHours = toNumber(entry[FIELD_MAP.sleep.totalHours]) ??
    toNumber(entry[FIELD_MAP.sleep.totalHoursAlt]);
  if (totalHours !== null) row.sleep_duration_min = totalHours * 60;

  const stages: Record<string, unknown> = {};
  let hasStage = false;
  for (const key of FIELD_MAP.sleep.stageKeys) {
    if (key in entry) {
      stages[key] = entry[key];
      hasStage = true;
    }
  }
  if (hasStage) row.sleep_stages = stages;
}

// ===========================================================================
// Entry point
// ===========================================================================

/**
 * Parses a Health Auto Export payload (either the workouts-export or the
 * health-metrics-export shape, or both combined) into normalized rows.
 * Throws ParseError only when the top-level shape is unusable; individual
 * malformed entries are skipped/defaulted rather than failing the batch.
 */
export function parseIngestPayload(body: unknown): ParsedResult {
  if (!isPlainObject(body)) {
    throw new ParseError("payload must be a JSON object");
  }
  const data = body.data;
  if (!isPlainObject(data)) {
    throw new ParseError("payload missing 'data' object");
  }

  const workoutsRaw = Array.isArray(data.workouts) ? data.workouts : [];
  // A workout without a type or resolvable start time is unusable everywhere
  // downstream (workouts.type/start_at are NOT NULL) — drop it here rather
  // than letting one malformed entry violate the constraint and abort the
  // whole batch upsert (HAE would then retry the poisoned batch forever).
  // The full entry stays recoverable in raw_payloads.
  const workouts = workoutsRaw
    .map(parseWorkout)
    .filter((w) => w.type !== null && w.start_at !== null);

  const dailyMetricsMap = parseMetrics(data.metrics);
  const dailyMetrics = [...dailyMetricsMap.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );

  return { workouts, dailyMetrics };
}

// ===========================================================================
// daily_metrics merge — null never clobbers existing value. Exported so it
// can be unit tested independently of any database round trip.
// ===========================================================================

const MERGEABLE_COLUMNS = [
  "resting_hr",
  "hrv_sdnn_ms",
  "respiratory_rate",
  "vo2max",
  "steps",
  "active_energy_kcal",
  "wrist_temp_deviation_c",
  "weight_kg",
  "walking_running_distance_m",
  "flights_climbed",
] as const;

// Sleep columns describe ONE aggregate of the night and merge as a group:
// HAE incremental syncs can re-send a *shrunken* aggregate of the same night
// (a later export can cover a smaller window), so a shorter incoming night
// must never
// clobber a longer stored one, and fields from different exports must not be
// spliced together.
const SLEEP_COLUMNS = [
  "sleep_start",
  "sleep_end",
  "sleep_duration_min",
  "sleep_stages",
] as const;

export type DailyMetricRow =
  & { date: string }
  & Partial<
    Record<
      (typeof MERGEABLE_COLUMNS)[number] | (typeof SLEEP_COLUMNS)[number],
      unknown
    >
  >;

/**
 * Merges an incoming daily_metrics row onto an existing one. Non-sleep
 * columns merge per column: incoming non-null/non-undefined wins, otherwise
 * the existing value is kept. Sleep columns merge as an atomic group keyed
 * on sleep_duration_min: the incoming group is adopted only when it is at
 * least as complete (>= duration) as the stored one, or when nothing is
 * stored yet. `existing` may be null (no prior row) in which case incoming
 * values pass through unchanged.
 */
export function mergeDailyMetric(
  existing: DailyMetricRow | null,
  incoming: DailyMetricRow,
): DailyMetricRow {
  if (!existing) return incoming;
  const merged: Record<string, unknown> = { ...existing, date: incoming.date };
  for (const column of MERGEABLE_COLUMNS) {
    const incomingValue = (incoming as Record<string, unknown>)[column];
    if (incomingValue !== null && incomingValue !== undefined) {
      merged[column] = incomingValue;
    }
  }

  const existingDuration = toNumber(existing.sleep_duration_min);
  const incomingDuration = toNumber(incoming.sleep_duration_min);
  const adoptIncomingSleep = existingDuration === null
    ? SLEEP_COLUMNS.some((c) =>
      (incoming as Record<string, unknown>)[c] !== null &&
      (incoming as Record<string, unknown>)[c] !== undefined
    )
    : incomingDuration !== null && incomingDuration >= existingDuration;
  if (adoptIncomingSleep) {
    for (const column of SLEEP_COLUMNS) {
      const incomingValue = (incoming as Record<string, unknown>)[column];
      if (incomingValue !== null && incomingValue !== undefined) {
        merged[column] = incomingValue;
      }
    }
  }
  return merged as DailyMetricRow;
}
