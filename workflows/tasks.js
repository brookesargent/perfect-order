// Render Workflows task definitions. Plain ESM JavaScript — the SDK is consumable
// from JS (import from '@renderinc/sdk/workflows'), so no build step, matching the
// app's no-build ethos and letting us import shared/normalizeKey.js directly.
//
// Shape: a coordinator (ingestMetro) tiles a metro bbox and fans out to per-tile
// workers (ingestTile). Each ingestTile is a durable, independently-retried run —
// if one tile's Overpass call fails, only that tile retries; finished tiles and
// their upserts are not redone. That durability is the whole reason to use
// Workflows over a plain script for this long, rate-limited job.

import { task } from '@renderinc/sdk/workflows';

import { CINCINNATI, TILE_SPACING_MS } from './config.js';
import { tileBbox, fetchTile, toRestaurantRow } from './overpass.js';
import { upsertBatch } from './db.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Per-tile worker: fetch one bbox from Overpass, map OSM tags -> rows, upsert.
// Retry/backoff rides out Overpass's transient "no slot available" (429/504)
// responses; the upsert is idempotent (conflict-by-key) so a retry is safe.
export const ingestTile = task(
  {
    name: 'ingestTile',
    timeoutSeconds: 300,
    retry: { maxRetries: 4, waitDurationMs: 2000, backoffScaling: 2 },
  },
  async function ingestTile({ tile, metro }) {
    const elements = await fetchTile(tile);
    const rows = elements
      .map((el) => toRestaurantRow(el, metro))
      .filter(Boolean);
    const upserted = rows.length ? await upsertBatch(rows) : 0;
    console.log(
      `[ingestTile] tile=(${tile.s.toFixed(3)},${tile.w.toFixed(3)}) ` +
        `elements=${elements.length} rows=${rows.length} upserted=${upserted}`
    );
    return { elements: elements.length, rows: rows.length, upserted };
  }
);

// Coordinator: tile the metro, fan out to ingestTile SEQUENTIALLY with a polite
// pause between requests. Sequential is deliberate — hammering the shared free
// Overpass endpoint in parallel is exactly what its slot limiter punishes. We
// still get Workflows' per-tile durability; we just don't max out concurrency.
export const ingestMetro = task(
  { name: 'ingestMetro', timeoutSeconds: 3600 },
  async function ingestMetro(metro = CINCINNATI) {
    const tiles = tileBbox(metro);
    let upserted = 0;
    let elements = 0;
    console.log(`[ingestMetro] ${metro.city}: ${tiles.length} tiles`);
    for (let i = 0; i < tiles.length; i++) {
      const result = await ingestTile({ tile: tiles[i], metro });
      upserted += result.upserted;
      elements += result.elements;
      if (i < tiles.length - 1) await sleep(TILE_SPACING_MS);
    }
    const summary = { city: metro.city, tiles: tiles.length, elements, upserted };
    console.log(`[ingestMetro] done: ${JSON.stringify(summary)}`);
    return summary;
  }
);
