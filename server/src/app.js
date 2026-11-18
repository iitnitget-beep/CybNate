'use strict';
/* The HTTP API of the CybNate backend. See docs/BACKEND.md for the list of calls. */
const http = require('node:http');
const crypto = require('node:crypto');
const Store = require('./store');
const Workspace = require('./workspace');
const Exec = require('./exec');
const Lsp = require('./lsp');
const OAuth = require('./oauth');
const Net = require('./net');

const VERSION = '0.1.0';
const err = (status, message) => Object.assign(new Error(message), { status });
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function create(cfg) {
  if (!cfg.accessKey || String(cfg.accessKey).length < 16) throw new Error('CYB_ACCESS_KEY is required and must be at least 16 characters: it is what lets a phone register with this server.');
  const store = Store.open(cfg.dataDir, cfg.masterKey);
  const workspace = Workspace.create(cfg.dataDir, { uidBase: cfg.uidBase });
  const exec = Exec.create(workspace, { maxParallel: cfg.maxParallel, maxQueue: cfg.maxQueue });
  const lsp = Lsp.create(workspace, (user) => exec.envFor(user), { servers: cfg.lspServers, idleMs: cfg.lspIdleMs });
  const oauth = OAuth.create(store, { env: cfg.env || {}, providers: cfg.oauthProviders, codex: cfg.codex, publicUrl: cfg.publicUrl });
  const netCfg = { allowPrivate: !!cfg.allowPrivate };
  const inflight = new Map(), buckets = new Map();
  const log = cfg.log || (() => {});
  const gc = setInterval(() => { try { store.gc(); } catch (e) {} const now = Date.now(); buckets.forEach((b, k) => { if (now - b.t > 120000) buckets.delete(k); }); }, 60000); gc.unref();

  /** Simple token bucket: `rate` requests per minute, bursts up to `rate`. */
  const allow = (key, rate) => { const now = Date.now(), b = buckets.get(key) || { n: rate, t: now }; b.n = Math.min(rate, b.n + ((now - b.t) / 60000) * rate); b.t = now; if (b.n < 1) { buckets.set(key, b); return false; } b.n -= 1; buckets.set(key, b); return true; };

  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > max) { reject(err(413, 'The request is too large.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { if (!size) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(err(400, 'The request body is not valid JSON.')); } });
      req.on('error', reject);
    });
  }
  // Browser access is restricted to explicitly configured origins. Native clients without an Origin header remain supported.
  const corsOrigins = new Set((cfg.corsOrigins || ['https://appassets.androidplatform.net']).map((v) => String(v).trim()).filter(Boolean));
  const corsFor = (req) => {
    const origin = req.headers.origin;
    if (!origin) return {};
    return corsOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : null;
  };
  const CORS = { 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '600' };
  const send = (res, status, body, headers) => { if (res.headersSent) return; const text = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(status, Object.assign({ 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, CORS, headers || {})); res.end(text); };

  /** Values for the secret names a request asks for: stored secrets, or a fresh token of a sign-in. */
  async function resolveSecrets(user, names) {
    const env = {}, missing = [];
    for (const name of [...new Set(names || [])]) {
      if (!NAME.test(name)) continue;
      const prov = oauth.providerOfSecret(name);
      const v = prov ? await oauth.accessToken(user, prov) : store.secretGet(user.id, name);
      if (v == null) missing.push(name); else env[name] = v;
    }
    return { env, missing };
  }
  const expand = (s, env) => String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => (Object.prototype.hasOwnProperty.call(env, a || b) ? env[a || b] : m));

  /** Run fn once per (user, Idempotency-Key): a retry while it runs waits for it, a retry afterwards gets the saved answer. */
  async function idempotent(user, req, fn) {
    const key = req.headers['idempotency-key'];
    if (!key) return fn();
    if (String(key).length > 120) throw err(400, 'Idempotency-Key is too long.');
    const saved = store.idemGet(user.id, key); if (saved) return { status: saved.status, body: JSON.parse(saved.body), replayed: true };
    const k = user.id + ':' + key;
    if (inflight.has(k)) return inflight.get(k).then((r) => Object.assign({}, r, { replayed: true }));
    const p = (async () => { const r = await fn(); store.idemPut(user.id, key, r.status, JSON.stringify(r.body)); return r; })();
    inflight.set(k, p); p.catch(() => {}).finally(() => inflight.delete(k));
    return p;
  }

  const routes = [];
  const on = (method, pattern, handler, opt) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:([a-z]+)/g, '(?<$1>[^/]+)') + '$'), handler, opt: opt || {} });
  const ok = (body) => ({ status: 200, body });

  on('GET', '/v1/health', async () => ok({ ok: true, name: 'cybnate-server', version: VERSION, isolation: workspace.isolation(), masterKey: store.masterSource, languages: lsp.languages(), signIn: Object.keys(oauth.providers).filter(oauth.configured).concat(['codex']), exec: exec.stats() }), { open: true });
  on('POST', '/v1/auth/register', async (c) => {
    if (!allow('reg:' + c.ip, 10)) throw err(429, 'Too many attempts. Wait a minute.');
    if (!safeEq(c.body.accessKey || '', cfg.accessKey)) throw err(403, 'The access key is wrong.');
    if (workspace.isolation() === 'none' && store.userCount() >= 1 && !cfg.allowShared) throw err(403, 'This server does not run as root, so it cannot keep users apart. It accepts one user only. Run it in the Docker image (as root) for more, or set CYB_ALLOW_SHARED=1 if every user is trusted.');
    const u = store.register(c.body.name, c.body.device); workspace.ensure(u);
    return ok({ userId: u.id, token: u.token });
  }, { open: true });
  on('GET', '/v1/me', async (c) => ok({ userId: c.user.id, name: c.user.name, isolation: workspace.isolation() }));
  on('POST', '/v1/auth/logout', async (c) => ok({ ok: store.logout(c.token) }));

  // ---- workspace files
  on('GET', '/v1/files', async (c) => ok({ files: await workspace.list(c.user) }));
  on('POST', '/v1/files/sync', async (c) => idempotent(c.user, c.req, async () => {
    const w = Array.isArray(c.body.write) ? c.body.write : [], rm = Array.isArray(c.body.remove) ? c.body.remove : [];
    w.forEach((f) => workspace.resolve(c.user, f.path)); rm.forEach((p) => workspace.resolve(c.user, p)); // refuse the whole batch before touching anything
    for (const f of w) await workspace.write(c.user, f.path, f.b64 != null ? Buffer.from(String(f.b64), 'base64') : Buffer.from(String(f.text == null ? '' : f.text), 'utf8'));
    for (const p of rm) await workspace.remove(c.user, p);
    return ok({ ok: true, written: w.length, removed: rm.length });
  }), { max: 96 * 1024 * 1024 });
  on('POST', '/v1/files/read', async (c) => {
    const out = [];
    for (const p of (c.body.paths || []).slice(0, 200)) { try { out.push({ path: p, b64: (await workspace.read(c.user, p)).toString('base64') }); } catch (e) { if (e.status) throw e; out.push({ path: p, missing: true }); } }
    return ok({ files: out });
  });

  // ---- commands
  on('POST', '/v1/exec', async (c) => idempotent(c.user, c.req, async () => {
    const command = String(c.body.command || ''); if (!command.trim()) throw err(400, 'No command given.');
    const timeoutSec = Math.min(Math.max(parseInt(c.body.timeoutSec, 10) || 60, 1), cfg.maxTimeoutSec || 900);
    const { env, missing } = await resolveSecrets(c.user, c.body.secrets);
    const ctl = new AbortController(); c.res.on('close', () => { if (!c.res.writableEnded) ctl.abort(); });
    let changes = { changed: [], deleted: [] };
    const r = await exec.run(c.user, { command, timeoutSec, env, id: c.body.id, signal: ctl.signal, around: async (go) => { const before = await workspace.scan(c.user); const res = await go(); changes = await workspace.diff(c.user, before); return res; } });
    return ok(Object.assign({}, r, changes, missing.length ? { missingSecrets: missing } : {}));
  }), { beat: true });
  on('POST', '/v1/exec/:id/cancel', async (c) => ok({ ok: exec.cancel(c.user, c.params.id) }));

  // ---- secrets: written and listed by name, never read back
  on('GET', '/v1/secrets', async (c) => ok({ secrets: store.secretList(c.user.id) }));
  on('PUT', '/v1/secrets/:name', async (c) => {
    if (!NAME.test(c.params.name)) throw err(400, 'A secret name has letters, digits and _ only, and does not start with a digit.');
    if (oauth.providerOfSecret(c.params.name)) throw err(409, 'That name belongs to a sign-in; its token is managed by the server.');
    if (typeof c.body.value !== 'string' || !c.body.value) throw err(400, 'The secret value is empty.');
    if (c.body.value.length > 16384) throw err(413, 'The secret value is too long.');
    store.secretPut(c.user.id, c.params.name, c.body.value); return ok({ ok: true });
  });
  on('DELETE', '/v1/secrets/:name', async (c) => ok({ ok: store.secretDel(c.user.id, c.params.name) }));

  // ---- outbound request with secrets filled in on the server ($NAME in the address, headers or body)
  on('POST', '/v1/http', async (c) => idempotent(c.user, c.req, async () => {
    const { env, missing } = await resolveSecrets(c.user, c.body.secrets);
    if (missing.length) throw err(409, 'Not stored on the server: ' + missing.join(', '));
    const headers = {}; Object.keys(c.body.headers || {}).forEach((k) => { headers[k] = expand(c.body.headers[k], env); });
    // HTTP Basic from two secrets, for services that want user:password
    if (c.body.basic && c.body.basic.length === 2) headers.Authorization = 'Basic ' + Buffer.from(expand(c.body.basic[0], env) + ':' + expand(c.body.basic[1], env)).toString('base64');
    const ctl = new AbortController(); c.res.on('close', () => { if (!c.res.writableEnded) ctl.abort(); });
    let r; try { r = await Net.request({ url: expand(c.body.url || '', env), method: c.body.method, headers, body: c.body.body == null ? undefined : expand(c.body.body, env), timeoutSec: Math.min(parseInt(c.body.timeoutSec, 10) || 60, 300), signal: ctl.signal }, netCfg); }
    catch (e) { if (e.status) throw e; throw err(502, 'Could not reach the service: ' + (e.cause && e.cause.code ? e.cause.code : e.message)); }
    return ok({ status: r.status, headers: r.headers, text: exec.redact(r.text, Object.values(env)), truncated: r.truncated });
  }), { max: 16 * 1024 * 1024 });

  // ---- sign-in
  on('GET', '/v1/oauth', async (c) => ok({ providers: oauth.list(c.user), redirectUri: oauth.redirectUri }));
  on('POST', '/v1/oauth/codex/device', async (c) => ok(await oauth.codexStart(c.user)));
  on('GET', '/v1/oauth/codex/status', async (c) => ok(oauth.codexStatus(c.user)));
  on('DELETE', '/v1/oauth/codex/device', async (c) => { oauth.codexCancel(c.user); return ok({ ok: true }); });
  on('POST', '/v1/oauth/:provider/start', async (c) => ok(oauth.start(c.user, c.params.provider, Array.isArray(c.body.scopes) ? c.body.scopes.map(String) : [])));
  on('DELETE', '/v1/oauth/:provider', async (c) => { if (c.params.provider === 'codex') oauth.codexCancel(c.user); return ok({ ok: await oauth.disconnect(c.user, c.params.provider) }); });
  on('GET', '/v1/oauth/callback', async (c) => {
    const r = await oauth.callback(c.query);
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    return { status: r.ok ? 200 : 400, body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CybNate</title><body style="font:16px system-ui;margin:15vh auto;max-width:28em;padding:0 20px;text-align:center"><h2>' + (r.ok ? '✓ Done' : '✗ Not connected') + '</h2><p>' + esc(r.message) + '</p></body>' };
  }, { open: true });

  // ---- Codex models through the stored ChatGPT sign-in
  on('GET', '/v1/llm/codex/models', async (c) => {
    const key = 'codex-models:' + c.user.id; const hit = c.query.fresh ? null : store.cacheGet(key); if (hit) return ok(Object.assign({ cached: true }, hit));
    const s = await oauth.codexSession(c.user);
    const r = await fetch(oauth.codex.api + '/models?client_version=1.0.0', { headers: oauth.codexHeaders(s), signal: AbortSignal.timeout(30000) });
    const text = await r.text(); if (r.status >= 400) return { status: r.status, body: { error: 'ChatGPT answered HTTP ' + r.status, detail: text.slice(0, 500) } };
    const body = JSON.parse(text); store.cachePut(key, body, 10 * 60 * 1000); return ok(body);
  });
  on('POST', '/v1/llm/codex/responses', async (c) => {
    const s = await oauth.codexSession(c.user);
    const ctl = new AbortController(); c.res.on('close', () => { if (!c.res.writableEnded) ctl.abort(); });
    const r = await fetch(oauth.codex.api + '/responses', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }, oauth.codexHeaders(s)), body: JSON.stringify(c.body), signal: ctl.signal });
    c.res.writeHead(r.status, Object.assign({ 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }, CORS));
    if (r.body) for await (const chunk of r.body) c.res.write(chunk); // passed on as it arrives, so the app shows the reply while it is written
    c.res.end(); return null;
  }, { max: 32 * 1024 * 1024 });

  // ---- language servers
  on('POST', '/v1/lsp/diagnostics', async (c) => ok(await lsp.diagnostics(c.user, String(c.body.path || ''), Math.min(parseInt(c.body.waitMs, 10) || 8000, 30000))));
  on('POST', '/v1/lsp/:lang/request', async (c) => ok({ result: await lsp.request(c.user, c.params.lang, String(c.body.method || ''), c.body.params, c.body.path) }));
  on('GET', '/v1/lsp/:lang/events', async (c) => ok(await lsp.events(c.user, c.params.lang, parseInt(c.query.since, 10) || 0)));
  on('DELETE', '/v1/lsp/:lang', async (c) => ok({ ok: lsp.stop(c.user, c.params.lang) }));

  // ---- saved app state (chats, settings): versioned so two devices cannot silently overwrite each other
  on('GET', '/v1/state', async (c) => ok({ keys: store.kvList(c.user.id) }));
  on('GET', '/v1/state/:key', async (c) => { const r = store.kvGet(c.user.id, c.params.key); if (!r) throw err(404, 'Nothing saved under that key.'); return ok(r); });
  on('PUT', '/v1/state/:key', async (c) => {
    if (!('value' in c.body)) throw err(400, 'No value given.');
    const r = store.kvPut(c.user.id, c.params.key, c.body.value, parseInt(c.body.baseVersion, 10) || 0);
    return r.ok ? ok({ ok: true, version: r.version }) : { status: 409, body: { error: 'Someone else saved a newer version.', current: r.current } };
  }, { max: 32 * 1024 * 1024 });
  on('DELETE', '/v1/state/:key', async (c) => ok({ ok: store.kvDel(c.user.id, c.params.key) }));

  const server = http.createServer(async (req, res) => {
    const started = Date.now(); let user = null, beat = null;
    let cors = null;
    try {
      cors = corsFor(req);
      if (cors === null) { send(res, 403, { error: 'This origin is not allowed.' }); return; }
      if (req.method === 'OPTIONS') { res.writeHead(204, Object.assign({}, CORS, cors)); return res.end(); }
      const u = new URL(req.url, 'http://x'); const pathName = u.pathname.replace(/\/+$/, '') || '/';
      let params = null; const route = routes.find((r) => r.method === req.method && (params = r.re.exec(pathName)));
      if (!route) throw err(routes.some((r) => r.re.test(pathName)) ? 405 : 404, 'No such call: ' + req.method + ' ' + pathName);
      const ip = (cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
      const token = (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1] || '';
      if (!route.opt.open) {
        user = store.auth(token); if (!user) throw err(401, 'Not signed in to this server. Connect the app again.');
        if (!allow('u:' + user.id, cfg.ratePerMinute || 600)) throw err(429, 'Too many requests. Slow down.');
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req, route.opt.max || 2 * 1024 * 1024);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw err(400, 'The request body must be a JSON object.');
      // A long command would look like a dead connection to a phone or a proxy. Such calls start the answer early and
      // send a space now and then (valid before JSON); the real status then travels inside the body as `status`.
      if (route.opt.beat) beat = setInterval(() => { if (!res.headersSent) res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }, CORS, cors)); res.write(' '); }, cfg.beatMs || 15000);
      const out = await route.handler({ req, res, user, token, ip, body, params: Object.assign({}, params.groups), query: Object.fromEntries(u.searchParams) });
      clearInterval(beat);
      if (out && res.headersSent) res.end(JSON.stringify(out.status === 200 ? out.body : Object.assign({}, out.body, { status: out.status })));
      else if (out) send(res, out.status, out.body, Object.assign({}, cors, out.replayed ? { 'Idempotent-Replay': 'true' } : {}));
      log({ t: started, ms: Date.now() - started, method: req.method, path: pathName, status: out ? out.status : res.statusCode, user: user && user.id });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && !e.status) log({ level: 'error', error: e.stack || String(e), path: req.url });
      clearInterval(beat);
      const said = { error: e.status ? e.message : 'The server hit an unexpected problem.' };
      if (res.headersSent) { try { res.end(beat ? JSON.stringify(Object.assign(said, { status })) : undefined); } catch (er) {} return; }
      send(res, status, said, cors || {});
    }
  });
  server.requestTimeout = 0; server.headersTimeout = 60000; server.keepAliveTimeout = 65000;
  const close = () => new Promise((resolve) => { clearInterval(gc); oauth.stop(); lsp.stopAll(); server.close(() => { try { store.close(); } catch (e) {} resolve(); }); server.closeAllConnections && server.closeAllConnections(); });
  return { server, close, store, workspace, exec, lsp, oauth, VERSION };
}

module.exports = { create, VERSION };
