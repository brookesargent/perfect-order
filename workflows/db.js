// The ingest pipeline's own Postgres connection. Writes to the SAME database
// (DATABASE_URL) and the SAME `restaurants` table as the app — convergence with
// organic rows happens purely via the shared dedup_key. We intentionally do NOT
// import the app's db.js (it owns the app's lifecycle/pool); we only borrow the
// one piece that must match exactly: normalizeKey.

import pg from 'pg';

import { normalizeKey } from '../shared/normalizeKey.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

// Same SSL rule as the app's db.js: only the EXTERNAL Render host (.render.com)
// needs SSL. Running inside Render we use the INTERNAL url (no SSL, fast).
function sslConfig(url) {
  if (!url) return false;
  if (url.includes('.render.com')) return { rejectUnauthorized: false };
  return false;
}

const pool = connectionString
  ? new Pool({ connectionString, ssl: sslConfig(connectionString) })
  : null;

export function isDbReady() {
  return Boolean(pool);
}

// UPSERT a batch of ingested identity rows. Conservative on conflict by design:
//   - never names order_data, so an organic row's composed menu is untouched;
//   - WHERE restaurants.source = 'ingest' means we ONLY refresh rows we own —
//     an existing web_search/manual row is left completely alone (no demotion,
//     no identity stomping). A fresh key inserts as source='ingest'.
// Returns the number of statements that inserted-or-updated a row.
export async function upsertBatch(rows) {
  if (!pool) throw new Error('DATABASE_URL not set — cannot ingest');
  let affected = 0;
  for (const { name, location = '', cuisine = '', osmId = null } of rows) {
    const key = normalizeKey(name, location);
    const { rowCount } = await pool.query(
      `INSERT INTO restaurants (dedup_key, name, location, cuisine, source, osm_id)
       VALUES ($1, $2, $3, $4, 'ingest', $5)
       ON CONFLICT (dedup_key) DO UPDATE
          SET name = EXCLUDED.name,
              location = EXCLUDED.location,
              cuisine = COALESCE(NULLIF(EXCLUDED.cuisine, ''), restaurants.cuisine),
              osm_id = COALESCE(EXCLUDED.osm_id, restaurants.osm_id),
              updated_at = now()
        WHERE restaurants.source = 'ingest'`,
      [key, name, location, cuisine, osmId]
    );
    affected += rowCount;
  }
  return affected;
}

// Release the pool so the task process can exit cleanly.
export async function closePool() {
  if (pool) await pool.end();
}
