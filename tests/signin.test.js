// Sign-in providers: wire formats (plain node), then the real app in jsdom with a fake native bridge:
// Codex device-code sign-in + chat, Claude with an API key, Google sign-in for Gmail.
// Run: NODE_PATH=<dir with jsdom> node tests/signin.test.js
const assert = require('assert');
const path = require('path');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const W = require(path.join(www, 'wire.js'));
const C = require(path.join(www, 'core.js'));

const jwt = (o) => 'h.' + Buffer.from(JSON.stringify(o)).toString('base64url') + '.s';
const idToken = jwt({ email: 'asha@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acc-1' } });
const access = (exp) => jwt({ exp });

// ---- wire: sign-in steps
assert.deepStrictEqual(JSON.parse(W.codexUserCodeRequest().body), { client_id: W.CODEX.clientId });
assert.deepStrictEqual(W.codexUserCode(200, '{"device_auth_id":"d1","user_code":"ABCD-1234","interval":"5"}'), { id: 'd1', code: 'ABCD-1234', intervalMs: 5000 });
assert.throws(() => W.codexUserCode(404, ''), /not available/);
assert.strictEqual(W.codexPoll(403, ''), 'wait'); assert.strictEqual(W.codexPoll(404, ''), 'wait');
assert.throws(() => W.codexPoll(500, ''), /HTTP 500/);
assert.deepStrictEqual(W.codexPoll(200, '{"authorization_code":"c1","code_challenge":"x","code_verifier":"v1"}'), { code: 'c1', verifier: 'v1' });
const ex = W.codexExchangeRequest({ code: 'c 1', verifier: 'v1' });
assert.strictEqual(ex.headers['Content-Type'], 'application/x-www-form-urlencoded');
assert.strictEqual(ex.body, 'grant_type=authorization_code&client_id=' + W.CODEX.clientId + '&code=c%201&redirect_uri=' + encodeURIComponent(W.CODEX.redirectUri) + '&code_verifier=v1');
const s1 = W.codexSession(200, JSON.stringify({ id_token: idToken, access_token: access(2000), refresh_token: 'r1' }));
assert.deepStrictEqual([s1.plan, s1.account, s1.email, s1.refresh, s1.exp], ['plus', 'acc-1', 'asha@example.com', 'r1', 2000000]);
assert.strictEqual(W.planName('plus'), 'Plus'); assert.strictEqual(W.planName('weird'), 'weird');
const s2 = W.codexSession(200, JSON.stringify({ access_token: access(9000) }), s1);
assert.deepStrictEqual([s2.plan, s2.account, s2.refresh, s2.exp], ['plus', 'acc-1', 'r1', 9000000], 'a refresh keeps what it does not resend');
assert.throws(() => W.codexSession(400, '{"error":"invalid_grant","error_description":"Token expired"}'), /HTTP 400.*Token expired/);
assert.ok(W.codexStale(s1, 2000000 - 60000) && !W.codexStale(s1, 0) && !W.codexStale(null, 0));
assert.deepStrictEqual(W.codexHeaders(s1), { Authorization: 'Bearer ' + s1.access, originator: 'cybnate', 'ChatGPT-Account-ID': 'acc-1' });
assert.deepStrictEqual(W.codexModels({ models: [{ slug: 'hidden', visibility: 'hide', priority: 0 }, { slug: 'b', visibility: 'list', priority: 2, context_window: 272000 }, { slug: 'a', display_name: 'A', visibility: 'list', priority: 1 }] }),
  [{ id: 'a', name: 'A', ctx: 0 }, { id: 'b', name: 'b', ctx: 272000 }]);
