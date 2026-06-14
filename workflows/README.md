# Catalog bulk-ingest (Render Workflows)

Proactively fills the live `restaurants` catalog from OpenStreetMap so common
spots are already cached before anyone searches them (the Beli/Storygraph model).

**What it does:** `ingestMetro` tiles a metro's bounding box and fans out to
`ingestTile`, which queries the Overpass API for `amenity=restaurant`, maps OSM
tags to our columns, and UPSERTs **identity-only** rows (`source='ingest'`,
`order_data` left `NULL`). Orders still compose lazily on first request via the
app's existing cache-miss path — we do **not** compose menus up front.

**Why OpenStreetMap/Overpass:** free, no API key, and the OSM license **permits
persisting** the data into our own catalog. Google Places / Yelp ToS restrict
storing/caching place data, which disqualifies them for a durable catalog. The
tradeoff: OSM coverage and address completeness are uneven (see Risks).

This is a **separate service** from the web app. It shares the same Postgres and
the same `restaurants` table; ingested rows converge with organic `web_search`
rows because both compute `dedup_key` with the **same** `shared/normalizeKey.js`.

---

## What you do on Render (the clicks)

> Render Workflows is in **public beta**. The exact `render.yaml` service `type`
> for workflows can change during beta — if the blueprint block below is rejected,
> use the **Dashboard path** instead (it's the primary, reliable path) and check
> the current blueprint spec: https://render.com/docs/blueprint-spec

### Option A — Dashboard (recommended for the first run)

1. **New > Workflow** (beta). Connect this repo.
2. **Root Directory:** `workflows`
   **Build Command:** `npm install`
   **Start Command:** `npm start`
   **Runtime:** Node · **Node version:** 20
3. **Environment variables** — add one:
   - `DATABASE_URL` → use **Add from Database** and select `perfect-order-db`,
     property **Internal Connection String** (internal = no SSL, fast private
     network; same DB the web app already uses).
   - *(optional)* `OVERPASS_USER_AGENT` — a contact string Overpass ops can reach
     you at. A sensible default is baked in if you skip it.
4. **Create** the service and let it deploy. Render auto-discovers the two tasks
   (`ingestMetro`, `ingestTile`) from the SDK.

### Option B — Blueprint (render.yaml) — add this service block

Add alongside the existing `web` service in `render.yaml` (the `databases:` block
already exists; reuse it). **Confirm `type` against the current beta spec** before
relying on this:

```yaml
  - type: workflow            # beta — verify against https://render.com/docs/blueprint-spec
    name: perfect-order-ingest
    runtime: node
    plan: starter
    region: oregon            # MUST match the database's region for internal networking
    rootDir: workflows
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: perfect-order-db
          property: connectionString   # internal URL — no SSL
      - key: NODE_VERSION
        value: "20"
```

---

## Run the first Cincinnati ingest

1. Open the **perfect-order-ingest** service → **Tasks** tab.
2. Click **`ingestMetro`** → **Start Task**.
3. **Input** is a JSON array of the function's arguments. `ingestMetro` defaults
   to Cincinnati when called with no argument, so pass an empty array:

   ```json
   []
   ```

   (You never need to paste the bbox — Cincinnati's box lives in
   `workflows/config.js`.)
4. Watch the run. You'll see ~16 `ingestTile` child runs (a 4×4 grid),
   sequential with a ~1.5s pause between them. Total runtime is a few minutes.
   The final `ingestMetro` result looks like:

   ```json
   { "city": "Cincinnati", "tiles": 16, "elements": 1900, "upserted": 1700 }
   ```

*(SDK trigger alternative, if you'd rather script it: with `RENDER_API_KEY` set,
`new Render({}).workflows.startTask("perfect-order-ingest/ingestMetro", [])`.)*

---

## Confirm success (slice-1 criteria)

Run these against the database (Render dashboard → the DB → **Connect** →
PSQL, or any SQL client on the external URL):

1. **Volume** — expect ~1,500–2,500 ingested rows:
   ```sql
   SELECT count(*) FROM restaurants WHERE source = 'ingest';
   ```
2. **Spot-check** known Cincinnati spots — present, sane fields, `order_data` NULL:
   ```sql
   SELECT name, location, cuisine, source, osm_id, order_data IS NULL AS no_order
     FROM restaurants
    WHERE source = 'ingest'
    ORDER BY random() LIMIT 10;
   ```
3. **Convergence — no duplicates, organic rows untouched.** Pick a restaurant
   that already has an organic `web_search` row and confirm ingest did NOT create
   a second row for it and did NOT alter it (same `id`, `order_data` intact,
   `source` still `web_search`):
   ```sql
   SELECT dedup_key, count(*) FROM restaurants
    GROUP BY dedup_key HAVING count(*) > 1;   -- expect ZERO rows
   ```
4. **End-to-end lazy compose** — in the app, search an ingested restaurant that
   has no order yet. It composes once via the normal miss path (~50s), fills
   `order_data` + `last_composed_at`; a second request returns instantly.
5. **Idempotent re-run** — trigger `ingestMetro []` again; the row count from (1)
   stays stable (no duplicates, conflicts just refresh ingest-owned rows).

---

## Notes / limits

- **Identity-only:** ingest never calls the LLM; `$0` data cost (Overpass is free),
  only short compute for the run.
- **Conservative upsert:** the `ON CONFLICT` clause never names `order_data` and
  is guarded by `WHERE restaurants.source = 'ingest'`, so it only ever refreshes
  rows it created — it cannot demote or overwrite organic/manual rows.
- **Not self-scheduling:** Workflows don't cron themselves. To re-ingest on a
  cadence later, add a separate **Render Cron Job** whose command triggers
  `ingestMetro`. Deferred — first slice is a manual run.
- **Adding metros later** is a data change in `workflows/config.js`, not code.
