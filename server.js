import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  initDb, isDbReady, saveOrder, listOrders, deleteOrder, setOrderRating,
  findCachedCandidates, getCachedOrder, upsertRestaurant, upsertOrder,
} from './db.js';
import { composeOrder, findRestaurants } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// An order is "fresh enough" if it was composed within this window; otherwise a
// /api/generate request recomposes and overwrites the cached entry.
const CACHE_TTL_DAYS = 30;

const app = express();
app.use(express.json());

// Serve the frontend (public/) as static files from the same service.
app.use(express.static(join(__dirname, 'public')));

// Health check — Render hits this to gate deploys (see healthCheckPath in render.yaml).
app.get('/healthz', (_req, res) => res.json({ ok: true, db: isDbReady() }));

// Step 1: find + disambiguate the restaurant via web search. Returns up to a
// few candidates for the user to confirm (solves "which Mio's did you mean?").
app.post('/api/find', async (req, res) => {
  const query = (req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });

  // Read-through: try the catalog first. A cache hit skips the ~50s web search.
  // Any DB hiccup just falls through to the live search — caching is never fatal.
  if (isDbReady()) {
    try {
      const cached = await findCachedCandidates(query);
      if (cached.length > 0) return res.json({ candidates: cached, source: 'cache' });
    } catch (err) {
      console.error('[cache] find lookup failed — falling through to search:', err.message);
    }
  }

  const candidates = await findRestaurants(query);

  // Backfill the catalog with what we found (only grounded, real matches — not
  // the bare-query fallback). Fire-and-forget: we still return the candidates.
  if (isDbReady()) {
    for (const c of candidates) {
      if (!c.grounded) continue;
      upsertRestaurant(c).catch((err) => console.error('[cache] find upsert failed:', err.message));
    }
  }

  res.json({ candidates, source: 'web_search' });
});

// Step 2: compose an order for the confirmed restaurant, grounded in its real
// menu via web search. Does NOT save. `restaurant` is the confirmed candidate
// object ({name, location, cuisine}); a bare string is also accepted.
app.post('/api/generate', async (req, res) => {
  const { restaurant } = req.body || {};
  const r = typeof restaurant === 'string' ? { name: restaurant.trim() } : (restaurant || {});
  const name = (r.name || '').trim();
  if (!name) return res.status(400).json({ error: 'restaurant is required' });

  // Read-through: serve a cached order if we have a fresh one. The cached blob
  // already carries restaurant/location/cuisine, so a hit is fully self-contained.
  if (isDbReady()) {
    try {
      const cached = await getCachedOrder(name, r.location, CACHE_TTL_DAYS);
      if (cached) return res.json({ ...cached, source: 'cache' });
    } catch (err) {
      console.error('[cache] order lookup failed — falling through to compose:', err.message);
    }
  }

  const order = await composeOrder(restaurant);

  // Write-through: cache the composed order (also refreshes stale entries, since
  // upsertOrder overwrites order_data + last_composed_at). Never cache fallbacks
  // — they're canned placeholders, not a real grounded menu.
  if (isDbReady() && !order.fallback) {
    upsertOrder(name, r.location, r.cuisine, order, 'web_search')
      .catch((err) => console.error('[cache] order upsert failed:', err.message));
  }

  res.json({ ...order, source: 'web_search' });
});

// Save a generated order (global/shared — no users in v1).
app.post('/api/orders', async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  const { restaurant, order } = req.body || {};
  if (!restaurant || !order) {
    return res.status(400).json({ error: 'restaurant and order are required' });
  }
  try {
    const saved = await saveOrder(restaurant, order);
    res.status(201).json(saved);
  } catch (err) {
    console.error('[api] save failed:', err.message);
    res.status(500).json({ error: 'Could not save order' });
  }
});

// List saved orders, newest first. Returns [] when the DB isn't wired up yet so
// the page still loads cleanly during the first deploy.
app.get('/api/orders', async (_req, res) => {
  if (!isDbReady()) return res.json([]);
  try {
    res.json(await listOrders());
  } catch (err) {
    console.error('[api] list failed:', err.message);
    res.status(500).json({ error: 'Could not list orders' });
  }
});

// Delete a saved order by id. 204 on success, 404 if it didn't exist.
app.delete('/api/orders/:id', async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  try {
    const deleted = await deleteOrder(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Order not found' });
    res.status(204).end();
  } catch (err) {
    console.error('[api] delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete order' });
  }
});

// Rate a saved order 1–5. 204 on success, 404 if no such order.
app.patch('/api/orders/:id/rating', async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  const { rating } = req.body || {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer from 1 to 5' });
  }
  try {
    const updated = await setOrderRating(req.params.id, rating);
    if (!updated) return res.status(404).json({ error: 'Order not found' });
    res.status(204).end();
  } catch (err) {
    console.error('[api] rating failed:', err.message);
    res.status(500).json({ error: 'Could not rate order' });
  }
});

// Render injects PORT — bind to it, and to 0.0.0.0 so the container is reachable.
// (Binding only to localhost is a classic "deploy succeeds but health check fails" trap.)
const PORT = process.env.PORT || 3000;

// Try to set up the DB, then start listening regardless of the outcome.
initDb().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  });
});
