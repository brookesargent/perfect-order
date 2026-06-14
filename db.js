import pg from 'pg';

import { normalizeKey } from './shared/normalizeKey.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

// SSL decision — this is the #1 Render Postgres gotcha:
//   - Render's INTERNAL connection string (what render.yaml injects via
//     `fromDatabase`) has a short hostname like `dpg-xxxx-a` and does NOT use SSL.
//   - Render's EXTERNAL connection string (what you copy for local dev) ends in
//     `.render.com` and DOES require SSL.
//   - A local Postgres (`localhost`) needs no SSL.
// So we turn SSL on only for the external Render host.
function sslConfig(url) {
  if (!url) return false;
  if (url.includes('.render.com')) return { rejectUnauthorized: false };
  return false;
}

const pool = connectionString
  ? new Pool({ connectionString, ssl: sslConfig(connectionString) })
  : null;

let ready = false;
export const isDbReady = () => ready;

// The whole schema for v1: one table holding the restaurant + the generated
// order blob (JSONB) + a timestamp. Kept idempotent so it's safe to run on
// every boot. See migrate.js for the same call as a standalone step.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS saved_orders (
  id          SERIAL PRIMARY KEY,
  restaurant  TEXT NOT NULL,
  order_data  JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// --- Catalog cache (read-through). saved_orders above is untouched. ---------

// Second idempotent table — same boot-time CREATE-IF-NOT-EXISTS contract as
// saved_orders, so it self-heals on deploy and needs no separate migration step.
// One row per restaurant, keyed by a normalized dedup_key, holding cached
// identity plus the composed order blob. Sets up the later Workflows backfill,
// which will write the same columns with source = 'ingest'.
const RESTAURANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS restaurants (
  id               SERIAL PRIMARY KEY,
  dedup_key        TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  location         TEXT NOT NULL DEFAULT '',
  cuisine          TEXT NOT NULL DEFAULT '',
  order_data       JSONB,
  source           TEXT NOT NULL DEFAULT 'web_search',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_composed_at TIMESTAMPTZ
);
`;

export async function initDb() {
  if (!pool) {
    console.warn('[db] DATABASE_URL not set — saved-orders features are disabled.');
    return false;
  }
  try {
    await pool.query(SCHEMA);
    await pool.query(RESTAURANTS_SCHEMA);
    // Idempotent column add for the saved-order rating (1–5, null = unrated).
    // Safe to run every boot; no separate migration step needed.
    await pool.query(`ALTER TABLE saved_orders ADD COLUMN IF NOT EXISTS rating SMALLINT;`);
    // Idempotent column add for the OSM identifier on ingested rows (e.g.
    // "way/12345"). Null for organic web_search/manual rows; populated by the
    // Workflows bulk-ingest pipeline (workflows/) as a stable external id.
    await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS osm_id TEXT;`);
    ready = true;
    console.log('[db] connected; schema ready.');
    return true;
  } catch (err) {
    // Non-fatal on purpose: the app should still boot and serve the AI flow even
    // if the database isn't wired up yet. Lets you deploy the web service first,
    // see it work, then add Postgres and watch saved-orders light up.
    console.error('[db] init failed — saved-orders features disabled:', err.message);
    return false;
  }
}

export async function saveOrder(restaurant, order) {
  const { rows } = await pool.query(
    `INSERT INTO saved_orders (restaurant, order_data)
     VALUES ($1, $2)
     RETURNING id, restaurant, order_data, created_at`,
    [restaurant, JSON.stringify(order)]
  );
  return rows[0];
}

export async function listOrders() {
  const { rows } = await pool.query(
    `SELECT id, restaurant, order_data, rating, created_at
       FROM saved_orders
   ORDER BY created_at DESC
      LIMIT 50`
  );
  return rows;
}

export async function deleteOrder(id) {
  const { rowCount } = await pool.query(
    `DELETE FROM saved_orders WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}

export async function setOrderRating(id, rating) {
  const { rowCount } = await pool.query(
    `UPDATE saved_orders SET rating = $2 WHERE id = $1`,
    [id, rating]
  );
  return rowCount > 0;
}

// --- Catalog cache reads/writes --------------------------------------------

// Find-cache, two tiers: exact city-qualified key first, then a name-prefix
// fan-out for bare queries ("mios" → every Mio's we've seen). Returns up to 3
// candidates in the same shape findRestaurants() produces, so callers can treat
// cache and live results identically.
export async function findCachedCandidates(query, location = '') {
  const key = normalizeKey(query, location);
  const namePrefix = key.split('|')[0];
  const { rows } = await pool.query(
    `SELECT name, location, cuisine
       FROM restaurants
      WHERE dedup_key = $1
         OR split_part(dedup_key, '|', 1) LIKE $2
   ORDER BY (dedup_key = $1) DESC, updated_at DESC
      LIMIT 3`,
    [key, `${namePrefix}%`]
  );
  return rows.map((r) => ({
    name: r.name,
    location: r.location,
    cuisine: r.cuisine,
    grounded: true,
  }));
}

// Order-cache. Returns cached order_data only if present AND composed within
// maxAgeDays; otherwise null so the caller composes fresh. Identity-only rows
// (order_data IS NULL) count as a miss.
export async function getCachedOrder(name, location = '', maxAgeDays = 30) {
  const key = normalizeKey(name, location);
  const { rows } = await pool.query(
    `SELECT order_data
       FROM restaurants
      WHERE dedup_key = $1
        AND order_data IS NOT NULL
        AND last_composed_at > now() - ($2 || ' days')::interval`,
    [key, String(maxAgeDays)]
  );
  return rows[0]?.order_data ?? null;
}

// UPSERT a found candidate's identity (from /api/find). Never clobbers an
// existing order_data; just refreshes identity fields + updated_at.
export async function upsertRestaurant({ name, location = '', cuisine = '', source = 'web_search' }) {
  const key = normalizeKey(name, location);
  await pool.query(
    `INSERT INTO restaurants (dedup_key, name, location, cuisine, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedup_key) DO UPDATE
        SET name = EXCLUDED.name,
            location = EXCLUDED.location,
            cuisine = EXCLUDED.cuisine,
            updated_at = now()`,
    [key, name, location, cuisine, source]
  );
}

// UPSERT a freshly composed order onto its restaurant row (from /api/generate).
// Creates the row if find never ran for it (e.g. a bare-string restaurant); also
// refreshes stale entries since it overwrites order_data + last_composed_at.
// Leaves source untouched on conflict so a future 'ingest' row isn't demoted.
export async function upsertOrder(name, location = '', cuisine = '', order, source = 'web_search') {
  const key = normalizeKey(name, location);
  await pool.query(
    `INSERT INTO restaurants (dedup_key, name, location, cuisine, order_data, source, last_composed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (dedup_key) DO UPDATE
        SET order_data = EXCLUDED.order_data,
            last_composed_at = now(),
            updated_at = now()`,
    [key, name, location, cuisine, JSON.stringify(order), source]
  );
}
