// The single source of truth for the cache key — shared by reads and writes so
// they can never disagree. Imperfect by design: collapses obvious dupes (accents,
// punctuation, &/and, case) but won't catch name drift ("Mio's" vs "Mio's
// Pizzeria") or inconsistent city strings. A miss just falls through to the web
// search, so imperfect is acceptable.
//
// Extracted from db.js so the Workflows ingest pipeline (workflows/) can import
// the EXACT same function — ingested rows must key-converge with organic rows,
// so there can only ever be one copy of this logic.
export function normalizeKey(name = '', location = '') {
  const norm = (s) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const city = norm(location.split(',')[0] || location);
  return `${norm(name)}|${city}`;
}
