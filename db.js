import pg from 'pg';

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

export async function initDb() {
  if (!pool) {
    console.warn('[db] DATABASE_URL not set — saved-orders features are disabled.');
    return false;
  }
  try {
    await pool.query(SCHEMA);
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
    `SELECT id, restaurant, order_data, created_at
       FROM saved_orders
   ORDER BY created_at DESC
      LIMIT 50`
  );
  return rows;
}
