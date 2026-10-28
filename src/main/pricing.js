'use strict';

// List prices in USD per million tokens. Longer prefixes must come before
// shorter ones because lookups take the first prefix that matches.
// cacheRead defaults to 10% of input when not listed. Cache writes cost
// 1.25x input for the 5-minute TTL and 2x input for the 1-hour TTL.
const PRICES = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos-5', { input: 10, output: 50 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-opus-4-5', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 15, output: 75 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-3-7-sonnet', { input: 3, output: 15 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
];

function priceFor(model) {
  if (!model) return null;
  const id = String(model).replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '');
  for (const [prefix, price] of PRICES) {
    if (id.startsWith(prefix)) return price;
  }
  return null;
}

// Normalises an API `usage` object into flat token counts.
function tokensOf(usage) {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const write = usage.cache_creation_input_tokens || 0;
  const split = usage.cache_creation || null;
  const write1h = split ? split.ephemeral_1h_input_tokens || 0 : 0;
  const write5m = split ? split.ephemeral_5m_input_tokens || 0 : Math.max(0, write - write1h);
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  };
}

function costOf(model, usage) {
  const price = priceFor(model);
  if (!price || !usage) return 0;
  const t = tokensOf(usage);
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const fast = usage.speed === 'fast' ? 2 : 1;
  return (
    (fast *
      (t.input * price.input +
        t.output * price.output +
        t.cacheRead * cacheRead +
        t.cacheWrite5m * price.input * 1.25 +
        t.cacheWrite1h * price.input * 2)) /
    1e6
  );
}

// Context window size Claude Code uses for a model, when the status line
// hasn't told us the real value.
function contextLimitFor(model) {
  const id = String(model || '');
  if (/claude-(fable|mythos|opus|sonnet|haiku)-5/.test(id)) return 1_000_000;
  if (/claude-(opus-4-[678]|sonnet-4-6)/.test(id)) return 1_000_000;
  return 200_000;
}

function prettyModel(model) {
  const m = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(String(model || ''));
  if (!m) return model || '';
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  const minor = m[3] && m[3].length <= 2 ? `.${m[3]}` : '';
  return `${name} ${m[2]}${minor}`;
}

module.exports = { priceFor, tokensOf, costOf, contextLimitFor, prettyModel };
