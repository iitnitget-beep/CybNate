/*
 * Wire formats and sign-in helpers for model providers that do not speak the OpenAI chat format.
 *   anthropic : Anthropic Messages API (API key)
 *   codex     : ChatGPT sign-in (device code) + the Responses format of the ChatGPT backend
 * Pure functions only: no network, no storage. app.js does the requests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Wire = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CODEX = {
    // the public client id of the open-source Codex CLI (codex-rs/login); there is no secret
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    issuer: 'https://auth.openai.com',
    userCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'https://auth.openai.com/deviceauth/callback',
    verifyUrl: 'https://auth.openai.com/codex/device',
    maxWaitMs: 15 * 60 * 1000,
  };

  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('') : c == null ? '' : String(c));
  const form = (o) => Object.keys(o).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

  /** Claims of a JWT, or {} when it cannot be read. The signature is not checked: the token came straight from the issuer over TLS. */
  function jwtClaims(token) {
    try {
      let b = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
      const bin = typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('binary');
      return JSON.parse(decodeURIComponent(bin.split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
    } catch (e) { return {}; }
  }

  // ------------------------------------------------------------ codex sign-in
  const codexUserCodeRequest = () => ({ url: CODEX.userCodeUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: CODEX.clientId }) });
  /** { id, code, intervalMs } from the answer of the user-code request. */
  function codexUserCode(status, text) {
    if (status === 404) throw new Error('OpenAI says device-code sign-in is not available (HTTP 404).');
    if (status >= 400 || !status) throw new Error('OpenAI did not start the sign-in (HTTP ' + status + ').');
    const j = JSON.parse(text); const code = j.user_code || j.usercode;
    if (!j.device_auth_id || !code) throw new Error('OpenAI sent a sign-in answer this app does not understand.');
    return { id: j.device_auth_id, code, intervalMs: Math.max(2, parseInt(j.interval, 10) || 5) * 1000 };
  }
  const codexPollRequest = (dc) => ({ url: CODEX.pollUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_auth_id: dc.id, user_code: dc.code }) });
  /** 'wait' while the user has not finished, or { code, verifier } once they have. */
  function codexPoll(status, text) {
    if (status === 403 || status === 404) return 'wait';
    if (status >= 400 || !status) throw new Error('OpenAI stopped the sign-in (HTTP ' + status + ').');
    const j = JSON.parse(text);
    if (!j.authorization_code || !j.code_verifier) throw new Error('OpenAI sent a sign-in answer this app does not understand.');
    return { code: j.authorization_code, verifier: j.code_verifier };
  }
  const tokenReq = (o) => ({ url: CODEX.tokenUrl, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(o) });
  const codexExchangeRequest = (got) => tokenReq({ grant_type: 'authorization_code', client_id: CODEX.clientId, code: got.code, redirect_uri: CODEX.redirectUri, code_verifier: got.verifier });
  const codexRefreshRequest = (refresh) => tokenReq({ grant_type: 'refresh_token', client_id: CODEX.clientId, refresh_token: refresh });
  /** The stored session from a token answer. `prev` keeps what a refresh does not send again. */
  function codexSession(status, text, prev) {
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    if (status >= 400 || !status || !j || !j.access_token) {
      const said = j && (j.error_description || (j.error && (j.error.message || j.error)) || j.message);
      throw new Error('OpenAI refused the sign-in (HTTP ' + status + ')' + (said ? ': ' + (typeof said === 'string' ? said : JSON.stringify(said)) : '') + '.');
    }
    prev = prev || {};
    const idTok = j.id_token || prev.idToken || '';
    const idc = jwtClaims(idTok), acc = jwtClaims(j.access_token);
    const a = idc['https://api.openai.com/auth'] || acc['https://api.openai.com/auth'] || {};
    const prof = idc['https://api.openai.com/profile'] || acc['https://api.openai.com/profile'] || {};
    return {
      access: j.access_token, refresh: j.refresh_token || prev.refresh || '', idToken: idTok,
      account: a.chatgpt_account_id || prev.account || '', plan: a.chatgpt_plan_type || prev.plan || '',
      email: idc.email || prof.email || prev.email || '',
      exp: (acc.exp || 0) * 1000, at: prev.at || 0,
    };
  }
  /** True when the access token should be renewed before it is used. */
  const codexStale = (s, now) => !!(s && s.refresh && s.exp && s.exp - now < 5 * 60 * 1000);
  const codexHeaders = (s) => { const h = { Authorization: 'Bearer ' + ((s && s.access) || ''), originator: 'cybnate' }; if (s && s.account) h['ChatGPT-Account-ID'] = s.account; return h; };
  /** Models from GET /codex/models: [{ id, name, ctx }], the ones meant for a model picker first. */
  function codexModels(json) {
    let arr = (json && (json.models || json.data)) || [];
    const shown = arr.filter((m) => m && (m.visibility == null || m.visibility === 'list'));
    if (shown.length) arr = shown;
    return arr.filter((m) => m && (m.slug || m.id)).sort((a, b) => (a.priority == null ? 1e9 : a.priority) - (b.priority == null ? 1e9 : b.priority))
      .map((m) => ({ id: m.slug || m.id, name: m.display_name || m.slug || m.id, ctx: m.context_window || 0 }));
  }
  const PLAN_NAMES = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
  const planName = (p) => (p ? PLAN_NAMES[String(p).toLowerCase()] || String(p) : '');

  // ------------------------------------------------------------ request bodies
  /** Body for the ChatGPT backend (Responses format). The system prompt travels as a developer message, as in the Codex CLI. */
  function codexBody(model, messages) {
    const input = (messages || []).map((m) => {
      const text = textOf(m.content); if (!text) return null;
      const role = m.role === 'system' ? 'developer' : m.role === 'assistant' ? 'assistant' : 'user';
      return { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] };
    }).filter(Boolean);
    return { model, stream: true, input, tool_choice: 'auto', parallel_tool_calls: false, reasoning: null, store: false, include: [] };
  }
  /** Body for the Anthropic Messages API: system text apart, turns alternate and start with the user. */
  function anthropicBody(model, messages, maxTokens) {
    const system = [], turns = [];
    (messages || []).forEach((m) => {
      const text = textOf(m.content); if (!text) return;
      if (m.role === 'system') return void system.push(text);
      const role = m.role === 'assistant' ? 'assistant' : 'user', last = turns[turns.length - 1];
      if (last && last.role === role) last.content += '\n\n' + text; else turns.push({ role, content: text });
    });
    if (!turns.length || turns[0].role !== 'user') turns.unshift({ role: 'user', content: 'Continue.' });
    const body = { model, max_tokens: maxTokens || 8192, stream: true, messages: turns };
    if (system.length) body.system = system.join('\n\n');
    return body;
  }
  const body = (api, model, messages) => (api === 'codex' ? codexBody(model, messages) : anthropicBody(model, messages));

  // ------------------------------------------------------------ stream parsers
  /** Reads a server-sent-event stream. feed(chunk) returns events shaped like core.createSseParser: {text} | {thinking} | {error}. */
  function parser(api) {
    let buf = '', streamed = false;
    const one = (j) => {
      if (!j || typeof j !== 'object') return null;
      const t = j.type || '';
      if (api === 'codex') {
        if (t === 'response.output_text.delta' && j.delta) { streamed = true; return { text: String(j.delta) }; }
        if (/^response\.reasoning/.test(t)) return { thinking: true };
        if (t === 'response.output_item.done' && !streamed && j.item && j.item.type === 'message') {
          const text = (j.item.content || []).map((c) => (c && c.type === 'output_text' ? c.text || '' : '')).join('');
          return text ? { text } : null;
        }
        if (t === 'response.output_item.done') streamed = false;
        if (t === 'response.failed' || t === 'error') { const e = (j.response && j.response.error) || j.error || j; return { error: String(e.message || e.code || 'The model request failed.') }; }
        if (t === 'response.incomplete') { const r = j.response && j.response.incomplete_details && j.response.incomplete_details.reason; return streamed ? null : { error: 'The reply was cut short' + (r ? ' (' + r + ')' : '') + '.' }; }
        return null;
      }
      if (t === 'content_block_delta' && j.delta) {
        if (j.delta.type === 'text_delta' && j.delta.text) return { text: String(j.delta.text) };
        if (j.delta.type === 'thinking_delta') return { thinking: true };
      }
      if (t === 'error') return { error: String((j.error && j.error.message) || 'The model request failed.') };
      return null;
    };
    return {
      feed(chunk) {
        buf += chunk; const out = []; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (line.slice(0, 5) !== 'data:') continue;
          const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
          let j = null; try { j = JSON.parse(data); } catch (e) { continue; }
          const ev = one(j); if (ev) out.push(ev);
        }
        return out;
      },
      toolCalls: () => [],
    };
  }

  return {
    CODEX, jwtClaims, form, textOf,
    codexUserCodeRequest, codexUserCode, codexPollRequest, codexPoll, codexExchangeRequest, codexRefreshRequest, codexSession, codexStale, codexHeaders, codexModels, planName,
    codexBody, anthropicBody, body, parser,
  };
});
