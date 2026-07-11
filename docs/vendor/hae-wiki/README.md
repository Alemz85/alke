# Vendored Health Auto Export wiki (do not edit by hand)

Verbatim copies of the upstream wiki pages, fetched **2026-07-10** from
https://github.com/Lybron/health-auto-export/wiki. Kept locally so sessions can
grep/Read the export-format reference without a network fetch. Private repo only —
do not republish.

Refresh with:

```sh
for p in "Home" "API-Export---JSON-Format" "Supported-Data" "Configuration-&-Deep-Linking"; do
  curl -sL "https://raw.githubusercontent.com/wiki/Lybron/health-auto-export/${p}.md" \
    -o "docs/vendor/hae-wiki/${p}.md"
done
```

Three standing caveats:

1. **Real payloads outrank these docs.** The docs have been incomplete/behind the
   app before; `raw_payloads` in the DB is ground truth, and `FIELD_MAP` in
   `supabase/functions/ingest/parse.ts` records what the app actually sends.
2. **Observed behavior not in these docs**: automations on "Since Last Sync" can
   re-send *shrunken* partial aggregates of the same night's sleep (ingest merges
   sleep keep-most-complete for this reason); "Default" date range re-sends the
   full previous day + today on every sync. Settings semantics live at
   https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/ (not
   vendored — HTML help site, check live when needed).
3. **Documented swim fields that never arrive**: `strokeStyle` and `swolfScore`
   are listed for workouts v2 but were absent from every real payload received
   to date (checked 2026-07-11 across all `raw_payloads` pool swims). Stroke
   style is therefore unknown to the platform, and SWOLF is computed from the
   `swimDistance`/`swimStroke` per-second series instead (see `swim_sets`).
