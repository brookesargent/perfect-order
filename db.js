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

// --- Users (Phase 1 auth shadow table). -------------------------------------

// A shadow of WorkOS users — WorkOS owns identity; we mirror just enough to join
// future per-user data against (Phase 2). Phase 1 only fills this on login; it
// does NOT gate or scope any existing feature. Same idempotent boot contract.
const USERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  workos_id   TEXT NOT NULL UNIQUE,
  email       TEXT,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
    await pool.query(USERS_SCHEMA);
    // Phase 2: turn saved_orders into a per-user log. Idempotent column adds,
    // same boot contract. user_id is nullable: pre-Phase-2 global rows stay but
    // become orphaned (invisible under per-user scoping) — we don't backfill.
    // status drives the suggested→ordered lifecycle; rating is gated to 'ordered'.
    await pool.query(`ALTER TABLE saved_orders ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);`);
    await pool.query(`ALTER TABLE saved_orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'suggested';`);
    await pool.query(`ALTER TABLE saved_orders ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE saved_orders ADD COLUMN IF NOT EXISTS notes TEXT;`);
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

// The columns every order read returns — the frontend's row contract.
const ORDER_COLS = 'id, restaurant, order_data, status, ordered_at, notes, rating, created_at';

// Save a generated order as a suggestion for this user (status 'suggested').
export async function saveOrder(userId, restaurant, order) {
  const { rows } = await pool.query(
    `INSERT INTO saved_orders (user_id, restaurant, order_data, status)
     VALUES ($1, $2, $3, 'suggested')
     RETURNING ${ORDER_COLS}`,
    [userId, restaurant, JSON.stringify(order)]
  );
  return rows[0];
}

// Manually log an order the user actually had (status 'ordered'). order_data is
// pinned to { items: [string, ...] }. ordered_at defaults to now() when omitted.
export async function logOrder(userId, restaurant, items, orderedAt = null, notes = null) {
  const { rows } = await pool.query(
    `INSERT INTO saved_orders (user_id, restaurant, order_data, status, ordered_at, notes)
     VALUES ($1, $2, $3, 'ordered', COALESCE($4, now()), $5)
     RETURNING ${ORDER_COLS}`,
    [userId, restaurant, JSON.stringify({ items }), orderedAt, notes]
  );
  return rows[0];
}

// This user's orders, newest first.
export async function listOrders(userId) {
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLS}
       FROM saved_orders
      WHERE user_id = $1
   ORDER BY created_at DESC
      LIMIT 50`,
    [userId]
  );
  return rows;
}

// Fetch one order, but only if it belongs to this user. Returns the row or null
// (the caller turns null into a 404 — never reveals another user's row).
export async function getOrder(userId, id) {
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLS} FROM saved_orders WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

// Delete one of this user's orders. Returns true if a row was actually removed.
export async function deleteOrder(userId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM saved_orders WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rowCount > 0;
}

// Mark a suggestion as ordered. Sets ordered_at to now() only if not already set
// (manual re-marks shouldn't move the timestamp). Returns the updated row or null.
export async function markOrdered(userId, id) {
  const { rows } = await pool.query(
    `UPDATE saved_orders
        SET status = 'ordered',
            ordered_at = COALESCE(ordered_at, now())
      WHERE id = $1 AND user_id = $2
  RETURNING ${ORDER_COLS}`,
    [id, userId]
  );
  return rows[0] || null;
}

// Update the free-text notes on one of this user's orders. Returns the row or null.
export async function setNotes(userId, id, notes) {
  const { rows } = await pool.query(
    `UPDATE saved_orders SET notes = $3 WHERE id = $1 AND user_id = $2
  RETURNING ${ORDER_COLS}`,
    [id, userId, notes]
  );
  return rows[0] || null;
}

// Rate one of this user's orders 1–5 — but only if it's been 'ordered'. Returns
// 'not_found' | 'not_ordered' | the updated row, so the route can map to 404/409.
export async function setOrderRating(userId, id, rating) {
  const existing = await getOrder(userId, id);
  if (!existing) return 'not_found';
  if (existing.status !== 'ordered') return 'not_ordered';
  const { rows } = await pool.query(
    `UPDATE saved_orders SET rating = $3 WHERE id = $1 AND user_id = $2
  RETURNING ${ORDER_COLS}`,
    [id, userId, rating]
  );
  return rows[0];
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

// --- Users ------------------------------------------------------------------

// UPSERT a WorkOS user into our shadow table on login, keyed by workos_id.
// Refreshes email/name on every login so they stay current. Returns the local
// row. Phase 1 only records the user; nothing reads it to scope features yet.
export async function upsertUser({ workos_id, email = null, name = null }) {
  const { rows } = await pool.query(
    `INSERT INTO users (workos_id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (workos_id) DO UPDATE
        SET email = EXCLUDED.email,
            name = EXCLUDED.name
     RETURNING id, workos_id, email, name, created_at`,
    [workos_id, email, name]
  );
  return rows[0];
}

// Look up the local users row for a WorkOS id. Used per-request by the session
// middleware to resolve the validated WorkOS user into our row (whose integer id
// scopes saved_orders). Returns the row or null.
export async function getUserByWorkosId(workos_id) {
  const { rows } = await pool.query(
    `SELECT id, workos_id, email, name, created_at FROM users WHERE workos_id = $1`,
    [workos_id]
  );
  return rows[0] || null;
}
