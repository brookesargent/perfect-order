import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, isDbReady, saveOrder, listOrders } from './db.js';
import { composeOrder } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Serve the frontend (public/) as static files from the same service.
app.use(express.static(join(__dirname, 'public')));

// Health check — Render hits this to gate deploys (see healthCheckPath in render.yaml).
app.get('/healthz', (_req, res) => res.json({ ok: true, db: isDbReady() }));

// Generate an order. Does NOT save — the user decides whether to keep it.
app.post('/api/generate', async (req, res) => {
  const restaurant = (req.body?.restaurant || '').trim();
  if (!restaurant) return res.status(400).json({ error: 'restaurant is required' });
  const order = await composeOrder(restaurant);
  res.json(order);
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

// Render injects PORT — bind to it, and to 0.0.0.0 so the container is reachable.
// (Binding only to localhost is a classic "deploy succeeds but health check fails" trap.)
const PORT = process.env.PORT || 3000;

// Try to set up the DB, then start listening regardless of the outcome.
initDb().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  });
});
