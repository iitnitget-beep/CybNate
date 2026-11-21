// Phase 2 model router inside the real app (jsdom) with fake provider servers:
// price/context metadata, the free-only guard, rate-limit headers, fallback, Ollama discovery, the Usage screen.
// Run: NODE_PATH=<dir with jsdom> node tests/router.ui.test.js
const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const sse = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';

(async () => {
  const calls = []; let handler = () => ({ status: 200, body: sse('ok') });
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = { 'cyb.settings': JSON.stringify({ provider: 'openrouter', model: 'qwen/qwen3-coder:free', keys: { openrouter: 'sk-test' }, nativeTools: false }) };
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      const stream = (s) => { const chunks = [new TextEncoder().encode(s)]; return { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) }; };
      w.fetch = async (url, opt) => {
        const body = opt && opt.body ? JSON.parse(opt.body) : null, c = { url, model: body && body.model, auth: opt && opt.headers && opt.headers.Authorization };
        calls.push(c);
        const r = handler(c) || { status: 200, body: '{}' }, hs = Object.assign({ 'content-type': 'application/json' }, r.headers || {});
        return { status: r.status, headers: { get: (k) => hs[k.toLowerCase()] || null, forEach: (fn) => Object.keys(hs).forEach((k) => fn(hs[k], k)) }, body: stream(r.body || '') };
      };
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  const T = w.__cyb; assert.ok(T, 'app started');
  ['openrouter'].forEach((p) => { T.limiter.limits[p] = { concurrent: 2, rpm: 6000, daily: 0 }; });
  const ask = (via) => T.chatStream([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], () => {}, undefined, null, via);
  const chat = (c) => /chat\/completions/.test(c.url);

  // OpenRouter is the one API provider: Claude connects through its catalog, and
  // paid models require a deliberate possible-billing opt-in.
  T.settings.keys.openrouter = 'sk-or-test-only';
  handler = () => ({ status: 200, body: JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet-4', pricing: { prompt: '0.000003', completion: '0.000015' } }, { id: 'x/embed-1' }] }) });
  assert.strictEqual(String(await T.fetchModels('openrouter')), 'anthropic/claude-sonnet-4');
  assert.strictEqual(calls.at(-1).url, 'https://openrouter.ai/api/v1/models');
  assert.strictEqual(calls.at(-1).auth, 'Bearer sk-or-test-only');
  calls.length = 0; handler = () => ({ status: 200, body: sse('claude answer') });
  await assert.rejects(ask({ chain: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }] }), /not a free model/);
  assert.strictEqual(calls.length, 0, 'paid Claude request is not sent without paid-usage opt-in');
  T.settings.allowPaid = true;
  assert.strictEqual(await ask({ chain: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }] }), 'claude answer');
  assert.strictEqual(calls.at(-1).url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.strictEqual(calls.at(-1).auth, 'Bearer sk-or-test-only');
  T.settings.allowPaid = false;
  T.openProviders();
  const orCard = [...d.querySelectorAll('#sheetBody .card')].find((c) => /OpenRouter/.test(c.textContent));
  assert.ok(orCard && orCard.querySelector('input[type=password]'), 'OpenRouter settings card offers a key field');
  console.log('0 ok  OpenRouter provider, Claude discovery, auth and paid opt-in');

  // 1. model list: paid models stay listed (labelled PAID in the picker), context windows are remembered
  handler = () => ({ status: 200, body: JSON.stringify({ data: [
    { id: 'qwen/qwen3-coder:free', context_length: 262144, pricing: { prompt: '0', completion: '0' } },
    { id: 'tiny/model:free', context_length: 8192, pricing: { prompt: '0', completion: '0' } },
    { id: 'anthropic/claude-x', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } }] }) });
  const list = await T.fetchModels('openrouter');
  assert.strictEqual(String(list), 'qwen/qwen3-coder:free,tiny/model:free,anthropic/claude-x');
  assert.strictEqual(T.metaOf({ provider: 'openrouter', model: 'tiny/model:free' }).ctx, 8192);
  assert.ok(T.modelPool().some((t) => t.model === 'tiny/model:free' && t.ctx === 8192), 'pool carries the context window');
  console.log('1 ok  model list: free filter + context windows');

  // 2. a model that is not free is never sent
  calls.length = 0; handler = () => ({ status: 200, body: sse('should not happen') });
  await assert.rejects(ask({ chain: [{ provider: 'openrouter', model: 'anthropic/claude-x' }] }), (e) => /Not sent: "anthropic\/claude-x" on OpenRouter is not a free model/.test(e.message));
  await assert.rejects(ask({ chain: [{ provider: 'openrouter', model: 'openai/gpt-5' }] }), /price is unknown/);
  assert.strictEqual(calls.length, 0, 'no network request for a paid model');
  // typed-in paid model as the user's choice: left out of the Auto pool except as the explicit choice, and still refused
  T.settings.model = 'openai/gpt-5';
  await assert.rejects(ask(), /not a free model/); assert.strictEqual(calls.length, 0);
  // in a chain the paid model is skipped and the free one answers; the paid one is not marked unhealthy
  assert.strictEqual(await ask({ chain: [{ provider: 'openrouter', model: 'openai/gpt-5' }, { provider: 'openrouter', model: 'qwen/qwen3-coder:free' }] }), 'should not happen');
  assert.strictEqual(calls.filter(chat).length, 1); assert.strictEqual(calls[0].model, 'qwen/qwen3-coder:free');
  assert.ok(!T.health['openrouter|openai/gpt-5']);
  // explicit opt-in sends it
  T.settings.allowPaid = true; calls.length = 0; await ask(); assert.strictEqual(calls[0].model, 'openai/gpt-5');
  T.settings.allowPaid = false; T.settings.model = 'qwen/qwen3-coder:free';
  console.log('2 ok  free-only guard: refused before any request, opt-in works');

  // 3. quota headers on a normal reply are shown on the Usage screen
  handler = () => ({ status: 200, body: sse('fine') + 'data: {"usage":{"total_tokens":321}}\n\n', headers: { 'x-ratelimit-limit-requests': '14400', 'x-ratelimit-remaining-requests': '14370', 'x-ratelimit-reset-requests': '2m59s', 'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '5400' } });
  await ask({ chain: [{ provider: 'openrouter', model: 'qwen/qwen3-coder:free' }] });
  let g = T.usageReport().find((p) => p.id === 'openrouter');
  assert.ok(g.lines.some((l) => /Provider reports: 14370 of 14400 requests left, resets in 3 min/.test(l)), g.lines.join(' | '));
  assert.ok(g.lines.some((l) => /Tokens\/min reported: 5400 of 6000/.test(l)));
  assert.ok(g.models.some((m) => /321 tokens/.test(m.text)), g.models.map((m) => m.text).join(' | '));
  console.log('3 ok  provider-reported quota and token use recorded');

  // 4. short retry-after: waits as asked, then succeeds on the same model
  let n = 0; calls.length = 0;
  handler = (c) => (chat(c) && n++ === 0 ? { status: 429, body: '{"error":{"message":"slow down"}}', headers: { 'retry-after': '1' } } : { status: 200, body: sse('after wait') });
  let t0 = Date.now();
  assert.strictEqual(await ask({ chain: [{ provider: 'openrouter', model: 'qwen/qwen3-coder:free' }] }), 'after wait');
  assert.ok(Date.now() - t0 >= 1000, 'waited ' + (Date.now() - t0) + ' ms'); assert.strictEqual(calls.length, 2);
  assert.strictEqual(T.limiter.status('openrouter').rpm, 3000, 'pace halved after the 429');
  console.log('4 ok  429 + retry-after 1 s: waited ' + (Date.now() - t0) + ' ms, then answered');

  // 5. long retry-after (a used-up quota): no waiting, the next provider in the chain answers
  calls.length = 0; t0 = Date.now(); const seenModels = [];
  T.settings.keys.anthropic = 'sk-ant-test-only';
  const anthSse = 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'from claude' } }) + '\n\n';
  handler = (c) => (/anthropic/.test(c.url) ? { status: 200, body: anthSse } : { status: 429, body: '{"error":{"message":"free-models-per-day limit"}}', headers: { 'retry-after': '3600' } });
  const out = await ask({ chain: [{ provider: 'openrouter', model: 'qwen/qwen3-coder:free' }, { provider: 'anthropic', model: 'claude-sonnet-4-5' }], onModel: (t, note) => seenModels.push(t.model + (note ? ' (' + note + ')' : '')) });
  assert.strictEqual(out, 'from claude'); assert.ok(Date.now() - t0 < 3000, 'no long wait');
  assert.strictEqual(String(seenModels), 'qwen/qwen3-coder:free,claude-sonnet-4-5 (fallback from qwen/qwen3-coder:free)');
  // while blocked, OpenRouter is skipped without any request
  calls.length = 0;
  await assert.rejects(ask({ chain: [{ provider: 'openrouter', model: 'tiny/model:free' }] }), /asked to wait/);
  assert.strictEqual(calls.length, 0, 'blocked provider not called');
  // alone, the user gets the reason
  await assert.rejects(ask({ chain: [{ provider: 'openrouter', model: 'qwen/qwen3-coder:free' }] }), /openrouter asked to wait \d+ s \(provider asked to wait\)/);
  const o = T.usageReport().find((p) => p.id === 'openrouter');
  assert.ok(o.lines.some((l) => /^Waiting 1 h 0 min: provider asked to wait/.test(l)), o.lines.join(' | '));
  assert.ok(/\d+ rate-limited/.test(o.models.find((m) => m.model === 'qwen/qwen3-coder:free').text));
  console.log('5 ok  429 + retry-after 1 h: fell back in ' + (Date.now() - t0) + ' ms; blocked provider skipped');

  // 6. the custom/Ollama provider was removed in the OpenRouter-only cleanup
  assert.ok(!T.C.PROVIDERS.custom && !T.C.PROVIDERS.groq && !T.C.PROVIDERS.pollinations, 'removed providers stay removed');
  console.log('6 ok  OpenRouter-only provider set');

  // 7. Usage screen and the model list render
  T.openUsage();
  const cards = [...d.querySelectorAll('#sheetBody .card')];
  assert.strictEqual(cards.length, Object.keys(T.C.PROVIDERS).length);
  assert.ok(/Waiting 1 h/.test(cards.find((c) => c.dataset.provider === 'openrouter').textContent));
  assert.ok(/starting estimate|slowed/.test(cards[0].textContent));
  [...d.querySelectorAll('#sheetBody button')].find((b) => /Forget learned limits/.test(b.textContent)).click();
  assert.strictEqual(T.limiter.status('openrouter').blockedMs, 0); assert.strictEqual(T.limiter.status('openrouter').rpm, 6000);
  console.log('7 ok  Usage & limits screen; "Forget learned limits" resets');
  console.log('ROUTER UI TEST PASSED');
  w.close();
})().catch((e) => { console.error(e); process.exit(1); });
