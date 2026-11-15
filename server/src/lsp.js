'use strict';
/*
 * Language servers, one per user and language, started on first use and stopped after a quiet period.
 * Speaks LSP over stdio (Content-Length frames) and offers the app plain HTTP calls instead.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const DEFAULT_SERVERS = {
  typescript: { cmd: ['typescript-language-server', '--stdio'], ext: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'], ids: { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript' } },
  python: { cmd: ['pyright-langserver', '--stdio'], ext: ['py'], ids: { py: 'python' } },
};

function create(workspace, execEnv, opts) {
  opts = opts || {};
  const servers = Object.assign({}, DEFAULT_SERVERS, opts.servers || {});
  const idleMs = opts.idleMs || 10 * 60 * 1000, maxPerUser = opts.maxPerUser || 3;
  const sessions = new Map();
  const langOf = (file) => { const ext = String(file).split('.').pop().toLowerCase(); return Object.keys(servers).find((l) => servers[l].ext.includes(ext)) || ''; };

  function start(user, lang) {
    const spec = servers[lang]; if (!spec) throw Object.assign(new Error('No language server is set up for "' + lang + '".'), { status: 404 });
    const mine = [...sessions.values()].filter((s) => s.user === user.id);
    if (mine.length >= maxPerUser) mine.sort((a, b) => a.used - b.used)[0].stop(); // the least recently used one makes room
    const d = workspace.ensure(user);
    const child = spawn(spec.cmd[0], spec.cmd.slice(1), Object.assign({ cwd: d.ws, env: execEnv(user), stdio: ['pipe', 'pipe', 'pipe'] }, workspace.ids(user)));
    const s = { user: user.id, lang, child, seq: 0, pending: new Map(), events: [], eventSeq: 0, open: new Map(), used: Date.now(), dead: false, stderr: '', waiters: [] };
    let buf = Buffer.alloc(0);
    const send = (msg) => { if (s.dead) return; const body = Buffer.from(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, msg))); child.stdin.write('Content-Length: ' + body.length + '\r\n\r\n'); child.stdin.write(body); };
    const onMessage = (m) => {
      if (m.id != null && m.method) return send({ id: m.id, result: m.method === 'workspace/configuration' ? (m.params && m.params.items ? m.params.items.map(() => null) : []) : null }); // the server asks the client something: answer "nothing special"
      if (m.id != null) { const p = s.pending.get(m.id); if (p) { s.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Object.assign(new Error(m.error.message || 'language server error'), { status: 502 })) : p.resolve(m.result); } return; }
      const ev = { seq: ++s.eventSeq, method: m.method, params: m.params }; s.events.push(ev); if (s.events.length > 500) s.events.shift();
      s.waiters = s.waiters.filter((w) => !w(ev));
    };
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const sep = buf.indexOf('\r\n\r\n'); if (sep < 0) return;
        const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString('ascii')); if (!m) { buf = buf.subarray(sep + 4); continue; }
        const len = Number(m[1]); if (buf.length < sep + 4 + len) return;
        const body = buf.subarray(sep + 4, sep + 4 + len); buf = buf.subarray(sep + 4 + len);
        try { onMessage(JSON.parse(body.toString('utf8'))); } catch (e) { /* not JSON: skip the frame */ }
      }
    });
    child.stderr.on('data', (c) => { s.stderr = (s.stderr + c.toString('utf8')).slice(-2000); });
    const die = (why) => { if (s.dead) return; s.dead = true; clearTimeout(s.idle); sessions.delete(user.id + ':' + lang); s.pending.forEach((p) => { clearTimeout(p.timer); p.reject(Object.assign(new Error('The language server stopped' + (why ? ': ' + why : '') + (s.stderr ? '\n' + s.stderr.trim().slice(-300) : '')), { status: 502 })); }); s.pending.clear(); };
    child.on('error', (e) => die(e.code === 'ENOENT' ? spec.cmd[0] + ' is not installed on the server' : e.message));
    child.on('close', () => die(''));
    child.stdin.on('error', () => {});
    s.request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
      if (s.dead) return reject(Object.assign(new Error('The language server is not running.'), { status: 502 }));
      const id = ++s.seq; const timer = setTimeout(() => { s.pending.delete(id); reject(Object.assign(new Error('The language server did not answer "' + method + '" in time.'), { status: 504 })); }, timeoutMs || 20000);
      s.pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
    s.notify = (method, params) => send({ method, params });
    s.stop = () => { try { s.notify('exit'); } catch (e) {} try { child.kill('SIGKILL'); } catch (e) {} die('stopped'); };
    s.touch = () => { s.used = Date.now(); clearTimeout(s.idle); s.idle = setTimeout(s.stop, idleMs); s.idle.unref(); };
    s.root = d.ws;
    s.ready = s.request('initialize', { processId: process.pid, rootUri: pathToFileURL(d.ws).href, workspaceFolders: [{ uri: pathToFileURL(d.ws).href, name: 'workspace' }], capabilities: { textDocument: { publishDiagnostics: {}, hover: { contentFormat: ['plaintext', 'markdown'] }, completion: { completionItem: { snippetSupport: false } }, definition: {}, references: {}, documentSymbol: {} }, workspace: { configuration: true, workspaceFolders: true } } }, 30000)
      .then((r) => { s.notify('initialized', {}); s.capabilities = (r && r.capabilities) || {}; });
    s.ready.catch(() => {});
    sessions.set(user.id + ':' + lang, s); s.touch();
    return s;
  }
  async function session(user, lang) { const s = sessions.get(user.id + ':' + lang) || start(user, lang); await s.ready; s.touch(); return s; }
  /** Tell the server the current text of a workspace file (open it, or send the new version). Returns its URI. */
  async function sync(user, s, rel) {
    const abs = workspace.resolve(user, rel), uri = pathToFileURL(abs).href, text = await fs.readFile(abs, 'utf8');
    const spec = servers[s.lang], ext = rel.split('.').pop().toLowerCase(), cur = s.open.get(uri);
    if (!cur) { s.open.set(uri, { version: 1, text }); s.notify('textDocument/didOpen', { textDocument: { uri, languageId: (spec.ids && spec.ids[ext]) || s.lang, version: 1, text } }); return { uri, changed: true }; }
    if (cur.text === text) return { uri, changed: false };
    cur.version++; cur.text = text; s.notify('textDocument/didChange', { textDocument: { uri, version: cur.version }, contentChanges: [{ text }] });
    return { uri, changed: true };
  }
  /** Errors and warnings of one file, as the language server reports them after reading the file from disk. */
  async function diagnostics(user, rel, waitMs) {
    const lang = langOf(rel); if (!lang) throw Object.assign(new Error('No language server is set up for this kind of file.'), { status: 404 });
    const s = await session(user, lang); const from = s.eventSeq;
    const { uri, changed } = await sync(user, s, rel);
    const match = (ev) => ev.method === 'textDocument/publishDiagnostics' && ev.params && ev.params.uri === uri;
    let ev = s.events.filter((e) => e.seq > from).reverse().find(match);
    if (!ev && !changed) ev = s.events.slice().reverse().find(match); // nothing new to analyse: the last report still stands
    if (!ev) ev = await new Promise((resolve) => { const t = setTimeout(() => resolve(null), waitMs || 8000); s.waiters.push((e) => { if (!match(e)) return false; clearTimeout(t); resolve(e); return true; }); });
    if (!ev) return { lang, ready: false, items: [] };
    const sev = ['', 'error', 'warning', 'info', 'hint'];
    return { lang, ready: true, items: (ev.params.diagnostics || []).map((x) => ({ line: x.range.start.line + 1, column: x.range.start.character + 1, severity: sev[x.severity || 1], message: x.message, source: x.source || '', code: x.code == null ? '' : String(x.code) })) };
  }
  /** Any LSP request about a workspace file; "path" in the body is turned into the document URI after the file is synced. */
  async function request(user, lang, method, params, rel) {
    const s = await session(user, lang); params = Object.assign({}, params || {});
    if (rel) { const { uri } = await sync(user, s, rel); params.textDocument = Object.assign({}, params.textDocument || {}, { uri }); }
    return s.request(method, params);
  }
  const events = async (user, lang, since) => { const s = sessions.get(user.id + ':' + lang); return s ? { seq: s.eventSeq, events: s.events.filter((e) => e.seq > (since || 0)) } : { seq: 0, events: [] }; };
  const stop = (user, lang) => { const s = sessions.get(user.id + ':' + lang); if (s) s.stop(); return !!s; };
  const stopAll = () => [...sessions.values()].forEach((s) => s.stop());
  return { langOf, languages: () => Object.keys(servers), session, diagnostics, request, events, stop, stopAll, count: () => sessions.size };
}

module.exports = { create };
