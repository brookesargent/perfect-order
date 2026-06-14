import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  initDb, isDbReady, saveOrder, listOrders, deleteOrder, setOrderRating,
  findCachedCandidates, getCachedOrder, upsertRestaurant, upsertOrder,
  upsertUser,
} from './db.js';
import { composeOrder, findRestaurants } from './llm.js';
import {
  isAuthConfigured, getAuthorizationUrl, authenticateWithCode, getUserFromCookie,
  getLogoutUrl, toPublicUser, SESSION_COOKIE, COOKIE_OPTIONS,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// An order is "fresh enough" if it was composed within this window; otherwise a
// /api/generate request recomposes and overwrites the cached entry.
const CACHE_TTL_DAYS = 30;

const app = express();
app.use(express.json());
app.use(cookieParser());

// Session middleware: when auth is configured, unseal the session cookie and
// hang the current user off req.user (null if absent/invalid). Used by /api/me
// now; Phase 2 will read it to scope per-user data. Never blocks the request —
// when auth is unconfigured this is a no-op and the app behaves exactly as today.
app.use(async (req, _res, next) => {
  req.user = null;
  if (isAuthConfigured()) {
    const sessionData = req.cookies?.[SESSION_COOKIE];
    req.user = await getUserFromCookie(sessionData);
  }
  next();
});

// Serve the frontend (public/) as static files from the same service.
app.use(express.static(join(__dirname, 'public')));

// Health check — Render hits this to gate deploys (see healthCheckPath in render.yaml).
app.get('/healthz', (_req, res) => res.json({ ok: true, db: isDbReady() }));

// --- Auth (Phase 1: AuthKit login/logout + shadow users table) -------------
// All routes degrade gracefully when WorkOS env vars are unset, mirroring the
// DATABASE_URL/ANTHROPIC handling: nothing crashes, the app works as today.

// Current user for the frontend. SHAPE IS A CONTRACT: {user: {id, email, name}}
// when signed in, {user: null} otherwise (including when auth is unconfigured).
app.get('/api/me', (req, res) => {
  res.json({ user: toPublicUser(req.user) });
});

// Kick off hosted login — redirect to the AuthKit authorization URL.
app.get('/auth/login', (_req, res) => {
  if (!isAuthConfigured()) {
    return res.status(503).json({ error: 'Authentication is not configured' });
  }
  res.redirect(getAuthorizationUrl());
});

// AuthKit redirect target: exchange the code, seal the session into an httpOnly
// cookie, mirror the user into our table, then land back on the app.
app.get('/auth/callback', async (req, res) => {
  if (!isAuthConfigured()) {
    return res.status(503).json({ error: 'Authentication is not configured' });
  }
  const code = (req.query?.code || '').toString();
  if (!code) return res.status(400).json({ error: 'code is required' });
  try {
    const { user, sealedSession } = await authenticateWithCode(code);
    res.cookie(SESSION_COOKIE, sealedSession, COOKIE_OPTIONS);
    // Mirror the user into our shadow table. Non-fatal: a DB hiccup shouldn't
    // block login — the session cookie is already set.
    if (isDbReady()) {
      upsertUser({
        workos_id: user.id,
        email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      }).catch((err) => console.error('[auth] user upsert failed:', err.message));
    }
    res.redirect('/');
  } catch (err) {
    console.error('[auth] callback failed:', err.message);
    res.redirect('/');
  }
});

// Clear the session cookie and send the user to the WorkOS hosted logout (which
// ends the WorkOS session and redirects back), or home if we can't build it.
app.get('/auth/logout', async (req, res) => {
  const sessionData = req.cookies?.[SESSION_COOKIE];
  const logoutUrl = isAuthConfigured() ? await getLogoutUrl(sessionData) : null;
  res.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
  res.redirect(logoutUrl || '/');
});

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
