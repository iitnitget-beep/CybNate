'use strict';
/*
 * Sign-in flows that end on the server: the app never sees a client secret, an authorization code or a refresh token.
 *   - generic OAuth 2 code flow with PKCE (Google, GitHub): the browser comes back to /v1/oauth/callback
 *   - Codex: device code with a ChatGPT account, polled by the server
 * Tokens are stored encrypted and renewed here; commands and proxied requests get a fresh access token by name.
 */
const crypto = require('node:crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const form = (o) => Object.keys(o).filter((k) => o[k] != null).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
const claims = (jwt) => { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch (e) { return {}; } };

function defaults(env) {
  return {
    google: {
      name: 'Google', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', revokeUrl: 'https://oauth2.googleapis.com/revoke',
      clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '', baseScopes: ['openid', 'email'], scopeSep: ' ',
      extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
      who: { url: 'https://openidconnect.googleapis.com/v1/userinfo', field: 'email' }, secrets: ['GOOGLE_ACCESS_TOKEN', 'GMAIL_ACCESS_TOKEN', 'GCAL_ACCESS_TOKEN'],
    },
    github: {
      name: 'GitHub', authUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: env.GITHUB_CLIENT_ID || '', clientSecret: env.GITHUB_CLIENT_SECRET || '', baseScopes: [], scopeSep: ' ', extra: {},
      who: { url: 'https://api.github.com/user', field: 'login' }, secrets: ['GITHUB_TOKEN'],
    },
  };
}
const CODEX = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', issuer: 'https://auth.openai.com', api: 'https://chatgpt.com/backend-api/codex',
  secrets: [],
};

