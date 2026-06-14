// Ingest configuration. First slice is Cincinnati only; the bbox lives here so
// adding metros later is a data change, not a code change.

// Cincinnati metro bounding box (south, west, north, east) in decimal degrees.
// Roughly covers the city + close-in suburbs. Latitude FIRST — getting the order
// backwards is the classic Overpass footgun (returns zero / wrong-hemisphere).
export const CINCINNATI = {
  city: 'Cincinnati',
  state: 'OH',
  s: 39.05,
  w: -84.72,
  n: 39.31,
  e: -84.36,
  // Tile grid: split the bbox into rows×cols sub-boxes so each Overpass query
  // stays well under the server's 180s / 512 MiB defaults. ~4×4 = 16 tiles is
  // comfortable for a metro of this size.
  rows: 4,
  cols: 4,
};

// Overpass endpoint. Override via env to point at a mirror if the public one is
// busy. POST the QL to /interpreter.
export const OVERPASS_ENDPOINT =
  process.env.OVERPASS_ENDPOINT || 'https://overpass-api.de/api/interpreter';

// Identify ourselves politely — Overpass operators ask for a real User-Agent
// with contact info so they can reach out instead of just blocking.
export const USER_AGENT =
  process.env.OVERPASS_USER_AGENT ||
  'perfect-order-catalog-ingest/1.0 (https://github.com/perfect-order; contact via repo)';

// Per-request Overpass server-side timeout, in seconds (the [timeout:N] header).
export const OVERPASS_TIMEOUT_SECONDS = 120;

// Polite pause between tile requests, in ms — sequential + spaced so we never
// trip the slot-based rate limiter on the shared free endpoint.
export const TILE_SPACING_MS = 1500;