// ---- wire: bodies
const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
const cb = W.codexBody('m1', msgs);
assert.deepStrictEqual(cb.input.map((m) => m.role + ':' + m.content[0].type + ':' + m.content[0].text), ['developer:input_text:SYS', 'user:input_text:hi', 'assistant:output_text:yo', 'user:input_text:a', 'user:input_text:b']);
assert.ok(cb.stream === true && cb.store === false && cb.model === 'm1' && !('tools' in cb));
const ab = W.anthropicBody('claude-x', msgs);
assert.strictEqual(ab.system, 'SYS'); assert.deepStrictEqual(ab.messages, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'a\n\nb' }]);
assert.ok(ab.max_tokens > 0 && ab.stream === true);
assert.strictEqual(W.anthropicBody('m', [{ role: 'assistant', content: 'x' }]).messages[0].role, 'user', 'Claude turns start with the user');
// ---- wire: streams, split in awkward places
const feedAll = (api, text, n) => { const p = W.parser(api), out = []; for (let i = 0; i < text.length; i += n) out.push(...p.feed(text.slice(i, i + n))); return out; };
const ev = (o) => 'event: ' + o.type + '\ndata: ' + JSON.stringify(o) + '\n\n';
const cx = ev({ type: 'response.created' }) + ev({ type: 'response.reasoning_summary_text.delta', delta: 'hm' }) + ev({ type: 'response.output_text.delta', delta: 'Hel' }) + ev({ type: 'response.output_text.delta', delta: 'lo' }) + ev({ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] } }) + ev({ type: 'response.completed', response: {} });
[1, 7, 4096].forEach((n) => assert.strictEqual(feedAll('codex', cx, n).filter((e) => e.text).map((e) => e.text).join(''), 'Hello', 'no double text, chunk ' + n));
assert.strictEqual(feedAll('codex', ev({ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'whole' }] } }), 9)[0].text, 'whole', 'a reply without deltas is still read');
assert.strictEqual(feedAll('codex', ev({ type: 'response.failed', response: { error: { message: 'usage limit reached' } } }), 5)[0].error, 'usage limit reached');
const an = ev({ type: 'message_start' }) + ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '..' } }) + ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bon' } }) + ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'jour' } }) + ev({ type: 'message_stop' });
assert.strictEqual(feedAll('anthropic', an, 3).filter((e) => e.text).map((e) => e.text).join(''), 'Bonjour');
assert.strictEqual(feedAll('anthropic', ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 50)[0].error, 'Overloaded');
// ---- providers
assert.ok(C.PROVIDERS.codex.signIn === 'codex' && C.PROVIDERS.codex.manual && C.PROVIDERS.anthropic.api === 'anthropic' && C.PROVIDERS.anthropic.manual);
console.log('wire ok');

