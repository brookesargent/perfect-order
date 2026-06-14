import { WorkOS } from '@workos-inc/node';

// WorkOS AuthKit (hosted login) with the stateless sealed-session cookie pattern
// — no session store, which suits a single free Render instance. Phase 1 only
// adds auth + a shadow users table; it does NOT gate any existing feature.
//
// Graceful disable, same philosophy as DATABASE_URL/ANTHROPIC_API_KEY: auth is
// only "on" when all four env vars are present. When any is missing the app boots
// and behaves EXACTLY as today — /api/me reports no user, /auth/login 503s.
const apiKey = process.env.WORKOS_API_KEY;
const clientId = process.env.WORKOS_CLIENT_ID;
const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD;
const redirectUri = process.env.WORKOS_REDIRECT_URI;

export function isAuthConfigured() {
  return Boolean(apiKey && clientId && cookiePassword && redirectUri);
}

// Build the client only when configured — constructing it without an API key
// would throw on boot, which we never want.
const workos = isAuthConfigured() ? new WorkOS(apiKey, { clientId }) : null;

// Name of the httpOnly cookie holding the sealed session.
export const SESSION_COOKIE = 'wos-session';

// Cookie options per WorkOS guidance: httpOnly + secure + sameSite 'lax'. The
// session is encrypted (sealed) with cookiePassword, so it's stateless.
export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
};

// The AuthKit hosted authorization URL to redirect the user to for login.
export function getAuthorizationUrl() {
  return workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',
    clientId,
    redirectUri,
  });
}

// Exchange the callback code for an authenticated user + a sealed session string
// to drop into the cookie. Returns { user, sealedSession }.
export function authenticateWithCode(code) {
  return workos.userManagement.authenticateWithCode({
    clientId,
    code,
    session: { sealSession: true, cookiePassword },
  });
}

// Unseal + validate a session cookie (no network call — just decrypts the cookie
// and decodes the JWT). Returns the current user or null. Never throws: a bad or
// expired cookie is treated as "not logged in".
export async function getUserFromCookie(sessionData) {
  if (!workos || !sessionData) return null;
  try {
    const session = workos.userManagement.loadSealedSession({ sessionData, cookiePassword });
    const result = await session.authenticate();
    if (!result.authenticated) return null;
    return result.user || null;
  } catch (err) {
    console.error('[auth] session validation failed — treating as logged out:', err.message);
    return null;
  }
}

// WorkOS hosted logout URL derived from the session cookie. Returns null if the
// cookie can't be read, so the caller can fall back to '/'.
export async function getLogoutUrl(sessionData) {
  if (!workos || !sessionData) return null;
  try {
    const session = workos.userManagement.loadSealedSession({ sessionData, cookiePassword });
    return await session.getLogoutUrl();
  } catch (err) {
    console.error('[auth] logout url failed — falling back to home:', err.message);
    return null;
  }
}

// Flatten a WorkOS user into the shape the frontend expects: {id, email, name}.
// WorkOS gives firstName/lastName separately; join them into a display name.
export function toPublicUser(user) {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return { id: user.id, email: user.email, name };
}
