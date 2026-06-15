import Anthropic from '@anthropic-ai/sdk';

// Read the key from the environment — never hardcode it. If it's missing we
// fall through to sample data so the app still renders.
const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

const MODEL = 'claude-sonnet-4-6';

// Server-side web search tool — lets Claude look up the real restaurant + menu
// instead of guessing from training data. This is the grounding that makes
// off-the-beaten-path restaurants accurate.
const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search' };

// Web search responses carry citations, which are incompatible with strict
// structured outputs (output_config.format → 400). So we instruct JSON in the
// prompt and parse it ourselves, with a forgiving extractor + fallback.
function collectText(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

// --- Fallbacks (used when there's no key or the call/parse fails) ----------

function fallbackCandidates(query) {
  // One candidate = the raw query, so the confirm→compose flow still works.
  return [{ name: query, location: '', cuisine: '', grounded: false }];
}

function fallbackOrder(displayName, location = '', cuisine = '') {
  return {
    restaurant: displayName,
    location,
    cuisine,
    must_haves: [
      { item: 'The house specialty everyone recommends', why: 'It is what this place is known for.' },
      { item: 'A shareable starter', why: 'Good to split while you decide on the rest.' },
    ],
    adventurous: {
      item: 'The chef’s special or off-menu pick',
      why: 'A small risk that usually pays off if you are feeling brave.',
    },
    skip: [{ item: 'The oversized combo deal', why: 'More food than flavor — order à la carte instead.' }],
    fallback: true,
  };
}

// --- Step 1: find + disambiguate -------------------------------------------

export async function findRestaurants(query) {
  if (!client) return fallbackCandidates(query);

  const prompt = `The user typed this restaurant name: "${query}".
Use web search to identify up to 3 real, specific restaurants that best match it. If the query names a city or area, prioritize matches there; otherwise prefer the most likely / well-known matches.
For each, provide: name, location (city + neighborhood if known), and cuisine.
Respond with ONLY a JSON object, no prose:
{"candidates":[{"name":"...","location":"...","cuisine":"..."}]}
If you genuinely cannot find a match, return one candidate using the name as given with empty location and cuisine.`;

  try {
    const resp = await client.messages.create(
      { model: MODEL, max_tokens: 1024, tools: [WEB_SEARCH], messages: [{ role: 'user', content: prompt }] },
      { timeout: 30000 }
    );
    const data = extractJson(collectText(resp.content));
    const candidates = data?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return fallbackCandidates(query);
    return candidates.slice(0, 3).map((c) => ({
      name: c.name || query,
      location: c.location || '',
      cuisine: c.cuisine || '',
      grounded: true,
    }));
  } catch (err) {
    console.error('[llm] findRestaurants failed — serving fallback:', err.message);
    return fallbackCandidates(query);
  }
}

// --- Step 2: compose the order, grounded in the confirmed restaurant -------

export async function composeOrder(restaurant) {
  const r = typeof restaurant === 'string' ? { name: restaurant } : restaurant || {};
  const displayName = r.location ? `${r.name} (${r.location})` : r.name || 'this restaurant';
  const location = r.location || '';
  const cuisine = r.cuisine || '';

  if (!client) return fallbackOrder(displayName, location, cuisine);

  const prompt = `Use web search to find the actual current menu of this restaurant:
- name: ${r.name}
${r.location ? `- location: ${r.location}\n` : ''}${r.cuisine ? `- cuisine: ${r.cuisine}\n` : ''}Based on its REAL menu items, compose the perfect order:
- must_haves: 2-4 specific dishes a first-timer should get, each with a one-line why tied to this restaurant.
- adventurous: ONE bolder real menu item, with a why.
- skip: 1-3 real menu items that are overrated or not worth it, with a why.
Use actual dish names from the menu wherever you can find them. Keep each "why" to one short sentence.
Respond with ONLY a JSON object, no prose:
{"restaurant":"...","must_haves":[{"item":"...","why":"..."}],"adventurous":{"item":"...","why":"..."},"skip":[{"item":"...","why":"..."}]}`;

  try {
    const resp = await client.messages.create(
      { model: MODEL, max_tokens: 1500, tools: [WEB_SEARCH], messages: [{ role: 'user', content: prompt }] },
      // 55s: real web-search composes need ~45-50s, so a tighter cap was
      // falling back to the generic sample. The client abort (60s) sits just
      // above this. Cold start can still exceed it — the durable fix is a
      // background menu-backfill workflow (no user waiting), not a bigger cap.
      { timeout: 55000 }
    );
    const order = extractJson(collectText(resp.content));
    if (!order || !Array.isArray(order.must_haves) || !order.adventurous || !Array.isArray(order.skip)) {
      return fallbackOrder(displayName, location, cuisine);
    }
    order.restaurant = displayName;
    order.location = location;
    order.cuisine = cuisine;
    order.fallback = false;
    return order;
  } catch (err) {
    console.error('[llm] composeOrder failed — serving fallback:', err.message);
    return fallbackOrder(displayName, location, cuisine);
  }
}
