import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  initDb, isDbReady, saveOrder, logOrder, listOrders, deleteOrder,
  markOrdered, setNotes, setOrderRating,
  findCachedCandidates, getCachedOrder, upsertRestaurant, upsertOrder,
  upsertUser, getUserByWorkosId,
} from './db.js';
import { composeOrder, findRestaurants } from './llm.js';
import {
  isAuthConfigured, getAuthorizationUrl, authenticateWithCode, getUserFromCookie,
  getLogoutUrl, requireAuth, SESSION_COOKIE, COOKIE_OPTIONS,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// An order is "fresh enough" if it was composed within this window; otherwise a
// /api/generate request recomposes and overwrites the cached entry.
const CACHE_TTL_DAYS = 30;

const app = express();
app.use(express.json());
app.use(cookieParser());

// Session middleware: when auth is configured, unseal the session cookie, then
// resolve the validated WorkOS user into our LOCAL users row — req.user is that
// row (null if logged out / invalid / DB down), so req.user.id is the integer
// that scopes saved_orders. Never blocks the request: when auth is unconfigured
// (or the DB is down) this leaves req.user null and the app behaves as today.
app.use(async (req, _res, next) => {
  req.user = null;
  if (isAuthConfigured()) {
    const sessionData = req.cookies?.[SESSION_COOKIE];
    const wosUser = await getUserFromCookie(sessionData);
    if (wosUser && isDbReady()) {
      try {
        req.user = await getUserByWorkosId(wosUser.id);
      } catch (err) {
        console.error('[auth] user lookup failed — treating as logged out:', err.message);
      }
    }
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
// req.user is the local users row, so we project to the public {id, email, name}.
app.get('/api/me', (req, res) => {
  const u = req.user;
  res.json({ user: u ? { id: u.id, email: u.email, name: u.name } : null });
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

// --- Orders (Phase 2: per-user log). Every endpoint requires a logged-in user
// (requireAuth → 401) and is scoped to req.user.id; you only ever touch your own
// rows. find/generate above stay open — suggestions are for everyone.

// List the current user's orders, newest first.
app.get('/api/orders', requireAuth, async (req, res) => {
  if (!isDbReady()) return res.json([]);
  try {
    res.json(await listOrders(req.user.id));
  } catch (err) {
    console.error('[api] list failed:', err.message);
    res.status(500).json({ error: 'Could not list orders' });
  }
});

// Save a generated order as a suggestion (status 'suggested').
app.post('/api/orders', requireAuth, async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  const { restaurant, order } = req.body || {};
  if (!restaurant || !order) {
    return res.status(400).json({ error: 'restaurant and order are required' });
  }
  try {
    const saved = await saveOrder(req.user.id, restaurant, order);
    res.status(201).json(saved);
  } catch (err) {
    console.error('[api] save failed:', err.message);
    res.status(500).json({ error: 'Could not save order' });
  }
});

// Manually log an order the user actually had (status 'ordered'). order_data is
// pinned to { items: [string, ...] }; ordered_at defaults to now() if omitted.
app.post('/api/orders/log', requireAuth, async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  const { restaurant, items, ordered_at, notes } = req.body || {};
  if (!restaurant || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'restaurant and a non-empty items array are required' });
  }
  if (!items.every((i) => typeof i === 'string')) {
    return res.status(400).json({ error: 'items must be an array of strings' });
  }
  try {
    const logged = await logOrder(req.user.id, restaurant, items, ordered_at || null, notes || null);
    res.status(201).json(logged);
  } catch (err) {
    console.error('[api] log failed:', err.message);
    res.status(500).json({ error: 'Could not log order' });
  }
});

// Promote a suggestion to 'ordered' (sets ordered_at if not already set).
app.patch('/api/orders/:id/mark-ordered', requireAuth, async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  try {
    const updated = await markOrdered(req.user.id, req.params.id);
    if (!updated) return res.status(404).json({ error: 'Order not found' });
    res.json(updated);
  } catch (err) {
    console.error('[api] mark-ordered failed:', err.message);
    res.status(500).json({ error: 'Could not mark order as ordered' });
  }
});

// Rate an order 1–5 — only allowed once it's been 'ordered' (else 409).
app.patch('/api/orders/:id/rating', requireAuth, async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  const { rating } = req.body || {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer from 1 to 5' });
  }
  try {
    const result = await setOrderRating(req.user.id, req.params.id, rating);
    if (result === 'not_found') return res.status(404).json({ error: 'Order not found' });
    if (result === 'not_ordered') {
      return res.status(409).json({ error: 'Only ordered items can be rated' });
    }
    res.json(result);
  } catch (err) {
    console.error('[api] rating failed:', err.message);
    res.status(500).json({ error: 'Could not rate order' });
  }
});

// Update the free-text notes on an order.
app.patch('/api/orders/:id', requireAuth, async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  const { notes } = req.body || {};
  if (typeof notes !== 'string') {
    return res.status(400).json({ error: 'notes must be a string' });
  }
  try {
    const updated = await setNotes(req.user.id, req.params.id, notes);
    if (!updated) return res.status(404).json({ error: 'Order not found' });
    res.json(updated);
  } catch (err) {
    console.error('[api] notes failed:', err.message);
    res.status(500).json({ error: 'Could not update notes' });
  }
});

// Delete one of the current user's orders. 204 on success, 404 if not found/owned.
app.delete('/api/orders/:id', requireAuth, async (req, res) => {
  if (!isDbReady()) return res.status(503).json({ error: 'Database not available yet' });
  try {
    const deleted = await deleteOrder(req.user.id, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Order not found' });
    res.status(204).end();
  } catch (err) {
    console.error('[api] delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete order' });
  }
});

// Render injects PORT — bind to it, and to 0.0.0.0 so the container is reachable.
// (Binding only to localhost is a classic "deploy succeeds but health check fails" trap.)
const PORT = process.env.PORT || 3000;

// Optional keep-warm: free instances spin down after ~15 min idle, and the
// cold start (~50-80s) is what makes a first compose feel like it hangs. When
// KEEP_WARM is set we self-ping our own public URL just under that window so
// the instance stays awake. OFF by default — a 24/7 ping burns the free tier's
// 750 instance-hours/month, so flip it on only around demos (or move to a paid
// instance, which removes spin-down entirely).
function startKeepWarm() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!process.env.KEEP_WARM || !url) return;
  const ping = () => fetch(`${url}/healthz`).catch(() => {});
  setInterval(ping, 10 * 60 * 1000);
  console.log(`[server] keep-warm enabled — pinging ${url}/healthz every 10m`);
}

// Try to set up the DB, then start listening regardless of the outcome.
initDb().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
    startKeepWarm();
  });
});
