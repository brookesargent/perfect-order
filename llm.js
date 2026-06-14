import Anthropic from '@anthropic-ai/sdk';

// Read the key from the environment — never hardcode it. If it's missing we
// fall straight through to the sample response so the app still renders.
const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

const MODEL = 'claude-sonnet-4-6';

// Structured output schema — constrains Claude's response to exactly this shape
// so the frontend can render it without defensive parsing. (Anthropic structured
// outputs require additionalProperties:false on every object.)
const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    restaurant: { type: 'string' },
    must_haves: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['item', 'why'],
      },
    },
    adventurous: {
      type: 'object',
      additionalProperties: false,
      properties: {
        item: { type: 'string' },
        why: { type: 'string' },
      },
      required: ['item', 'why'],
    },
    skip: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['item', 'why'],
      },
    },
  },
  required: ['restaurant', 'must_haves', 'adventurous', 'skip'],
};

// Canned response used whenever the AI call can't be made or fails. Generic but
// plausible, so a flaky API key (or no key at all) never breaks the demo.
function fallbackOrder(restaurant) {
  return {
    restaurant,
    must_haves: [
      { item: 'The house specialty everyone recommends', why: 'It is what this place is known for.' },
      { item: 'A shareable starter', why: 'Good to split while you decide on the rest.' },
    ],
    adventurous: {
      item: 'The chef’s special or off-menu pick',
      why: 'A small risk that usually pays off if you are feeling brave.',
    },
    skip: [
      { item: 'The oversized combo deal', why: 'More food than flavor — order à la carte instead.' },
    ],
    fallback: true,
  };
}

export async function composeOrder(restaurant) {
  if (!client) return fallbackOrder(restaurant);

  const prompt = `You are a savvy regular who knows "${restaurant}" inside out.
Compose the *perfect order*:
- must_haves: 2-4 dishes a first-timer should absolutely get, each with a one-line "why".
- adventurous: ONE bolder pick for someone feeling brave (e.g. "if you're into seafood..."), with a "why".
- skip: 1-3 things that are overrated or not worth it, each with a one-line "why".
Use specific, real-sounding menu item names. Keep every "why" to one short sentence.`;

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 1024,
        output_config: { format: { type: 'json_schema', schema: ORDER_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      },
      // Per-request timeout so a slow API can't hang the page — on timeout the
      // SDK throws, we catch below, and serve the sample instead.
      { timeout: 12000 }
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    const order = JSON.parse(textBlock.text);
    order.fallback = false;
    return order;
  } catch (err) {
    console.error('[llm] composeOrder failed — serving fallback:', err.message);
    return fallbackOrder(restaurant);
  }
}
