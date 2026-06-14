# Perfect Order

Enter a restaurant name; an LLM composes the ideal order — the must-haves, one
adventurous pick, and what to skip. You can save generated orders to a shared
list backed by Postgres.

This is a **learning prototype for the Render platform**. The menu data is
AI-generated (synthetic), which is an accepted limitation for v1.

## Stack

- **Node + Express** (plain ESM JavaScript, no build step) — serves the API and the static frontend from one service.
- **`pg`** — Postgres client; single `saved_orders` table.
- **`@anthropic-ai/sdk`** — calls Claude (`claude-sonnet-4-6`) with a structured-output schema.
- **Vanilla HTML/CSS/JS** frontend in `public/`.

## Layout

```
perfect-order/
├── server.js        # Express app: static serving + API routes; boots even if the DB is down
├── llm.js           # Anthropic call + structured-output schema + sample-response fallback
├── db.js            # pg Pool, SSL logic, schema, query helpers
├── migrate.js       # standalone schema runner (server also runs this on boot)
├── render.yaml      # Blueprint: declares the web service AND the Postgres database
├── .env.example     # documents ANTHROPIC_API_KEY, DATABASE_URL, PORT
├── package.json
└── public/          # index.html, app.js, styles.css
```

## Run locally

```bash
npm install
cp .env.example .env        # then edit .env (key is optional — fallback works without it)
npm run dev                 # uses node --env-file=.env, watches for changes
# open http://localhost:3000
```

- No `ANTHROPIC_API_KEY` → the app serves a **sample order** (the AI piece is always optional).
- No `DATABASE_URL` → save/list features turn off, everything else works.
- With a `DATABASE_URL` → run `node --env-file=.env migrate.js` once (or just start the server; it creates the table on boot).

## Deploy on Render (your steps)

You do the Render clicking; this repo provides the config.

1. **Push to GitHub.** `git init && git add . && git commit -m "Perfect Order v1"`, then create a repo and push.
2. **New → Blueprint** in the Render dashboard; connect this repo. Render reads `render.yaml` and shows the web service + database it will create.
3. **Set the secret.** Render prompts for `ANTHROPIC_API_KEY` (it's `sync: false`). Paste your real key — it never lives in the repo.
4. **Apply.** Watch the build (`npm install`) then start (`npm start`) logs. The health check at `/healthz` gates the deploy going live.
5. **Grab the URL** Render assigns and open it.

`DATABASE_URL` is wired automatically by the blueprint — you never paste it.

## Render gotchas worth understanding

- **Port + host:** the app binds `process.env.PORT` on `0.0.0.0` (see `server.js`). Render assigns the port; binding to `localhost` instead would pass build but fail the health check.
- **Build vs start:** `buildCommand` (`npm install`) runs once at deploy; `startCommand` (`npm start`) runs the process. Keep migrations out of `start`.
- **DATABASE_URL injection:** `fromDatabase` in `render.yaml` gives the **internal** connection string (no SSL). The **external** string (for local dev) ends in `.render.com` and needs SSL — `db.js` switches on that.
- **Migrations on deploy:** v1 creates the table on boot (idempotent). The production-grade hook is Render's `preDeployCommand: npm run migrate`, which runs after build and before traffic switches — graduate to that when you outgrow on-boot creation.
- **Free Postgres expires** ~30 days after creation. Fine for a prototype; note it before you rely on the data.