function create(store, cfg) {
  const providers = Object.assign(defaults(cfg.env || {}), cfg.providers || {});
  const codex = Object.assign({}, CODEX, cfg.codex || {});
  const publicUrl = String(cfg.publicUrl || '').replace(/\/+$/, '');
  const redirectUri = publicUrl + '/v1/oauth/callback';
  const refreshing = new Map(), devices = new Map();
  const http = async (url, o) => { const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, o)); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {} return { status: r.status, text, json }; };
  const said = (r) => { const j = r.json || {}; const m = j.error_description || (j.error && (j.error.message || j.error)) || j.message || ''; return typeof m === 'string' ? m : JSON.stringify(m); };

  const configured = (id) => { const p = providers[id]; return !!(p && p.clientId && publicUrl); };
  function list(user) {
    const rows = Object.keys(providers).map((id) => { const s = store.oauthGet(user.id, id); return { id, name: providers[id].name, configured: configured(id), connected: !!s, at: (s && s.at) || 0, who: (s && s.who) || '', scopes: (s && s.scopes) || [], secrets: providers[id].secrets }; });
    const c = store.oauthGet(user.id, 'codex');
    rows.push({ id: 'codex', name: 'Codex (ChatGPT)', configured: true, connected: !!c, who: (c && c.email) || '', plan: (c && c.plan) || '', secrets: [] });
    return rows;
  }
  /** Step 1: the address the user's browser must open. */
  function start(user, id, scopes) {
    const p = providers[id];
    if (!p) throw Object.assign(new Error('Unknown sign-in provider: ' + id), { status: 404 });
    if (!configured(id)) throw Object.assign(new Error(p.name + ' sign-in is not set up on this server (client id or public address missing).'), { status: 409 });
    const have = store.oauthGet(user.id, id);
    const all = [...new Set([].concat(p.baseScopes, (have && have.scopes) || [], scopes || []))];
    const state = b64u(crypto.randomBytes(24)), verifier = b64u(crypto.randomBytes(32));
    store.cachePut('oauth-state:' + state, { user: user.id, provider: id, verifier, scopes: all }, 10 * 60 * 1000);
    const q = Object.assign({ response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri, scope: all.join(p.scopeSep), state, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }, p.extra);
    return { url: p.authUrl + '?' + form(q), state };
  }
  /** Step 2: the provider sent the browser back with a code. Exchange it and store the session. Returns a line for the page. */
  async function callback(query) {
    const st = query.state ? store.cacheGet('oauth-state:' + query.state) : null;
    if (!st) return { ok: false, message: 'This sign-in link has expired or was already used. Start again from the app.' };
    store.cachePut('oauth-state:' + query.state, null, 1); // one use only
    const p = providers[st.provider];
    if (query.error) return { ok: false, message: p.name + ' did not allow it: ' + (query.error_description || query.error) };
    if (!query.code) return { ok: false, message: 'No code came back from ' + p.name + '.' };
    const r = await http(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri, client_id: p.clientId, client_secret: p.clientSecret || undefined, code_verifier: st.verifier }) });
    if (r.status >= 400 || !r.json || !r.json.access_token) return { ok: false, message: p.name + ' refused the sign-in' + (said(r) ? ': ' + said(r) : ' (HTTP ' + r.status + ')') + '.' };
    const prev = store.oauthGet(st.user, st.provider) || {};
    const s = { access: r.json.access_token, refresh: r.json.refresh_token || prev.refresh || '', exp: r.json.expires_in ? Date.now() + r.json.expires_in * 1000 : 0, scopes: r.json.scope ? String(r.json.scope).split(/[ ,]+/).filter(Boolean) : st.scopes, who: '', at: Date.now() };
    if (p.who) { try { const w = await http(p.who.url, { headers: { Authorization: 'Bearer ' + s.access, Accept: 'application/json', 'User-Agent': 'cybnate-server' } }); if (w.json && w.json[p.who.field]) s.who = String(w.json[p.who.field]); } catch (e) { /* the session works without the name */ } }
    store.oauthPut(st.user, st.provider, s);
    return { ok: true, message: 'Connected to ' + p.name + (s.who ? ' as ' + s.who : '') + '. You can go back to CybNate.' };
  }
  const once = (key, fn) => { if (!refreshing.has(key)) refreshing.set(key, fn().finally(() => refreshing.delete(key))); return refreshing.get(key); };
  /** A valid access token for a provider, renewed first when it is about to run out. Null when the user is not connected. */
  async function accessToken(user, id) {
    if (id === 'codex') return (await codexSession(user)).access;
    const p = providers[id]; let s = store.oauthGet(user.id, id); if (!p || !s) return null;
    if (s.exp && s.exp - Date.now() < 60000 && s.refresh) {
      s = await once(user.id + ':' + id, async () => {
        const r = await http(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form({ grant_type: 'refresh_token', refresh_token: s.refresh, client_id: p.clientId, client_secret: p.clientSecret || undefined }) });
        if (r.status >= 400 || !r.json || !r.json.access_token) {
          // a refused refresh token will never work again: forget the session so the app shows "sign in again"
          if (r.status === 400 || r.status === 401) store.oauthDel(user.id, id);
          throw Object.assign(new Error(p.name + ' sign-in has expired' + (said(r) ? ': ' + said(r) : '') + '. Sign in again.'), { status: 401 });
        }
        const n = Object.assign({}, s, { access: r.json.access_token, refresh: r.json.refresh_token || s.refresh, exp: r.json.expires_in ? Date.now() + r.json.expires_in * 1000 : 0 });
        store.oauthPut(user.id, id, n); return n;
      });
    }
    return s.access;
  }
  /** Secret names that stand for a sign-in ("GMAIL_ACCESS_TOKEN" -> google). */
  const providerOfSecret = (name) => Object.keys(providers).find((id) => providers[id].secrets.includes(name)) || '';
  async function disconnect(user, id) {
    const s = store.oauthGet(user.id, id); if (!s) return false;
    const p = providers[id];
    if (p && p.revokeUrl) { try { await http(p.revokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token: s.refresh || s.access }) }); } catch (e) { /* removed here either way */ } }
    return store.oauthDel(user.id, id);
  }

  // ---------------------------------------------------------------- Codex (device code)
  const codexFromTokens = (j, prev) => {
    prev = prev || {}; const idt = j.id_token || prev.idToken || ''; const a = claims(idt), b = claims(j.access_token);
    const auth = a['https://api.openai.com/auth'] || b['https://api.openai.com/auth'] || {}, prof = b['https://api.openai.com/profile'] || {};
    return { access: j.access_token, refresh: j.refresh_token || prev.refresh || '', idToken: idt, account: auth.chatgpt_account_id || prev.account || '', plan: auth.chatgpt_plan_type || prev.plan || '', email: a.email || prof.email || prev.email || '', exp: (b.exp || 0) * 1000, at: prev.at || Date.now() };
  };
  async function codexStart(user) {
    const old = devices.get(user.id); if (old) old.cancelled = true;
    const r = await http(codex.issuer + '/api/accounts/deviceauth/usercode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: codex.clientId }) });
    const code = r.json && (r.json.user_code || r.json.usercode);
    if (r.status >= 400 || !code || !r.json.device_auth_id) throw Object.assign(new Error('OpenAI did not start the sign-in (HTTP ' + r.status + ').'), { status: 502 });
    const d = { state: 'pending', code, id: r.json.device_auth_id, intervalMs: codex.pollMs || Math.max(2, parseInt(r.json.interval, 10) || 5) * 1000, until: Date.now() + 15 * 60 * 1000, error: '', cancelled: false };
    devices.set(user.id, d);
    const poll = async () => {
      if (d.cancelled) return;
      if (Date.now() > d.until) { d.state = 'error'; d.error = 'The code expired after 15 minutes. Start again.'; return; }
      try {
        const p = await http(codex.issuer + '/api/accounts/deviceauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_auth_id: d.id, user_code: d.code }) });
        if (p.status === 403 || p.status === 404) return void (d.timer = setTimeout(poll, d.intervalMs));
        if (p.status >= 400 || !p.json || !p.json.authorization_code) throw new Error('OpenAI stopped the sign-in (HTTP ' + p.status + ').');
        const t = await http(codex.issuer + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', client_id: codex.clientId, code: p.json.authorization_code, redirect_uri: codex.issuer + '/deviceauth/callback', code_verifier: p.json.code_verifier }) });
        if (t.status >= 400 || !t.json || !t.json.access_token) throw new Error('OpenAI refused the sign-in' + (said(t) ? ': ' + said(t) : ' (HTTP ' + t.status + ')') + '.');
        if (d.cancelled) return;
        store.oauthPut(user.id, 'codex', codexFromTokens(t.json)); d.state = 'connected';
      } catch (e) { d.state = 'error'; d.error = e.message; }
    };
    d.timer = setTimeout(poll, d.intervalMs);
    return { code: d.code, url: codex.issuer + '/codex/device', intervalMs: d.intervalMs };
  }
  function codexStatus(user) {
    const d = devices.get(user.id), s = store.oauthGet(user.id, 'codex');
    if (d && d.state === 'pending') return { state: 'pending', code: d.code };
    if (d && d.state === 'error' && !s) return { state: 'error', error: d.error };
    return s ? { state: 'connected', email: s.email, plan: s.plan } : { state: 'none' };
  }
  function codexCancel(user) { const d = devices.get(user.id); if (d) { d.cancelled = true; clearTimeout(d.timer); devices.delete(user.id); } }
  async function codexSession(user) {
    let s = store.oauthGet(user.id, 'codex');
    if (!s) throw Object.assign(new Error('Sign in with ChatGPT first.'), { status: 401 });
    if (s.refresh && s.exp && s.exp - Date.now() < 5 * 60 * 1000) {
      s = await once(user.id + ':codex', async () => {
        const r = await http(codex.issuer + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', client_id: codex.clientId, refresh_token: s.refresh }) });
        if (r.status >= 400 || !r.json || !r.json.access_token) { if (r.status === 400 || r.status === 401) store.oauthDel(user.id, 'codex'); throw Object.assign(new Error('The ChatGPT sign-in has expired' + (said(r) ? ': ' + said(r) : '') + '. Sign in again.'), { status: 401 }); }
        const n = codexFromTokens(r.json, s); store.oauthPut(user.id, 'codex', n); return n;
      });
    }
    return s;
  }
  const codexHeaders = (s) => Object.assign({ Authorization: 'Bearer ' + s.access, originator: 'cybnate' }, s.account ? { 'ChatGPT-Account-ID': s.account } : {});
  const stop = () => devices.forEach((d) => { d.cancelled = true; clearTimeout(d.timer); });

  return { providers, codex, redirectUri, configured, list, start, callback, accessToken, providerOfSecret, disconnect, codexStart, codexStatus, codexCancel, codexSession, codexHeaders, stop };
}

module.exports = { create };
