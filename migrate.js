// Standalone migration runner: creates the schema, then exits.
//
// The server also runs this on boot (idempotent CREATE TABLE IF NOT EXISTS), so
// you don't strictly need this for v1 — it exists so you can see migrations as a
// discrete step, and as the hook you'd point Render's preDeployCommand at once
// you graduate past on-boot creation.
//
// Local use:  node --env-file=.env migrate.js
import { initDb } from './db.js';

const ok = await initDb();
process.exit(ok ? 0 : 1);