let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIPPED the app part: jsdom is not installed'); process.exit(0); }
(async () => {
  const net = [], gcalls = []; const srv = { polls: 0, pollsNeeded: 2, exchanges: 0, refreshes: 0, exp: Math.floor(Date.now() / 1000) + 3600, google: null, gmailStatus: 200 };
  const sseBody = (...objs) => objs.map(ev).join('');
  const handle = (q) => {
    net.push(q); const u = q.url, h = q.headers;
    if (u === W.CODEX.userCodeUrl) return { text: '{"device_auth_id":"d1","user_code":"WXYZ-9876","interval":"5"}' };
    if (u === W.CODEX.pollUrl) { srv.polls++; return srv.polls < srv.pollsNeeded ? { status: 403, text: '{}' } : { text: '{"authorization_code":"code-1","code_challenge":"ch","code_verifier":"ver-1"}' }; }
    if (u === W.CODEX.tokenUrl) {
      if (/grant_type=authorization_code/.test(q.body)) { srv.exchanges++; if (srv.exchanges > 1) return { status: 400, text: '{"error":"invalid_grant","error_description":"code already used"}' }; return { text: JSON.stringify({ id_token: idToken, access_token: access(srv.exp), refresh_token: 'refresh-1' }) }; }
      srv.refreshes++; if (!/refresh_token=refresh-1/.test(q.body)) return { status: 400, text: '{"error":"invalid_grant"}' };
      return { text: JSON.stringify({ access_token: access(Math.floor(Date.now() / 1000) + 7200), refresh_token: 'refresh-2' }) };
    }
    if (/chatgpt\.com\/backend-api\/codex\/models/.test(u)) return h['ChatGPT-Account-ID'] === 'acc-1' && /^Bearer h\./.test(h.Authorization) ? { text: JSON.stringify({ models: [{ slug: 'gpt-big', visibility: 'list', priority: 1, context_window: 272000 }, { slug: 'gpt-small', visibility: 'list', priority: 2 }, { slug: 'internal', visibility: 'hide', priority: 0 }] }) } : { status: 401, text: '{"detail":"no"}' };
    if (/chatgpt\.com\/backend-api\/codex\/responses/.test(u)) return { ctype: 'text/event-stream', text: sseBody({ type: 'response.output_text.delta', delta: 'Codex ' }, { type: 'response.output_text.delta', delta: 'says hi' }, { type: 'response.completed', response: {} }) };
    if (/api\.anthropic\.com\/v1\/models/.test(u)) return h['x-api-key'] === 'sk-ant-good' ? { text: '{"data":[{"id":"claude-big"},{"id":"claude-small"}]}' } : { status: 401, text: '{"type":"error","error":{"message":"invalid x-api-key"}}' };
    if (/api\.anthropic\.com\/v1\/messages/.test(u)) return h['x-api-key'] === 'sk-ant-good' ? { ctype: 'text/event-stream', text: sseBody({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude says hi' } }) } : { status: 401, text: '{"type":"error","error":{"message":"invalid x-api-key"}}' };
    if (/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile/.test(u)) return srv.gmailStatus === 200 ? (/^Bearer ya29\./.test(h.Authorization) ? { text: '{"emailAddress":"asha@gmail.com"}' } : { status: 401, text: '{"error":{"message":"Invalid Credentials"}}' }) : { status: 403, text: '{"error":{"message":"Gmail API has not been used in project 568185693722 before or it is disabled."}}' };
    if (/gmail\.googleapis\.com/.test(u)) return { text: JSON.stringify({ sawAuth: h.Authorization }) };
    return { status: 404, text: '{}' };
  };
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = { 'cyb.settings': JSON.stringify({ provider: 'openrouter', model: 'qwen/qwen3-coder:free', keys: { openrouter: 'sk-test' }, models: { openrouter: ['qwen/qwen3-coder:free'] }, nativeTools: false, permission: 'auto' }) };
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.__store = store; w.confirm = () => true;
      w.fetch = async (url) => { net.push({ url, viaFetch: true }); throw new TypeError('blocked by CORS'); };
      w.Native = {
        version: () => 'test',
        http(id, url, method, headersJson, body) {
          setTimeout(() => { const r = handle({ url, method, headers: JSON.parse(headersJson || '{}'), body }); w.__nh(id, 'h', (r.status || 200) + '|' + (r.ctype || 'application/json')); const t = r.text || ''; for (let i = 0; i < t.length; i += 37) w.__nh(id, 'd', t.slice(i, i + 37)); w.__nh(id, 'x', ''); }, 3);
        },
        httpAbort() {},
        googleAuth(id, scopesJson, silent) { gcalls.push({ scopes: JSON.parse(scopesJson), silent }); const a = srv.google(silent); setTimeout(() => w.__ga(id, a), 3); },
      };
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  const T = w.__cyb; assert.ok(T, 'app started');
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));
  const stored = () => JSON.parse(w.__store['cyb.settings']);
  const until = async (fn, what) => { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(25); } assert.fail('timed out: ' + what); };
  const card = (id) => [...d.querySelectorAll('#sheetBody .card')].find((c) => c.dataset.provider === id);

  // 1. Codex: one button, a code to type, then connected with plan and models, chosen for chat
  T.codexSignIn.intervalMs = 20;
  T.openProviders(); await tick();
  assert.ok(card('codex') && d.getElementById('codexGo').textContent === 'Sign in with ChatGPT' && !card('codex').querySelector('input'), 'no key box, just a sign-in button');
  d.getElementById('codexGo').click();
  await until(() => d.getElementById('codexCode'), 'the code shows');
  assert.strictEqual(d.getElementById('codexCode').textContent, 'WXYZ-9876');
  assert.strictEqual(d.getElementById('codexOpen').href, W.CODEX.verifyUrl); assert.strictEqual(d.getElementById('codexOpen').target, '_blank');
  await until(() => d.getElementById('codexState'), 'connected');
  assert.ok(/Connected as asha@example\.com · plan: Plus · 2 models/.test(d.getElementById('codexState').textContent), d.getElementById('codexState').textContent);
  assert.strictEqual(srv.exchanges, 1, 'the one-time code is sent exactly once'); assert.ok(srv.polls >= 2);
  assert.ok(!net.some((q) => q.viaFetch && /openai\.com|chatgpt\.com/.test(q.url)), 'sign-in requests never go through fetch first');
  let st = stored();
  assert.deepStrictEqual(st.models.codex, ['gpt-big', 'gpt-small'], 'hidden models are left out'); assert.strictEqual(st.meta.codex['gpt-big'].ctx, 272000);
  assert.deepStrictEqual([st.provider, st.model, st.codex.plan, st.codex.refresh], ['codex', 'gpt-big', 'plus', 'refresh-1']);
  // chat goes out in the Responses format with the account header
  let got = await T.chatStream([{ role: 'system', content: 'S' }, { role: 'user', content: 'hello' }], () => {}, null, ['read_file']);
  assert.strictEqual(got, 'Codex says hi');
  let q = net.filter((x) => /codex\/responses/.test(x.url)).pop(), b = JSON.parse(q.body);
  assert.ok(q.headers['ChatGPT-Account-ID'] === 'acc-1' && q.headers.originator === 'cybnate' && q.headers.Authorization === 'Bearer ' + st.codex.access);
  assert.ok(b.model === 'gpt-big' && b.input[0].role === 'developer' && b.input[1].content[0].text === 'hello' && !b.tools && !b.messages, 'Responses body, tools stay text tags');
  // a token close to its end is renewed first, once
  const cur = stored().codex; cur.exp = Date.now() + 60000; T.setCodex(cur);
  await Promise.all([T.chatStream([{ role: 'user', content: 'x' }], () => {}, null), T.codexFresh()]);
  assert.strictEqual(srv.refreshes, 1); assert.strictEqual(stored().codex.refresh, 'refresh-2'); assert.strictEqual(stored().keys.codex, stored().codex.access);
  assert.strictEqual(stored().codex.plan, 'plus', 'plan survives a refresh');
  // sign out forgets everything and falls back
  T.openProviders(); await tick(); d.getElementById('codexOut').click(); await tick();
  st = stored(); assert.ok(!st.codex && !st.keys.codex && !st.models.codex && st.provider === 'pollinations');
  assert.strictEqual(d.getElementById('codexGo').textContent, 'Sign in with ChatGPT');
  await assert.rejects(T.chatStream([{ role: 'user', content: 'x' }], () => {}, null, null, { chain: [{ provider: 'codex', model: 'gpt-big' }] }), /Sign in first/);
  console.log('codex sign-in ok');

  // 2. Claude with an API key: models from the account, Messages format
  const kbox = d.querySelector('input[data-key="anthropic"]'); assert.ok(kbox, 'Claude has a key box');
  kbox.value = 'sk-ant-good'; kbox.dispatchEvent(new w.Event('change'));
  assert.deepStrictEqual(Array.from(await T.fetchModels('anthropic')), ['claude-big', 'claude-small']);
  got = await T.chatStream([{ role: 'system', content: 'S' }, { role: 'user', content: 'hello' }], () => {}, null, ['read_file'], { chain: [{ provider: 'anthropic', model: 'claude-big' }] });
  assert.strictEqual(got, 'Claude says hi');
  q = net.filter((x) => /anthropic\.com\/v1\/messages/.test(x.url)).pop(); b = JSON.parse(q.body);
  assert.ok(q.headers['anthropic-version'] && !q.headers.Authorization && b.system === 'S' && b.max_tokens && b.messages[0].content === 'hello' && !b.tools);
  kbox.value = 'sk-ant-bad'; kbox.dispatchEvent(new w.Event('change'));
  await assert.rejects(T.chatStream([{ role: 'user', content: 'x' }], () => {}, null, null, { chain: [{ provider: 'anthropic', model: 'claude-big' }] }), /HTTP 401: invalid x-api-key/);
  console.log('claude api key ok');

  // 3. Google sign-in for Gmail: permissions listed, one button, checked against the real API, token renewed quietly
  const intGo = async () => { d.getElementById('intGo').click(); await until(() => d.getElementById('intGo') && !d.getElementById('intGo').disabled, 'google answered'); };
  T.openIntegrations(); await tick(); d.querySelector('.inttab[data-tab="connectors"]').click(); await tick();
  [...d.querySelectorAll('.inthead')].find((h) => /^Inactive/.test(h.textContent)).click(); await tick();
  d.querySelector('.introw[data-id="gmail"]').click(); await tick();
  assert.ok(!d.querySelector('#sheetBody input[data-env]'), 'nothing to paste');
  assert.ok(/View your email messages and settings/.test(d.querySelector('.grants').textContent) && d.getElementById('intGo').textContent === 'Sign in with Google');
  srv.google = () => ({ ok: false, code: '16', error: 'cancelled' }); await intGo();
  assert.ok(/Sign-in was cancelled/.test(d.getElementById('intMsg').textContent) && !stored().integrations);
  srv.google = () => ({ ok: false, code: '10', error: 'DEVELOPER_ERROR' }); await intGo();
  assert.ok(/SHA-1/.test(d.getElementById('intMsg').textContent), 'a wrong signing key is explained');
  srv.google = () => ({ ok: true, token: 'ya29.first', scopes: [] }); srv.gmailStatus = 403; await intGo();
  assert.ok(/HTTP 403.*disabled.*enable it/i.test(d.getElementById('intMsg').textContent) && !(stored().integrations || {}).gmail, 'a disabled API is not shown as connected');
  srv.gmailStatus = 200; await intGo();
  assert.ok(/Connected as asha@gmail\.com/.test(d.getElementById('intMsg').textContent), d.getElementById('intMsg').textContent);
  st = stored(); assert.strictEqual(st.integrations.gmail.who, 'asha@gmail.com'); assert.strictEqual(st.secrets.find((x) => x.name === 'GMAIL_ACCESS_TOKEN').value, 'ya29.first');
  assert.deepStrictEqual(gcalls[gcalls.length - 1], { scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'], silent: false });
  assert.ok(/Gmail: https:\/\/gmail\.googleapis\.com.*GMAIL_ACCESS_TOKEN/.test(T.extraPrompt()), 'the agent is told Gmail is connected');
  // fresh token: not asked again; old token: renewed without a screen before a command uses it
  const n0 = gcalls.length; await T.freshGoogle(['GMAIL_ACCESS_TOKEN']); assert.strictEqual(gcalls.length, n0);
  T.settings.integrations.gmail.tokenAt = Date.now() - 41 * 60000;
  srv.google = (silent) => (silent ? { ok: true, token: 'ya29.second', scopes: [] } : { ok: false, code: 'error', error: 'a screen was shown' });
  const run = await T.runCommand('curl -s -H "Authorization: Bearer $GMAIL_ACCESS_TOKEN" https://gmail.googleapis.com/gmail/v1/users/me/labels', 30, null, ['GMAIL_ACCESS_TOKEN']);
  assert.strictEqual(gcalls[gcalls.length - 1].silent, true);
  assert.strictEqual(net.filter((x) => /users\/me\/labels/.test(x.url)).pop().headers.Authorization, 'Bearer ya29.second', 'the command got the renewed token');
  assert.ok(run.out.indexOf('ya29.') < 0, 'and the token is hidden in the output: ' + run.out);
  // Google refuses to renew without a screen: the command still runs, nothing crashes
  T.settings.integrations.gmail.tokenAt = 0; srv.google = () => ({ ok: false, code: 'needs_ui', error: '' });
  await T.runCommand('curl -s -H "Authorization: Bearer $GMAIL_ACCESS_TOKEN" https://gmail.googleapis.com/gmail/v1/users/me/labels', 30, null, ['GMAIL_ACCESS_TOKEN']);
  assert.strictEqual(net.filter((x) => /users\/me\/labels/.test(x.url)).pop().headers.Authorization, 'Bearer ya29.second');
  // disconnect removes the token
  d.getElementById('intOff').click(); await tick();
  assert.ok(!(stored().integrations || {}).gmail && !stored().secrets.some((x) => x.name === 'GMAIL_ACCESS_TOKEN'));
  console.log('google sign-in ok');
  console.log('SIGNIN TEST PASSED');
  w.close();
})().catch((e) => { console.error(e); process.exit(1); });
