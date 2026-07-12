#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
// Seed/refresh the curated exercise catalog from data/exercise-catalog/*.json.
// Validates the whole catalog first (strict keys, controlled vocabularies,
// cross-file duplicate names and alias collisions) and refuses to write on any
// violation. Idempotent: matches existing rows case-insensitively by name
// (name_key) and updates their catalog fields in place — user-created rows
// with the same name are upgraded to catalog rows, ids (and therefore
// gym_sets/template FKs) are preserved. Re-run whenever the catalog grows.
//
// Usage: deno run --allow-net --allow-env --allow-read --env-file=.env scripts/seed_exercises.ts [--dry-run]
import { createClient } from "npm:@supabase/supabase-js@2";

const BODY_PARTS = ["chest", "back", "shoulders", "arms", "legs", "core", "full body"];
const MUSCLES = [
  "chest", "lats", "upper back", "traps", "lower back",
  "front delts", "side delts", "rear delts", "biceps", "triceps", "forearms",
  "quadriceps", "hamstrings", "glutes", "calves", "adductors", "abductors",
  "hip flexors", "abs", "obliques",
];
const EQUIPMENT = [
  "barbell", "dumbbell", "kettlebell", "machine", "cable", "bodyweight",
  "band", "smith machine", "ez bar", "trap bar", "other",
];
const MECHANICS = ["compound", "isolation"];
const MOVEMENT_PATTERNS = [
  "squat", "hinge", "lunge", "horizontal push", "vertical push",
  "horizontal pull", "vertical pull", "carry", "core", "rotation", "isolation",
];
const KEYS = [
  "name", "aliases", "body_part", "primary_muscles", "secondary_muscles",
  "equipment", "mechanics", "movement_pattern",
];

interface CatalogEntry {
  name: string;
  aliases: string[];
  body_part: string;
  primary_muscles: string[];
  secondary_muscles: string[];
  equipment: string;
  mechanics: string;
  movement_pattern: string;
}

const dir = "data/exercise-catalog";
const entries: { entry: CatalogEntry; file: string }[] = [];
for await (const f of Deno.readDir(dir)) {
  if (!f.name.endsWith(".json")) continue;
  const parsed = JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`));
  if (!Array.isArray(parsed)) throw new Error(`${f.name}: not a JSON array`);
  for (const entry of parsed) entries.push({ entry, file: f.name });
}

const violations: string[] = [];
const byNameKey = new Map<string, string>(); // name_key -> file
const aliasOwner = new Map<string, string>(); // alias -> name

for (const { entry, file } of entries) {
  const where = `${file}: "${entry?.name ?? "?"}"`;
  const keys = Object.keys(entry ?? {}).sort().join(",");
  if (keys !== [...KEYS].sort().join(",")) {
    violations.push(`${where}: key set mismatch (${keys})`);
    continue;
  }
  if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 120) {
    violations.push(`${where}: bad name`);
  }
  const nameKey = entry.name.trim().toLowerCase();
  if (byNameKey.has(nameKey)) {
    violations.push(`${where}: duplicate name also in ${byNameKey.get(nameKey)}`);
  }
  byNameKey.set(nameKey, file);
  if (!BODY_PARTS.includes(entry.body_part)) violations.push(`${where}: body_part "${entry.body_part}"`);
  if (!EQUIPMENT.includes(entry.equipment)) violations.push(`${where}: equipment "${entry.equipment}"`);
  if (!MECHANICS.includes(entry.mechanics)) violations.push(`${where}: mechanics "${entry.mechanics}"`);
  if (!MOVEMENT_PATTERNS.includes(entry.movement_pattern)) {
    violations.push(`${where}: movement_pattern "${entry.movement_pattern}"`);
  }
  if (!Array.isArray(entry.primary_muscles) || entry.primary_muscles.length < 1 || entry.primary_muscles.length > 3 ||
      !entry.primary_muscles.every((m) => MUSCLES.includes(m))) {
    violations.push(`${where}: primary_muscles ${JSON.stringify(entry.primary_muscles)}`);
  }
  if (!Array.isArray(entry.secondary_muscles) || entry.secondary_muscles.length > 4 ||
      !entry.secondary_muscles.every((m) => MUSCLES.includes(m))) {
    violations.push(`${where}: secondary_muscles ${JSON.stringify(entry.secondary_muscles)}`);
  }
  if (!Array.isArray(entry.aliases) || entry.aliases.some((a) => typeof a !== "string" || a !== a.toLowerCase().trim() || !a)) {
    violations.push(`${where}: aliases must be trimmed lowercase strings`);
  }
}
// alias collisions: an alias may not repeat across entries, nor equal any entry's name
for (const { entry, file } of entries) {
  for (const alias of entry.aliases ?? []) {
    if (byNameKey.has(alias) && alias !== entry.name.trim().toLowerCase()) {
      violations.push(`${file}: "${entry.name}" alias "${alias}" collides with another entry's name`);
    }
    if (aliasOwner.has(alias)) {
      violations.push(`${file}: "${entry.name}" alias "${alias}" already used by "${aliasOwner.get(alias)}"`);
    }
    aliasOwner.set(alias, entry.name);
  }
}

console.log(`catalog: ${entries.length} entries from ${dir}`);
if (violations.length > 0) {
  console.error(`\n${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  Deno.exit(1);
}
console.log("validation: OK");
if (Deno.args.includes("--dry-run")) Deno.exit(0);

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY required (use --env-file=.env)");
  Deno.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

// Match by name_key so re-runs update and user-typed rows get upgraded in
// place (ids preserved — gym_sets/template references stay valid).
const { data: existing, error: readError } = await supabase
  .from("exercises")
  .select("id, name_key");
if (readError) throw new Error(`read exercises: ${readError.message}`);
const idByNameKey = new Map((existing ?? []).map((r) => [r.name_key as string, r.id as string]));

let inserted = 0, updated = 0;
for (const { entry } of entries) {
  const fields = {
    name: entry.name.trim(),
    aliases: entry.aliases,
    body_part: entry.body_part,
    primary_muscles: entry.primary_muscles,
    secondary_muscles: entry.secondary_muscles,
    equipment: entry.equipment,
    mechanics: entry.mechanics,
    movement_pattern: entry.movement_pattern,
    source: "catalog",
  };
  const id = idByNameKey.get(entry.name.trim().toLowerCase());
  if (id) {
    const { error } = await supabase.from("exercises").update(fields).eq("id", id);
    if (error) throw new Error(`update "${entry.name}": ${error.message}`);
    updated++;
  } else {
    const { error } = await supabase.from("exercises").insert(fields);
    if (error) throw new Error(`insert "${entry.name}": ${error.message}`);
    inserted++;
  }
}
console.log(`seeded: ${inserted} inserted, ${updated} updated`);
