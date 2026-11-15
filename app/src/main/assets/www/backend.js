/*
 * Client of the CybNate server (see server/ and docs/BACKEND.md).
 * When a server is connected, commands run there, secrets and sign-ins live there, and this file keeps the
 * phone's workspace and the server's copy the same. Works in the app page and in Node (for tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Backend = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += B64[a >> 2] + B64[((a & 3) << 4) | ((b || 0) >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c || 0) >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=');
    }
    return out;
  }
  function unb64(s) {
    s = String(s || '').replace(/[^A-Za-z0-9+/]/g, ''); const out = new Uint8Array(Math.floor((s.length * 3) / 4)); let n = 0;
    for (let i = 0; i < s.length; i += 4) {
      const a = B64.indexOf(s[i]), b = B64.indexOf(s[i + 1]), c = s[i + 2] ? B64.indexOf(s[i + 2]) : -1, d = s[i + 3] ? B64.indexOf(s[i + 3]) : -1;
      out[n++] = (a << 2) | (b >> 4); if (c >= 0) out[n++] = ((b & 15) << 4) | (c >> 2); if (d >= 0) out[n++] = ((c & 3) << 6) | d;
    }
    return out.subarray(0, n);
  }
  const cleanUrl = (u) => { u = String(u || '').trim().replace(/\/+$/, ''); if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u; return u; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const MAX_FILE = 16 * 1048576, BATCH = 6 * 1048576;

  /**
   * o.http(url, {method, headers, body, signal}) -> {status, text}   (the app's own request function)
   * o.get() -> {url, token} or null;  o.ws: the Workspace;  o.decode(bytes) -> text or null for binary
   * o.remoteOnly: {list(), set(paths)} files that exist on the server only because they are too large for the phone
   * o.applying(fn): run fn while workspace changes are NOT recorded as "to upload" (they came from the server)
   */
  function create(o) {
    const dirty = new Map(); let synced = false, syncing = null;
    const on = () => { const c = o.get(); return !!(c && c.url && c.token); };

    async function call(method, path, body, opt) {
      opt = opt || {}; const c = opt.cfg || o.get();
      if (!c || !c.url) throw new Error('No server is connected. Open Settings → Server.');
      const headers = { 'Content-Type': 'application/json' };
      if (c.token) headers.Authorization = 'Bearer ' + c.token;
      if (opt.idem) headers['Idempotency-Key'] = opt.idem;
      let r, tries = 0;
      for (;;) {
        try { r = await o.http(c.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opt.signal }); break; }
        catch (e) {
          if (e && e.name === 'AbortError') throw e;
          // a request that carries an idempotency key is safe to send again: the server runs it once
          if ((opt.idem || method === 'GET') && tries++ < 2) { await new Promise((res) => setTimeout(res, 400 * tries)); continue; }
          throw new Error('Could not reach the server at ' + c.url.replace(/^https?:\/\//, '') + '. Check the internet connection and that the server is running.');
        }
      }
      let j = null; try { j = JSON.parse(r.text); } catch (e) { /* not JSON */ }
      const status = j && j.status >= 400 && j.error ? j.status : r.status; // long calls report their status inside the body
      if (status >= 400 || !j) {
        const err = new Error(j && j.error ? j.error : status === 404 || !j ? 'That address does not answer like a CybNate server (HTTP ' + r.status + ').' : 'The server answered HTTP ' + status + '.');
        err.status = status; err.body = j; throw err;
      }
      return j;
    }

    const health = (url) => call('GET', '/v1/health', undefined, { cfg: { url: cleanUrl(url) } });
    /** Register this phone. Returns the settings to store: { url, token, userId }. */
    async function pair(url, accessKey, name) {
      url = cleanUrl(url); if (!url) throw new Error('Enter the address of the server.');
      const h = await call('GET', '/v1/health', undefined, { cfg: { url } });
      if (!h || h.name !== 'cybnate-server') throw new Error('That address does not answer like a CybNate server.');
      const r = await call('POST', '/v1/auth/register', { accessKey: String(accessKey || '').trim(), name: name || '', device: 'android' }, { cfg: { url } });
      synced = false; dirty.clear();
      return { url, token: r.token, userId: r.userId, at: Date.now() };
    }

    // ------------------------------------------------------------ workspace
    /** Called for every workspace change made on the phone. */
    function note(path, value) { dirty.set(path, value === null ? 'd' : 'w'); }
    async function push(writes, removes, signal) {
      let batch = [], size = 0; const flush = async () => { if (!batch.length) return; await call('POST', '/v1/files/sync', { write: batch }, { idem: uid(), signal }); batch = []; size = 0; };
      const skipped = [];
      for (const p of writes) {
        if (!o.ws.has(p)) continue; const bytes = o.ws.bytes(p);
        if (bytes.length > MAX_FILE) { skipped.push(p); continue; }
        const enc = b64(bytes); if (size + enc.length > BATCH) await flush();
        batch.push({ path: p, b64: enc }); size += enc.length;
      }
      await flush();
      if (removes.length) await call('POST', '/v1/files/sync', { remove: removes }, { idem: uid(), signal });
      return skipped;
    }
    /** Make the server's copy equal to the phone's. The first time after a start everything is compared; later only what changed. */
    function sync(signal) {
      if (syncing) return syncing;
      syncing = (async () => {
        if (!synced) {
          const remote = new Map(); (await call('GET', '/v1/files', undefined, { signal })).files.forEach((f) => remote.set(f.path, f));
          const keep = new Set(o.remoteOnly.list()); const local = o.ws.list();
          // same size is not proof of same content, so everything that exists here is sent unless the server already has identical bytes
          const hash = await hasher();
          const writes = [];
          for (const p of local) { const f = remote.get(p); const bytes = o.ws.bytes(p); if (!f || f.size !== bytes.length || !hash || (await hash(bytes)) !== f.sha1) writes.push(p); }
          const have = new Set(local); const removes = [...remote.keys()].filter((p) => !have.has(p) && !keep.has(p));
          o.remoteOnly.set([...keep].filter((p) => remote.has(p)));
          dirty.clear(); await push(writes, removes, signal); synced = true;
          return { written: writes.length, removed: removes.length, full: true };
        }
        const snap = [...dirty.entries()]; dirty.clear();
        try { await push(snap.filter((e) => e[1] === 'w').map((e) => e[0]), snap.filter((e) => e[1] === 'd' || !o.ws.has(e[0])).map((e) => e[0]), signal); }
        catch (e) { snap.forEach((x) => { if (!dirty.has(x[0])) dirty.set(x[0], x[1]); }); throw e; }
        return { written: snap.length, removed: 0, full: false };
      })().finally(() => { syncing = null; });
      return syncing;
    }
    async function hasher() {
      const subtle = typeof crypto !== 'undefined' && crypto.subtle; if (!subtle) return null;
      try { await subtle.digest('SHA-1', new Uint8Array(1)); } catch (e) { return null; }
      return async (bytes) => { const d = new Uint8Array(await subtle.digest('SHA-1', bytes)); let s = ''; for (let i = 0; i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16); return s; };
    }
    /** Take over what a command changed on the server. Returns the list for the result. */
    function apply(r) {
      const big = (r.changed || []).filter((c) => c.tooBig).map((c) => c.path), changed = (r.changed || []).filter((c) => !c.tooBig), deleted = r.deleted || [];
      const keep = new Set(o.remoteOnly.list()); big.forEach((p) => keep.add(p)); changed.concat(deleted.map((p) => ({ path: p }))).forEach((c) => keep.delete(c.path)); o.remoteOnly.set([...keep]);
      o.applying(() => {
        changed.forEach((c) => { const bytes = unb64(c.b64); const t = o.decode(bytes); o.ws.set(c.path, t != null ? t : bytes); });
        deleted.forEach((p) => { if (o.ws.has(p)) o.ws.remove(p); });
      });
      return { big, files: (r.changed || []).map((c) => c.path).concat(deleted.map((p) => p + ' (deleted)')) };
    }

    /** Run a command on the server. Same result shape as a local run: { code, out, files, timedOut, changed, deleted }. */
    async function exec(command, timeoutSec, signal, secretNames) {
      await sync(signal);
      const id = uid(); let stopped = false;
      const stop = () => { stopped = true; call('POST', '/v1/exec/' + id + '/cancel', {}).catch(() => {}); };
      if (signal) { if (signal.aborted) { const e = new Error('Stopped'); e.name = 'AbortError'; throw e; } signal.addEventListener('abort', stop); }
      let r;
      try { r = await call('POST', '/v1/exec', { command, timeoutSec, secrets: secretNames || [], id }, { idem: id }); }
      catch (e) {
        if (e.status === 429) return { code: 1, out: e.message, files: [], changed: [], deleted: [] };
        // the answer was lost on the way: the phone no longer knows what the command changed, so compare everything next time
        synced = false; throw e;
      } finally { if (signal) signal.removeEventListener('abort', stop); }
      const got = apply(r);
      if (stopped && !r.stopped) r.out = (r.out || '') + '\n[stopped by the user]';
      if (r.missingSecrets && r.missingSecrets.length) r.out = (r.out || '') + '\nNote: not stored on the server, so not passed: ' + r.missingSecrets.join(', ');
      if (got.big.length) r.out = (r.out || '') + '\nNote: too large to load onto the phone, kept on the server for commands only (not in Files, Undo or GitHub push): ' + got.big.join(', ');
      r.files = got.files;
      return r;
    }
    /** Problems a language server reports for one file, as text for the terminal or the agent. */
    async function diagnostics(path, signal) {
      await sync(signal);
      let r; try { r = await call('POST', '/v1/lsp/diagnostics', { path }, { signal }); } catch (e) { if (e.name === 'AbortError') throw e; return { code: e.status === 404 ? 2 : 1, out: e.message, files: [] }; }
      if (!r.items.length) return { code: 0, out: path + ': no problems found (' + r.lang + ' language server' + (r.ready ? '' : ', still starting; ask again') + ').', files: [] };
      const errs = r.items.filter((i) => i.severity === 'error').length;
      return { code: errs ? 1 : 0, out: r.items.slice(0, 200).map((i) => path + ':' + i.line + ':' + i.column + ' ' + i.severity + ': ' + i.message + (i.code ? ' [' + i.code + ']' : '')).join('\n') + '\n' + r.items.length + ' problem' + (r.items.length === 1 ? '' : 's') + ' (' + errs + ' error' + (errs === 1 ? '' : 's') + ').', files: [] };
    }

    // ------------------------------------------------------------ secrets and sign-in
    const putSecret = (name, value) => (value ? call('PUT', '/v1/secrets/' + encodeURIComponent(name), { value }) : call('DELETE', '/v1/secrets/' + encodeURIComponent(name)));
    const secrets = async () => (await call('GET', '/v1/secrets')).secrets;
    const signIns = async (signal) => call('GET', '/v1/oauth', undefined, { signal });
    const oauthStart = (provider, scopes) => call('POST', '/v1/oauth/' + provider + '/start', { scopes: scopes || [] });
    const oauthOff = (provider) => call('DELETE', '/v1/oauth/' + provider);
    const codexStart = () => call('POST', '/v1/oauth/codex/device', {});
    const codexStatus = (signal) => call('GET', '/v1/oauth/codex/status', undefined, { signal });
    const codexCancel = () => call('DELETE', '/v1/oauth/codex/device');
    const logout = () => call('POST', '/v1/auth/logout', {});
    const reset = () => { synced = false; dirty.clear(); };

    return { on, call, health, pair, note, sync, exec, apply, diagnostics, putSecret, secrets, signIns, oauthStart, oauthOff, codexStart, codexStatus, codexCancel, logout, reset, pending: () => dirty.size, isSynced: () => synced };
  }
  return { create, b64, unb64, cleanUrl };
});
