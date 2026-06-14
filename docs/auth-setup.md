# Auth setup (WorkOS AuthKit) — founder guide

Phase 1 adds hosted login/logout via **WorkOS AuthKit** plus a shadow `users`
table. It does **not** change any existing feature — saved orders and suggestions
stay global. Until you set the four env vars below, the app runs **exactly as it
does today** (login is simply unavailable; `/api/me` reports no user).

You do the WorkOS dashboard clicks and set four Render env vars. That's it.

---

## 1. Create a WorkOS account + AuthKit

1. Sign up at **https://dashboard.workos.com** (free tier is fine).
2. AuthKit is WorkOS's hosted login. In the dashboard, open **AuthKit** and
   **enable/configure** it (you'll get a hosted AuthKit domain — the page users
   are sent to for login).

## 2. Choose authentication methods

In **AuthKit → Authentication** (sometimes "Sign-in methods"), pick what users
can log in with. For a simple start, enable **Email + Password** and/or
**Google OAuth**. AuthKit auto-detects the method and routes the user — you don't
write any per-method code.

## 3. Set the redirect URI

This is the callback our app handles after login. In **Redirects** (the Redirects
section of the dashboard):

- **Redirect URI / Sign-in callback:**
  `https://perfect-order.onrender.com/auth/callback`
  (For local testing you can also add `http://localhost:3000/auth/callback`.)
- **Sign-out redirect:** `https://perfect-order.onrender.com/` (where users land
  after logout).

> Important (per WorkOS docs): the redirect URI must be an exact match — **no
> wildcard subdomains and no query parameters**. It has to be `/auth/callback`
> because that's the route the app exposes.

## 4. Copy your API key + Client ID

In **API Keys** (or the dashboard overview / "Quick start"):

- **API key** — looks like `sk_live_...` (or `sk_test_...`). This is a **secret**.
- **Client ID** — looks like `client_...`. Not secret, but still set via env.

## 5. Generate a cookie password (32+ chars)

The session cookie is encrypted ("sealed") with a password you choose. It must be
**at least 32 characters**. Generate a random one, e.g. run locally:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output — that's your `WORKOS_COOKIE_PASSWORD`. Keep it secret; rotating
it logs everyone out.

---

## 6. Set the four env vars on Render

In the Render dashboard → the **perfect-order** web service → **Environment**,
add these four (all four must be present for auth to turn on):

| Key | Value |
| --- | --- |
| `WORKOS_API_KEY` | the `sk_...` API key from step 4 (secret) |
| `WORKOS_CLIENT_ID` | the `client_...` Client ID from step 4 |
| `WORKOS_REDIRECT_URI` | `https://perfect-order.onrender.com/auth/callback` |
| `WORKOS_COOKIE_PASSWORD` | the 32+ char password from step 5 (secret) |

Save — Render redeploys. If you set fewer than four, auth stays **off** and the
app behaves as today (this is intentional and safe).

---

## 7. Verify

- Visit `https://perfect-order.onrender.com/auth/login` → you should be redirected
  to the AuthKit hosted login page.
- Log in → you're redirected back to `/` and an httpOnly session cookie is set.
- `GET /api/me` returns `{"user": {"id": "...", "email": "...", "name": "..."}}`.
- `https://perfect-order.onrender.com/auth/logout` clears the cookie and ends the
  WorkOS session; `/api/me` then returns `{"user": null}`.
- A row now exists in the `users` table (`SELECT * FROM users;`).

**Local dev:** put the same four vars in `.env` (the app reads it via
`npm run dev`). Use the `localhost:3000/auth/callback` redirect URI you added in
step 3. Cookies are marked `secure`, so local login works over `http://localhost`
in most browsers but is most reliable when you test against the deployed HTTPS URL.

---

### Reference
- AuthKit (Node.js): https://workos.com/docs/authkit/vanilla/nodejs
- Redirect URIs: https://workos.com/docs/authkit
- Sessions (sealed cookies): https://workos.com/docs/user-management
