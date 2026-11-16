// Phase 2 model router: limits learned from provider replies, model metadata, free-only guard, context budget.
const assert = require('assert');
const O = require('../app/src/main/assets/www/orchestra.js');

(async () => {
  // ---- durations and headers
  assert.strictEqual(O.parseDuration('2m59.5s'), 179500);
  assert.strictEqual(O.parseDuration('7.66s'), 7660);
  assert.strictEqual(O.parseDuration('120ms'), 120);
  assert.strictEqual(O.parseDuration('30'), 30000);
  assert.ok(isNaN(O.parseDuration('soon')));
  const now = 1700000000000;
  // Groq style
  let h = O.parseRateHeaders({ 'Retry-After': '12', 'X-RateLimit-Limit-Requests': '14400', 'x-ratelimit-remaining-requests': '14370', 'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '5400' }, now);
  assert.deepStrictEqual(h, { retryAfterMs: 12000, limit: 14400, remaining: 14370, resetMs: 179560, limitTokens: 6000, remainingTokens: 5400 });
  // OpenRouter style: reset is an epoch in milliseconds
  h = O.parseRateHeaders({ 'X-RateLimit-Limit': '20', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(now + 42000) }, now);
  assert.deepStrictEqual(h, { limit: 20, remaining: 0, resetMs: 42000 });
  assert.strictEqual(O.parseRateHeaders({ 'ratelimit-reset': String(now / 1000 + 30) }, now).resetMs, 30000, 'epoch seconds');
  assert.strictEqual(O.parseRateHeaders({ 'retry-after': new Date(now + 5000).toUTCString() }, now).retryAfterMs, 5000, 'HTTP date');
  assert.deepStrictEqual(O.parseRateHeaders({}, now), {});
  assert.deepStrictEqual(O.parseRateHeaders(null, now), {});
  assert.strictEqual(O.retryHintMs('Rate limit reached. Please try again in 7.66s. Visit'), 7660);
  assert.strictEqual(O.retryHintMs('try again in 1m2s'), 62000);
  assert.strictEqual(O.retryHintMs('retry after 45 s'), 45000);
  assert.strictEqual(O.retryHintMs('{"retryDelay": "31s"}'), 31000);
  assert.strictEqual(O.retryHintMs('nope'), 0);

  // ---- limiter learns from replies
  let clock = now; const sleeps = [];
  const fakeSleep = async (ms) => { sleeps.push(ms); clock += ms; };
  let saved = null;
  const mk = () => O.createLimiter({ now: () => clock, sleep: fakeSleep, limits: { p: { concurrent: 2, rpm: 60, daily: 0 } }, loadSeen: () => saved, saveSeen: (x) => { saved = JSON.parse(JSON.stringify(x)); } });
  let lim = mk();
  (await lim.acquire('p'))(); assert.strictEqual(sleeps.length, 0);
  // 429 with retry-after: the next request waits exactly that long, and the pace is halved
  lim.observe('p', { status: 429, headers: { 'retry-after': '20' } });
  assert.strictEqual(lim.status('p').blockedMs, 20000); assert.strictEqual(lim.status('p').rpm, 30);
  assert.strictEqual(lim.status('p').paceSource, 'slowed after a rate-limit reply');
  let t0 = clock; (await lim.acquire('p'))(); assert.ok(clock - t0 >= 20000 && clock - t0 < 21000, 'waited ' + (clock - t0));
  // 429 with the wait only in the body
  lim.observe('p', { status: 429, headers: {}, body: 'Please try again in 3.5s.' });
  assert.strictEqual(lim.status('p').blockedMs, 3500); assert.strictEqual(lim.status('p').rpm, 15);
  clock += 4000;
  // 429 with no hint at all: doubling back-off (third strike in a row = 8 s)
  lim.observe('p', { status: 429 }); assert.strictEqual(lim.status('p').blockedMs, 8000);
  assert.strictEqual(lim.status('p').why, 'rate limited, no wait time given');
  clock += 9000;
  // the learned state survives a restart
  lim = mk(); assert.strictEqual(lim.status('p').rpm, 7, 'pace restored from storage');
  // success replies bring the pace back, but not within a minute of the last 429
  lim.observe('p', { status: 200 }); assert.strictEqual(lim.status('p').rpm, 7);
  clock += 61000;
  for (let i = 0; i < 12; i++) lim.observe('p', { status: 200 });
  assert.strictEqual(lim.status('p').rpm, 60); assert.strictEqual(lim.status('p').paceSource, 'starting estimate');
  // a long block is refused at once so the caller can fall back to another model
  lim.observe('p', { status: 429, headers: { 'retry-after': '3600' } });
  await assert.rejects(lim.acquire('p'), (e) => e.name === 'BudgetError' && e.code === 'rate' && /3600 s/.test(e.message));
  clock += 3601000; (await lim.acquire('p'))();
  // quota reported in headers: shown, used for the "low" warning, and blocks when it reaches zero
  lim.observe('p', { status: 200, headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-requests': '6h' } });
  let st = lim.status('p'); assert.strictEqual(st.quota.limit, 1000); assert.strictEqual(st.quota.remaining, 5); assert.ok(st.low, 'low from reported quota');
  lim.observe('p', { status: 200, headers: { 'x-ratelimit-limit': '20', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '40s' } });
  assert.ok(!lim.status('p').low, 'a per-minute window that refills soon is not "low"');
  lim.observe('p', { status: 200, headers: { 'x-ratelimit-limit': '20', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '40s' } });
  assert.strictEqual(lim.status('p').blockedMs, 40000);
  clock += 41000; assert.strictEqual(lim.status('p').quota, null, 'an expired quota window is dropped');
  // the built-in daily figures are estimates: they warn but never refuse
  let d = { date: new Date(clock).toISOString().slice(0, 10), counts: { openrouter: 49 } };
  const lim3 = O.createLimiter({ now: () => clock, sleep: fakeSleep, loadDaily: () => d, saveDaily: (x) => { d = x; } });
  for (let i = 0; i < 3; i++) (await lim3.acquire('openrouter'))();
  st = lim3.status('openrouter'); assert.strictEqual(st.dailyUsed, 52); assert.strictEqual(st.dailyMax, 50); assert.ok(st.dailyIsEstimate && st.low);

  // ---- model metadata
  const meta = O.parseModelMeta({ data: [
    { id: 'qwen/qwen3-coder:free', context_length: 262144, pricing: { prompt: '0', completion: '0' }, top_provider: { max_completion_tokens: 8192 } },
    { id: 'anthropic/claude-x', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'llama-3.3-70b-versatile', context_window: 131072, max_completion_tokens: 32768 },
    { name: 'models/gemini-2.5-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536 },
    { id: 'bare' }, 'just-a-string',
  ] });
  assert.deepStrictEqual(meta['qwen/qwen3-coder:free'], { ctx: 262144, out: 8192, free: true });
  assert.deepStrictEqual(meta['anthropic/claude-x'], { ctx: 200000, free: false });
  assert.deepStrictEqual(meta['llama-3.3-70b-versatile'], { ctx: 131072, out: 32768 });
  assert.deepStrictEqual(meta['gemini-2.5-flash'], { ctx: 1048576, out: 65536 });
  assert.ok(!meta.bare);
  assert.deepStrictEqual(O.parseModelMeta({ models: [{ name: 'qwen2.5-coder:7b', size: 1 }] }), {}, 'Ollama tags carry no window');

  // ---- free-only guard
  assert.ok(O.freeCheck('priced', 'qwen/qwen3-coder:free', meta).ok);
  assert.ok(!O.freeCheck('priced', 'anthropic/claude-x', meta).ok);
  assert.ok(/price/.test(O.freeCheck('priced', 'anthropic/claude-x', meta).reason));
  assert.ok(!O.freeCheck('priced', 'openai/gpt-5', {}).ok, 'unknown price is refused');
  assert.ok(O.freeCheck('priced', 'openrouter/free', {}).ok);
  assert.ok(O.freeCheck('priced', 'x/y:free', null).ok);
  assert.ok(!O.freeCheck('priced', 'x/y:free', { 'x/y:free': { free: false } }).ok, 'the price list wins over the name');
  assert.ok(O.freeCheck('priced', 'anthropic/claude-x', meta, true).ok, 'explicit opt-in');
  assert.ok(O.freeCheck(undefined, 'llama-3.3-70b-versatile', meta).ok, 'account-billed providers are not judged per model');

  // ---- context budget
  assert.strictEqual(O.historyBudget(0, 9000), 70000, 'unknown window keeps the old budget');
  assert.strictEqual(O.historyBudget(8192, 9000), 4000 > (Math.floor((8192 * 0.75 - 2000) * 3) - 9000) ? 4000 : Math.floor((8192 * 0.75 - 2000) * 3) - 9000);
  assert.ok(O.historyBudget(8192, 9000) < 70000);
  assert.strictEqual(O.historyBudget(32768, 9000), Math.floor((32768 * 0.75 - 2000) * 3) - 9000);
  assert.strictEqual(O.historyBudget(1048576, 9000), 120000, 'capped');
  assert.strictEqual(O.historyBudget(2048, 9000), 4000, 'floor');

  // ---- chain selection uses the context window
  const pool = [{ provider: 'a', model: 'tiny-coder', ctx: 4096 }, { provider: 'a', model: 'other-coder', ctx: 131072 }];
  assert.strictEqual(O.pickChain('coder', pool, {}, { now })[0].model, 'other-coder');
  console.log('ALL ROUTER TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
