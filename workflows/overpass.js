// Overpass (OpenStreetMap) fetching + tag mapping. No key required, and OSM's
// license PERMITS persisting this data into our own catalog — which is why we
// use it instead of Google Places / Yelp (their ToS restrict storing place data,
// disqualifying them for a durable catalog).

import {
  OVERPASS_ENDPOINT,
  USER_AGENT,
  OVERPASS_TIMEOUT_SECONDS,
} from './config.js';

// Split a bbox into a rows×cols grid of sub-bboxes. Edges are shared between
// neighbours, so a restaurant exactly on a boundary can appear twice — harmless,
// since dedup_key collapses it on upsert.
export function tileBbox({ s, w, n, e, rows, cols }) {
  const dLat = (n - s) / rows;
  const dLon = (e - w) / cols;
  const tiles = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      tiles.push({
        s: s + i * dLat,
        w: w + j * dLon,
        n: s + (i + 1) * dLat,
        e: w + (j + 1) * dLon,
      });
    }
  }
  return tiles;
}

// Build the Overpass QL for all restaurants in one bbox. `nwr` = nodes + ways +
// relations (restaurants are mapped as points AND as building polygons). `out
// center tags` gives a single coordinate for ways/relations plus all their tags.
function buildQuery({ s, w, n, e }) {
  return `[out:json][timeout:${OVERPASS_TIMEOUT_SECONDS}];
nwr["amenity"="restaurant"](${s},${w},${n},${e});
out center tags;`;
}

// Fetch one bbox. Throws on non-2xx so the task's retry/backoff can kick in
// (Overpass returns 429/504 when slots are exhausted — exactly what we retry).
export async function fetchTile(tile) {
  const body = buildQuery(tile);
  const resp = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'User-Agent': USER_AGENT,
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Overpass ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json();
  return Array.isArray(data.elements) ? data.elements : [];
}

// Title-case a single cuisine token: "ice_cream" -> "Ice Cream".
function titleCase(token) {
  return token
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// Map one OSM element to our restaurant row shape, or null to skip it.
// Skips un-named POIs (noise). `metro` provides the city/state fallback used
// when OSM's addr:* tags are missing (common), so the dedup_key's city half is
// still populated and ingested rows look like organic web_search rows.
export function toRestaurantRow(element, metro) {
  const tags = element.tags || {};
  const name = (tags.name || '').trim();
  if (!name) return null;

  // cuisine: OSM uses ';'-separated lowercase tokens ("italian;pizza"). Take the
  // first and title-case it; empty when absent.
  const cuisine = tags.cuisine ? titleCase(tags.cuisine.split(';')[0].trim()) : '';

  // location: prefer OSM addr:* ; fall back to the metro's city/state so the key
  // is always city-qualified. Human-readable "City, ST".
  const city = (tags['addr:city'] || metro.city || '').trim();
  const state = (tags['addr:state'] || metro.state || '').trim();
  const location = [city, state].filter(Boolean).join(', ');

  // Stable external id, e.g. "way/12345" — disambiguates dedup_key collisions
  // and aids re-ingest debugging. Always present on OSM elements.
  const osmId = element.type && element.id != null ? `${element.type}/${element.id}` : null;

  return { name, location, cuisine, osmId };
}
