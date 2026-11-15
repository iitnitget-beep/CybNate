// Integrations: catalogue rules (plain node) and the real screen in jsdom with a fake network.
// Run: NODE_PATH=<dir with jsdom> node tests/integrations.test.js   (without jsdom only the first part runs)
const assert = require('assert');
const path = require('path');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const I = require(path.join(www, 'integrations.js'));

// ---- catalogue
const ids = new Set();
I.LIST.forEach((e) => {
  assert.ok(!ids.has(e.id), 'duplicate id ' + e.id); ids.add(e.id);
  assert.ok(I.CATEGORIES.some((c) => c[0] === e.cat), 'category of ' + e.id);
  if (e.kind !== 'key') { assert.ok(e.note && e.note.length > 30, 'a service that cannot be connected says why: ' + e.id); return; }
  assert.ok(e.fields.length && e.api && e.auth && /^https:\/\//.test(e.keyUrl), 'complete entry: ' + e.id);
  e.fields.forEach((f) => assert.ok(/^[A-Z][A-Z0-9_]*$/.test(f.env) && f.label, e.id + ' field'));
  assert.ok(e.fields.some((f) => !f.optional), e.id + ' has a required field');
  if (!e.test) { assert.ok(/without a check/i.test(e.note || ''), 'no check is said openly: ' + e.id); return; }
  const vals = {}; e.fields.forEach((f) => { vals[f.env] = f.url ? 'https://h.example' : /SITE|DOMAIN/.test(f.env) ? 'h.example' : 'v-' + f.env; });
  const r = I.testRequest(e, vals);
  assert.ok(/^https:\/\/[a-z0-9.-]+\//i.test(r.url) && !/\{[A-Za-z]/.test(r.url + Object.values(r.headers).join(" ")), 'check request has no unfilled part: ' + e.id + ' ' + r.url);
  assert.ok(e.fields.filter((f) => !f.optional && !f.plain).every((f) => (r.url + JSON.stringify(r.headers)).indexOf('v-' + f.env) >= 0 || /b64/.test(JSON.stringify(e.test))), 'the secret is used by the check: ' + e.id);
});
['github', 'gitlab', 'vercel', 'aws', 'supabase', 'postgres', 'openai', 'gemini', 'brave', 'playwright', 'stripe', 'razorpay', 'notion', 'google', 'slack', 'telegram', 'figma', 'docker', 'e2b', 'memory'].forEach((id) => assert.ok(I.BY_ID[id], id));
assert.strictEqual(I.LIST.length, 74);
// templates and input clean-up
assert.strictEqual(I.testRequest(I.BY_ID.twilio, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok' }).headers.Authorization, 'Basic ' + Buffer.from('AC1:tok').toString('base64'));
assert.strictEqual(I.testRequest(I.BY_ID.telegram, { TELEGRAM_BOT_TOKEN: '12:ab' }).url, 'https://api.telegram.org/bot12:ab/getMe');
assert.strictEqual(I.clean({ env: 'SUPABASE_URL', url: true }, ' abc.supabase.co/ '), 'https://abc.supabase.co');
assert.strictEqual(I.clean({ env: 'ATLASSIAN_SITE' }, 'https://team.atlassian.net/jira'), 'team.atlassian.net');
assert.strictEqual(I.clean({ env: 'X' }, ' "sk-1" '), 'sk-1');
assert.deepStrictEqual(I.validate(I.BY_ID.slack, { SLACK_BOT_TOKEN: '' }), ['Bot token is empty']);
assert.deepStrictEqual(I.validate(I.BY_ID.discord, { DISCORD_BOT_TOKEN: 'x' }), [], 'optional fields may stay empty');
// judging answers
const J = (id, status, body) => I.judge(I.BY_ID[id], { status, text: typeof body === 'string' ? body : JSON.stringify(body) });
assert.deepStrictEqual(J('gitlab', 200, { username: 'asha' }), { ok: true, who: 'asha' });
assert.ok(!J('gitlab', 401, { message: '401 Unauthorized' }).ok && /refused the key \(HTTP 401\): 401 Unauthorized/.test(J('gitlab', 401, { message: '401 Unauthorized' }).why));
assert.ok(!J('slack', 200, { ok: false, error: 'invalid_auth' }).ok && /invalid_auth/.test(J('slack', 200, { ok: false, error: 'invalid_auth' }).why), 'Slack answers 200 for a bad token');
assert.deepStrictEqual(J('slack', 200, { ok: true, team: 'Acme' }), { ok: true, who: 'Acme' });
assert.ok(!J('linear', 200, { errors: [{ message: 'Authentication required' }] }).ok, 'GraphQL errors with HTTP 200');
assert.strictEqual(J('linear', 200, { data: { viewer: { email: 'a@b.c' } } }).who, 'a@b.c');
assert.ok(/No answer/.test(J('supabase', 0, '').why) && /address/.test(J('supabase', 0, '').why));
assert.ok(/address or the account name/.test(J('twilio', 404, '').why));
assert.ok(J('groq', 429, '').ok, 'a rate limit means the key was accepted');
assert.ok(!J('stripe', 500, 'oops').ok);
// what the agent is told
const block = I.promptBlock(['slack', 'stripe', 'docker', 'nope'], () => true);
assert.ok(/- Slack: https:\/\/slack\.com\/api.*Secrets: SLACK_BOT_TOKEN\..*Sends real messages/.test(block) && /- Stripe:.*Real money/.test(block) && !/Docker/.test(block));
assert.ok(/secrets="EXAMPLE_TOKEN"/.test(block) && /Never print a secret/.test(block) && !/v-|sk_/.test(block));
assert.strictEqual(I.promptBlock([], () => true), '');
assert.strictEqual(I.expand('Authorization: Bearer $A_B and ${C} and $MISSING', { A_B: '1', C: '2' }), 'Authorization: Bearer 1 and 2 and $MISSING');
console.log('integrations catalogue ok: ' + I.LIST.length + ' services, ' + JSON.stringify(I.summary()));

// ---- the screen
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIPPED the screen part: jsdom is not installed'); process.exit(0); }
const sse = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
(async () => {
  const net = [], calls = []; const script = { reply: () => 'ok' };
  const SECRET = 'xoxb-REAL-SLACK-SECRET-123';
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = { 'cyb.settings': JSON.stringify({ provider: 'openrouter', model: 'qwen/qwen3-coder:free', keys: { openrouter: 'sk-test' }, models: { openrouter: ['qwen/qwen3-coder:free'] }, nativeTools: false, permission: 'auto' }) };
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.__store = store; w.confirm = () => true;
      const stream = (s) => { const chunks = [new TextEncoder().encode(s)]; return { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) }; };
      const hdr = (ct) => ({ get: (k) => (/content-type/i.test(k) ? ct : ''), forEach: () => {} });
      w.fetch = async (url, opt) => {
        opt = opt || {};
        if (/openrouter\.ai\/api\/v1\/chat|pollinations/.test(url) && opt.body) {
          const body = JSON.parse(opt.body); const c = { messages: body.messages }; calls.push(c);
          return { status: 200, headers: hdr('text/event-stream'), body: stream(sse(script.reply(c, calls))) };
        }
        if (!/slack\.com|gitlab\.com|atlassian\.net|api\.groq\.com/.test(url)) return { status: 200, headers: hdr('application/json'), body: stream('[]') };
        const h = opt.headers || {}; net.push({ url, method: opt.method || 'GET', headers: h, body: opt.body });
        let r = { status: 404, text: '{}' };
        if (/slack\.com\/api\/auth\.test/.test(url)) r = { status: 200, text: JSON.stringify(h.Authorization === 'Bearer ' + SECRET ? { ok: true, team: 'Acme' } : { ok: false, error: 'invalid_auth' }) };
        if (/slack\.com\/api\/chat\.postMessage/.test(url)) r = { status: 200, text: JSON.stringify(h.Authorization === 'Bearer ' + SECRET ? { ok: true, ts: '1.2', echo: h.Authorization } : { ok: false, error: 'not_authed' }) };
        if (/gitlab\.com\/api\/v4\/user/.test(url)) r = h['PRIVATE-TOKEN'] === 'glpat-good' ? { status: 200, text: '{"username":"asha"}' } : { status: 401, text: '{"message":"401 Unauthorized"}' };
        if (/team\.atlassian\.net/.test(url)) r = { status: 200, text: '{"displayName":"Asha K"}' };
        if (/api\.groq\.com/.test(url)) r = { status: 200, text: '{"data":[]}' };
        return { status: r.status, headers: hdr('application/json'), body: stream(r.text) };
      };
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  const T = w.__cyb; assert.ok(T, 'app started');
  ['openrouter', 'pollinations'].forEach((p) => { T.limiter.limits[p] = { concurrent: 2, rpm: 6000, daily: 0 }; });
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));
  const stored = () => JSON.parse(w.__store['cyb.settings']);
  const row = (id) => d.querySelector('.introw[data-id="' + id + '"]');
  const type = (env, v) => { const i = d.querySelector('input[data-env="' + env + '"]'); i.value = v; i.dispatchEvent(new w.Event('input')); };
  const go = async () => { d.getElementById('intGo').click(); for (let i = 0; i < 80; i++) { await tick(25); if (d.getElementById('intGo') && !d.getElementById('intGo').disabled) break; } };
  const back = () => d.getElementById('sheetBack') ? d.getElementById('sheetBack').click() : d.querySelector('#sheet .back, #sheet header button').click();

  // 1. three tabs: Discover (groups, three each, arrow opens the group), Connectors (Active / Inactive), Skills; plus search
  const tabBtn = (t) => d.querySelector('.inttab[data-tab="' + t + '"]');
  const ids = () => [...d.querySelectorAll('.introw[data-id]')].map((x) => x.dataset.id);
  const openAll = async () => { tabBtn('connectors').click(); await tick(); [...d.querySelectorAll('.inthead')].find((h) => /^Inactive/.test(h.textContent)).click(); await tick(); };
  d.getElementById('dInt').click(); await tick();
  assert.ok(tabBtn('discover').classList.contains('on') && tabBtn('connectors') && tabBtn('skills'));
  assert.strictEqual(d.querySelectorAll('.inthead').length, 10, 'ten groups'); assert.strictEqual(ids().length, 30, 'three per group');
  assert.ok(ids().indexOf('gitlab') >= 0 && ids().indexOf('filesystem') < 0, 'connectable services come first in a group');
  assert.ok(/^\+$/.test(row('gitlab').querySelector('.intact').textContent) && /Read projects, issues/.test(row('gitlab').textContent) && row('gitlab').querySelector('.intbadge').textContent === 'G');
  [...d.querySelectorAll('.inthead')].find((h) => /Databases/.test(h.textContent)).click(); await tick();
  assert.deepStrictEqual(ids(), ['supabase', 'firebase', 'postgres', 'mongodb', 'mysql', 'upstash', 'neon', 'planetscale', 'prisma', 'convex'], 'the arrow opens the whole group');
  assert.ok(/Not on a phone/.test(row('postgres').textContent) && row('postgres').querySelector('.intact').textContent === 'ⓘ');
  d.getElementById('intBack').click(); await tick();
  tabBtn('connectors').click(); await tick();
  assert.ok(/Active \(3\)/.test(d.getElementById('sheetBody').textContent) && /Inactive \(71\)/.test(d.getElementById('sheetBody').textContent), 'built-in ones count as active');
  assert.ok(row('github').classList.contains('on') && row('github').querySelector('.intact').textContent === '⋯');
  tabBtn('skills').click(); await tick();
  assert.ok(/Tell the agent how you like things done/.test(d.getElementById('sheetBody').textContent) && /No skills yet/.test(d.getElementById('sheetBody').textContent) && d.getElementById('intSkills'));
  d.getElementById('intSearchBtn').click(); await tick();
  assert.strictEqual(ids().length, 74, 'search starts with every service');
  const q = d.getElementById('intSearch'); q.value = 'pay'; q.dispatchEvent(new w.Event('input'));
  assert.deepStrictEqual(ids(), ['clerk', 'auth0', 'nextauth', 'stripe', 'lemonsqueezy', 'razorpay'], 'search matches name, description and group');
  q.value = 'zzz'; q.dispatchEvent(new w.Event('input')); assert.ok(/No service matches/.test(d.getElementById('sheetBody').textContent));
  d.getElementById('intSearchBtn').click(); await tick();
  await openAll();
  assert.strictEqual(ids().length, 71);
  assert.ok(/Not on a phone/.test(row('docker').textContent) && /Needs sign-in/.test(row('google').textContent) && /Planned/.test(row('memory').textContent));

  // 2. a service that cannot be connected explains itself and has no key field
  row('docker').click(); await tick();
  assert.ok(/cannot run on an Android phone/.test(d.getElementById('sheetBody').textContent) && !d.querySelector('#sheetBody input'));
  back(); await tick();

  // 3. wrong key: refused, nothing saved
  row('slack').click(); await tick();
  await go(); assert.ok(/Bot token is empty/.test(d.getElementById('intMsg').textContent), 'empty field');
  type('SLACK_BOT_TOKEN', 'xoxb-wrong'); await go();
  assert.ok(/✗ The service refused the key: invalid_auth/.test(d.getElementById('intMsg').textContent), d.getElementById('intMsg').textContent);
  assert.ok(!(stored().integrations || {}).slack && !(stored().secrets || []).some((x) => x.name === 'SLACK_BOT_TOKEN'), 'a refused key is not stored');
  assert.strictEqual(d.querySelector('input[data-env="SLACK_BOT_TOKEN"]').value, 'xoxb-wrong', 'what was typed is kept for correcting');
  // 4. right key (pasted with spaces): connected, stored as a secret, shown in the list
  type('SLACK_BOT_TOKEN', '  ' + SECRET + ' '); await go();
  assert.ok(/✓ Connected as Acme/.test(d.getElementById('intMsg').textContent), d.getElementById('intMsg').textContent);
  assert.strictEqual(stored().secrets.find((x) => x.name === 'SLACK_BOT_TOKEN').value, SECRET);
  assert.strictEqual(stored().integrations.slack.who, 'Acme');
  assert.strictEqual(d.querySelector('input[data-env="SLACK_BOT_TOKEN"]').value, '', 'a saved secret is never shown again');
  assert.ok(d.getElementById('intOff'), 'disconnect button');
  back(); await tick();
  assert.ok(!row('slack'), 'a connected service leaves the Inactive list');
  d.getElementById('intBack').click(); await tick();
  assert.ok(/Active \(4\)/.test(d.getElementById('sheetBody').textContent) && /Connected · Acme/.test(row('slack').textContent) && row('slack').querySelector('.intact').textContent === '⋯');
  await openAll();

  // 5. HTTP 401 and a 3-field form with shared values
  row('gitlab').click(); await tick(); type('GITLAB_TOKEN', 'glpat-bad'); await go();
  assert.ok(/refused the key \(HTTP 401\)/.test(d.getElementById('intMsg').textContent));
  type('GITLAB_TOKEN', 'glpat-good'); await go(); assert.ok(/Connected as asha/.test(d.getElementById('intMsg').textContent)); back(); await tick();
  row('jira').click(); await tick(); type('ATLASSIAN_SITE', 'https://team.atlassian.net/'); type('ATLASSIAN_EMAIL', 'a@b.c'); type('ATLASSIAN_API_TOKEN', 'atl-1'); await go();
  assert.ok(/Connected as Asha K/.test(d.getElementById('intMsg').textContent), d.getElementById('intMsg').textContent);
  assert.strictEqual(net[net.length - 1].url, 'https://team.atlassian.net/rest/api/3/myself'); assert.strictEqual(net[net.length - 1].headers.Authorization, 'Basic ' + Buffer.from('a@b.c:atl-1').toString('base64'));
  back(); await tick();
  row('confluence').click(); await tick();
  assert.strictEqual(d.querySelector('input[data-env="ATLASSIAN_SITE"]').value, 'team.atlassian.net', 'values shared with Jira are filled in');
  await go(); assert.ok(/✓ Connected/.test(d.getElementById('intMsg').textContent), 'the saved token is reused without typing it again');
  d.getElementById('intOff').click(); await tick();
  assert.ok(!stored().integrations.confluence && stored().secrets.some((x) => x.name === 'ATLASSIAN_API_TOKEN'), 'disconnecting Confluence keeps the token Jira still needs');
  back(); await tick();
  // 6. an AI key is also given to the chat provider of the same name
  row('groq').click(); await tick(); type('GROQ_API_KEY', 'gsk_abc'); await go(); back(); await tick();
  assert.strictEqual(stored().keys.groq, 'gsk_abc');
  // 7. a service without a check says so
  row('aws').click(); await tick(); type('AWS_ACCESS_KEY_ID', 'AKIA1'); type('AWS_SECRET_ACCESS_KEY', 'sec'); type('AWS_REGION', 'ap-south-1'); await go();
  assert.ok(/✓ Saved\. Saved without a check/.test(d.getElementById('intMsg').textContent)); back(); await tick();
  d.getElementById('intBack').click(); await tick(); [...d.querySelectorAll('.inthead')].find((h) => /^Active/.test(h.textContent)).click(); await tick();
  assert.ok(/\(not checked\)/.test(row('aws').textContent) && ids().indexOf('jira') >= 0 && ids().indexOf('confluence') < 0);
  while (!d.getElementById('sheet').hidden) { back(); await tick(); }

  // 8. the agent: it is told what is connected (names only), uses the secret through http_request, the user is asked, the value never reaches the model
  [...d.querySelectorAll('#agents .pill')].find((b) => /Coder/.test(b.textContent)).click();
  script.reply = (c, all) => (all.length === 1 ? '<http_request method="POST" url="https://slack.com/api/chat.postMessage" headers=\'{"Authorization":"Bearer $SLACK_BOT_TOKEN","Content-Type":"application/json"}\' secrets="SLACK_BOT_TOKEN">\n{"channel":"#general","text":"build is green"}\n</http_request>' : 'Message sent.');
  d.getElementById('input').value = 'Tell #general on Slack that the build is green'; d.getElementById('btnSend').click();
  let sheet = null;
  for (let i = 0; i < 400; i++) { await tick(25); const s = d.querySelector('.approval'); if (s && !sheet) { sheet = s.textContent; s.querySelector('.abtn.allow').click(); } if (!d.querySelector('#btnSend.stop') && i > 2) break; }
  assert.ok(sheet && /SLACK_BOT_TOKEN/.test(sheet) && /sends data out of this device/i.test(sheet) && sheet.indexOf(SECRET) < 0, 'the approval names the secret and the upload, in Auto mode too: ' + sheet);
  const sys = calls[0].messages[0].content;
  assert.ok(/Connected services/.test(sys) && /- Slack: https:\/\/slack\.com\/api/.test(sys) && /- Jira:/.test(sys) && /- AWS/.test(sys) && !/- Confluence/.test(sys) && !/- Docker/.test(sys));
  const sent = net.find((n) => /chat\.postMessage/.test(n.url));
  assert.ok(sent && sent.headers.Authorization === 'Bearer ' + SECRET && /build is green/.test(sent.body), 'the real value was put in by the app');
  const all = JSON.stringify(calls.map((c) => c.messages));
  assert.ok(all.indexOf(SECRET) < 0 && all.indexOf('atl-1') < 0 && all.indexOf('gsk_abc') < 0, 'no secret value in anything sent to the model');
  assert.ok(/"ok":true/.test(calls[1].messages[calls[1].messages.length - 1].content.replace(/\\/g, '')) && /Bearer \*\*\*/.test(calls[1].messages[calls[1].messages.length - 1].content), 'the answer reached the model with the echoed secret hidden');
  assert.ok(d.getElementById('messages').textContent.indexOf(SECRET) < 0, 'no secret value on screen');
  // without the secrets attribute the placeholder stays a placeholder
  const r = await T.runCommand("curl -s -X POST -H 'Authorization: Bearer $SLACK_BOT_TOKEN' https://slack.com/api/chat.postMessage", 30);
  assert.ok(/not_authed/.test(r.out), 'a command that was not given the secret does not get it: ' + r.out);
  console.log('INTEGRATIONS TEST PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
