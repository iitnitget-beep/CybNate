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
      const store = { 'cyb.settings': JSON.stringify({ provider: 'openrouter', model: 'qwen/qwen3-coder:free', keys: { openrouter: 'sk-test', groq: 'gsk-test' }, nativeTools: false }) };
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
  ['openrouter', 'groq', 'custom'].forEach((p) => { T.limiter.limits[p] = { concurrent: 2, rpm: 6000, daily: 0 }; });
  const ask = (via) => T.chatStream([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], () => {}, undefined, null, via);
  const chat = (c) => /chat\/completions/.test(c.url);

  // 1. model list: paid models are left out, context windows are remembered
  handler = () => ({ status: 200, body: JSON.stringify({ data: [
    { id: 'qwen/qwen3-coder:free', context_length: 262144, pricing: { prompt: '0', completion: '0' } },
    { id: 'tiny/model:free', context_length: 8192, pricing: { prompt: '0', completion: '0' } },
    { id: 'anthropic/claude-x', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } }] }) });
  const list = await T.fetchModels('openrouter');
  assert.strictEqual(String(list), 'qwen/qwen3-coder:free,tiny/model:free');
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
  await ask({ chain: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }] });
  let g = T.usageReport().find((p) => p.id === 'groq');
  assert.ok(g.lines.some((l) => /Provider reports: 14370 of 14400 requests left, resets in 3 min/.test(l)), g.lines.join(' | '));
  assert.ok(g.lines.some((l) => /Tokens\/min reported: 5400 of 6000/.test(l)));
  assert.ok(/1 requests.*321 tokens.*health/.test(g.models[0].text), g.models[0].text);
  console.log('3 ok  provider-reported quota and token use recorded');

  // 4. short retry-after: waits as asked, then succeeds on the same model
  let n = 0; calls.length = 0;
  handler = (c) => (chat(c) && n++ === 0 ? { status: 429, body: '{"error":{"message":"slow down"}}', headers: { 'retry-after': '1' } } : { status: 200, body: sse('after wait') });
  let t0 = Date.now();
  assert.strictEqual(await ask({ chain: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }] }), 'after wait');
  assert.ok(Date.now() - t0 >= 1000, 'waited ' + (Date.now() - t0) + ' ms'); assert.strictEqual(calls.length, 2);
  assert.strictEqual(T.limiter.status('groq').rpm, 3000, 'pace halved after the 429');
  console.log('4 ok  429 + retry-after 1 s: waited ' + (Date.now() - t0) + ' ms, then answered');

  // 5. long retry-after (a used-up quota): no waiting, the next provider in the chain answers
  calls.length = 0; t0 = Date.now(); const seenModels = [];
  handler = (c) => (/openrouter/.test(c.url) ? { status: 429, body: '{"error":{"message":"free-models-per-day limit"}}', headers: { 'retry-after': '3600' } } : { status: 200, body: sse('from groq') });
  const out = await ask({ chain: [{ provider: 'openrouter', model: 'qwen/qwen3-coder:free' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }], onModel: (t, note) => seenModels.push(t.model + (note ? ' (' + note + ')' : '')) });
  assert.strictEqual(out, 'from groq'); assert.ok(Date.now() - t0 < 3000, 'no long wait');
  assert.strictEqual(String(seenModels), 'qwen/qwen3-coder:free,llama-3.3-70b-versatile (fallback from qwen/qwen3-coder:free)');
  // while blocked, OpenRouter is skipped without any request
  calls.length = 0;
  await ask({ chain: [{ provider: 'openrouter', model: 'tiny/model:free' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }] });
  assert.ok(calls.every((c) => !/openrouter/.test(c.url)), 'blocked provider not called');
  // alone, the user gets the reason
  await assert.rejects(ask({ chain: [{ provider: 'openrouter', model: 'qwen/qwen3-coder:free' }] }), /openrouter asked to wait \d+ s \(provider asked to wait\)/);
  const o = T.usageReport().find((p) => p.id === 'openrouter');
  assert.ok(o.lines.some((l) => /^Waiting 1 h 0 min: provider asked to wait/.test(l)), o.lines.join(' | '));
  assert.ok(/1 rate-limited/.test(o.models.find((m) => m.model === 'qwen/qwen3-coder:free').text));
  console.log('5 ok  429 + retry-after 1 h: fell back in ' + (Date.now() - t0) + ' ms; blocked provider skipped');

  // 6. Ollama: no /v1/models, list comes from /api/tags
  T.settings.customUrl = 'http://192.168.1.10:11434/v1'; calls.length = 0;
  handler = (c) => (/\/api\/tags$/.test(c.url) ? { status: 200, body: JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3.2:3b' }, { name: 'nomic-embed-text' }] }) } : { status: 404, body: 'not found' });
  assert.strictEqual(String(await T.fetchModels('custom')), 'qwen2.5-coder:7b,llama3.2:3b');
  assert.strictEqual(String(calls.map((c) => c.url)), 'http://192.168.1.10:11434/v1/models,http://192.168.1.10:11434/api/tags');
  handler = () => ({ status: 200, body: sse('local') }); calls.length = 0;
  assert.strictEqual(await ask({ chain: [{ provider: 'custom', model: 'qwen2.5-coder:7b' }] }), 'local');
  assert.strictEqual(calls[0].url, 'http://192.168.1.10:11434/v1/chat/completions');
  assert.ok(T.modelPool().some((t) => t.provider === 'custom' && t.model === 'llama3.2:3b'), 'local models join the Auto pool');
  console.log('6 ok  Ollama discovery through /api/tags, chat through /v1');

  // 7. Usage screen and the model list render
  T.openUsage();
  const cards = [...d.querySelectorAll('#sheetBody .card')];
  assert.strictEqual(cards.length, Object.keys(T.C.PROVIDERS).length);
  assert.ok(/Waiting 1 h/.test(cards.find((c) => c.dataset.provider === 'openrouter').textContent));
  assert.ok(/starting estimate|slowed/.test(cards[0].textContent));
  [...d.querySelectorAll('#sheetBody button')].find((b) => /Forget learned limits/.test(b.textContent)).click();
  assert.strictEqual(T.limiter.status('openrouter').blockedMs, 0); assert.strictEqual(T.limiter.status('groq').rpm, 6000);
  console.log('7 ok  Usage & limits screen; "Forget learned limits" resets');
  console.log('ROUTER UI TEST PASSED');
  w.close();
})().catch((e) => { console.error(e); process.exit(1); });
