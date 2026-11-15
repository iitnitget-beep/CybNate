/* CybNate UI. Depends on core.js, marked, DOMPurify, highlight.js. */
(function () {
  'use strict';
  const C = window.Core;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const Native = window.Native || null;

  // ------------------------------------------------------------------ state
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Storage is full. Delete some old chats.'); } };

  const settings = Object.assign({
    provider: 'pollinations', model: 'openai-fast', keys: {}, customUrl: '', models: {}, extra: '', maxSteps: 25,
  }, load('cyb.settings', {}));
  let sessions = load('cyb.sessions', []);
  let current = null;
  let busy = false, abortCtl = null;
  const saveSettings = () => save('cyb.settings', settings);
  const saveSessions = () => {
    // localStorage is small (about 5 MB), so drop the oldest chats until the rest fits.
    for (let keep = Math.min(sessions.length, 60); keep >= 1; keep = Math.floor(keep / 2)) {
      try { localStorage.setItem('cyb.sessions', JSON.stringify(sessions.slice(0, keep))); return; } catch (e) { if (keep === 1) break; }
    }
  };

  // ------------------------------------------------- workspace (IndexedDB)
  let db = null;
  let mirror = true; // false while applying changes that already exist on disk
  const canShell = !!(Native && Native.exec);
  const ws = new C.Workspace((path, value) => {
    if (db) {
      try {
        const st = db.transaction('files', 'readwrite').objectStore('files');
        if (value === null) st.delete(path); else st.put(value, path);
      } catch (e) { /* persistence is best effort */ }
    }
    if (canShell && mirror) {
      try {
        if (value === null) Native.wsDelete(path);
        else { const b = value instanceof Uint8Array ? value : C.utf8(value); if (b.length <= 20 * 1048576) Native.wsWrite(path, b64(b)); }
      } catch (e) { /* the shell will simply not see this file */ }
    }
    updateBadge();
  });
  /** Bring the on-disk copy used by shell commands in line with the workspace. */
  function syncDisk() {
    if (!canShell) return;
    try {
      const disk = JSON.parse(Native.wsList() || '{}');
      ws.list().forEach((p) => { const b = ws.bytes(p); if (disk[p] !== b.length && b.length <= 20 * 1048576) Native.wsWrite(p, b64(b)); });
      Object.keys(disk).forEach((p) => { if (!ws.has(p)) Native.wsDelete(p); });
    } catch (e) { /* ignore */ }
  }
  function openDb() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve();
      const rq = indexedDB.open('cybnate', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('files');
      rq.onerror = () => resolve();
      rq.onsuccess = () => {
        db = rq.result;
        const cur = db.transaction('files').objectStore('files').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (c) { ws.files.set(c.key, c.value); c.continue(); } else resolve(); };
        cur.onerror = () => resolve();
      };
    });
  }
  let sendIcon = '';
  function updateBadge() { const n = ws.list().length; $('fileBadge').hidden = !n; $('fileBadge').textContent = n; $('dCount').textContent = n ? n + (n === 1 ? ' file' : ' files') : ''; }

  // ------------------------------------------------------------------ http
  let nativeSeq = 0; const nativeReqs = {};
  window.__nh = (id, kind, data) => { const r = nativeReqs[id]; if (r) r(kind, data); };

  function nativeStream(url, opt, onChunk) {
    return new Promise((resolve, reject) => {
      const id = 'r' + (++nativeSeq); let status = 0, ctype = '';
      const done = () => { delete nativeReqs[id]; if (opt.signal) opt.signal.removeEventListener('abort', onAbort); };
      const onAbort = () => { try { Native.httpAbort(id); } catch (e) {} done(); reject(abortError()); };
      if (opt.signal) { if (opt.signal.aborted) return reject(abortError()); opt.signal.addEventListener('abort', onAbort); }
      nativeReqs[id] = (kind, data) => {
        if (kind === 'h') { const i = data.indexOf('|'); status = parseInt(data.slice(0, i), 10); ctype = data.slice(i + 1); }
        else if (kind === 'd') { try { onChunk(data); } catch (e) {} }
        else if (kind === 'x') { done(); resolve({ status, ctype }); }
        else if (kind === 'e') { done(); reject(new Error('Network error: ' + data)); }
      };
      Native.http(id, url, opt.method || 'GET', JSON.stringify(opt.headers || {}), opt.body || '');
    });
  }
  function abortError() { const e = new Error('Stopped'); e.name = 'AbortError'; return e; }

  /** Streams a response as text chunks. Uses fetch, and falls back to the native bridge when the browser blocks the request (CORS / mixed content). */
  async function httpStream(url, opt, onChunk) {
    let res;
    try {
      res = await fetch(url, { method: opt.method || 'GET', headers: opt.headers, body: opt.body, signal: opt.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (Native) return nativeStream(url, opt, onChunk);
      throw new Error('Could not reach ' + new URL(url).host + '. Check your internet connection.');
    }
    const reader = res.body.getReader(), td = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(td.decode(value, { stream: true }));
    }
    return { status: res.status, ctype: res.headers.get('content-type') || '' };
  }

  function providerCfg(id) {
    const p = Object.assign({}, C.PROVIDERS[id || settings.provider] || C.PROVIDERS.pollinations);
    if (p.custom) {
      const base = (settings.customUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      p.chatUrl = base ? base + '/chat/completions' : '';
      p.modelsUrl = base ? base + '/models' : '';
    }
    return p;
  }
  function authHeaders(id) {
    const h = {}; const k = (settings.keys[id] || '').trim();
    if (k) h.Authorization = 'Bearer ' + k;
    return h;
  }
  function explain(status, raw, p) {
    let msg = '';
    try { const j = JSON.parse(raw); msg = (j.error && (j.error.message || j.error)) || j.message || j.detail || ''; if (typeof msg !== 'string') msg = JSON.stringify(msg); } catch (e) { msg = raw.replace(/<[^>]+>/g, ' ').trim().slice(0, 300); }
    let hint = '';
    if (status === 401 || status === 403) hint = p.needsKey ? 'Your ' + p.name + ' key was rejected. Check it in Settings.' : p.name + ' refused the request. It may now require a key; pick another provider in Settings.';
    else if (status === 402) hint = p.name + ' has stopped serving free replies for now. Add a free Groq, Gemini or OpenRouter key in Settings.';
    else if (status === 429) hint = 'Free rate limit reached on ' + p.name + '. Wait a little, or switch model or provider.';
    else if (status === 404 || status === 400) hint = 'The model "' + settings.model + '" may no longer be available. Tap the model name and refresh the list.';
    else if (status >= 500) hint = p.name + ' is having problems right now. Try again or switch provider.';
    return (hint ? hint + '\n' : '') + 'HTTP ' + status + (msg ? ': ' + msg : '');
  }

  /** One request to the model. Returns { full, status, raw, err }. */
  async function requestModel(p, messages, onText, signal, stream, tools) {
    const sse = C.createSseParser(); let full = '', raw = '', err = '';
    const res = await httpStream(p.chatUrl, {
      method: 'POST', signal,
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(settings.provider)),
      body: JSON.stringify(Object.assign({ model: settings.model, messages }, stream ? { stream: true } : {}, tools && tools.length ? { tools: C.toolSchemas(tools), tool_choice: 'auto' } : {})),
    }, (chunk) => {
      if (raw.length < 400000) raw += chunk;
      if (!stream) return;
      for (const ev of sse.feed(chunk)) { if (ev.error) err = ev.error; else if (ev.thinking) { if (!full) setStatus('thinking…'); } else { full += ev.text; onText(full); } }
    });
    if (stream) for (const ev of sse.feed('\n')) if (ev.text) { full += ev.text; onText(full); }
    let native = sse.toolCalls();
    if (!full && !native.length && res.status < 400) {
      try {
        const j = JSON.parse(raw); const m = j.choices && j.choices[0] && j.choices[0].message;
        if (m && typeof m.content === 'string' && m.content) full = m.content;
        if (m && Array.isArray(m.tool_calls)) native = m.tool_calls;
        if (!m && j.error) err = j.error.message || String(j.error);
      } catch (e) { /* not a plain JSON body */ }
    }
    // models that answer with native function calls: turn them into our tool tags
    if (native.length) full = (full ? full.replace(/\s+$/, '') + '\n' : '') + C.nativeCallsToText(native);
    if (full) onText(full);
    return { full, status: res.status, raw, err };
  }

  async function chatStream(messages, onText, signal, tools) {
    const p = providerCfg();
    if (!p.chatUrl) throw new Error('Set the server URL for the Custom provider in Settings.');
    if (p.needsKey && !(settings.keys[settings.provider] || '').trim()) throw new Error('Add your free ' + p.name + ' key in Settings, or switch to Pollinations (no key).');
    // Some free endpoints answer a long prompt with an empty stream. Fall back to a plain
    // (non-streaming) request, then to a request with the system prompt folded into the first message.
    const merged = () => {
      const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'), rest = messages.filter((m) => m.role !== 'system');
      if (!sys || !rest.length) return null;
      return [{ role: 'user', content: '<instructions>\n' + sys + '\n</instructions>\n\n' + rest[0].content }].concat(rest.slice(1));
    };
    // With tools the model gets real function definitions first (what strong free models expect);
    // providers that reject them fall through to the plain-text tool protocol.
    const useTools = tools && tools.length && settings.nativeTools !== false;
    const variants = [() => [messages, true], () => [messages, false], () => { const m = merged(); return m ? [m, true] : null; }];
    if (useTools) variants.unshift(() => [messages, true, tools]);
    let r = null, waits = 0, toolRetries = 0;
    for (let v = 0; v < variants.length; v++) {
      const args = variants[v](); if (!args) continue;
      r = await requestModel(p, args[0], onText, signal, args[1], args[2]);
      // free tiers rate-limit often: wait and retry a couple of times before giving up
      if ((r.status === 429 || r.status === 503 || r.status === 402) && !r.full && waits < 6) {
        // e.g. the keyless tier allows one reply every 45 seconds: wait exactly as long as the provider asks
        const m = /retry after (\d+)\s*s/i.exec(r.raw) || /try again in ([\d.]+)\s*s/i.exec(r.raw);
        const secs = m ? Math.min(90, Math.ceil(parseFloat(m[1])) + 1) : (r.status === 402 ? 0 : (waits ? 12 : 4));
        if (secs) {
          waits++;
          for (let left = secs; left > 0; left--) { setStatus('free limit: next reply in ' + left + 's'); await sleep(1000, signal); }
          v--; continue;
        }
      }
      // tool-related refusals ("Tool choice is none, but model called a tool", tool_use_failed, tools unsupported)
      const errText = r.err || (r.status >= 400 ? r.raw : '');
      if (!r.full && errText && /tool|function/i.test(errText) && r.status !== 401 && r.status !== 403) {
        const rec = C.recoverFailedGeneration(r.raw);
        if (rec) { onText(rec); chatStream.lastVariant = v; return rec; }
        if (useTools && toolRetries < 2) {
          toolRetries++; setStatus('retrying tool call…');
          // the model wants native calls but none were offered -> go back to the native variant; otherwise drop to text
          if (/tool choice is none|called a tool/i.test(errText)) { v = -1; continue; }
          if (args[2]) continue;
        }
      } else if (!r.full && args[2] && (r.status === 400 || r.status === 404 || r.status === 422 || r.status === 500)) continue; // provider does not take tools
      if (r.status >= 400) throw new Error(explain(r.status, r.raw, p));
      if (r.full) { chatStream.lastVariant = v; return r.full; }
      if (r.err) { if (args[2]) continue; break; }
      setStatus('empty reply, retrying…');
    }
    if (r && r.err) throw new Error(p.name + ': ' + r.err);
    chatStream.lastRaw = r ? r.raw.slice(0, 400) : '';
    throw new Error('The model returned an empty reply. Try again or pick another model.' + (r && r.raw.trim() ? '\nRaw: ' + r.raw.trim().slice(0, 160) : ''));
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
    });
  }

  async function fetchModels(id) {
    const p = providerCfg(id);
    if (!p.modelsUrl) throw new Error('No model list URL for this provider.');
    let raw = '';
    const res = await httpStream(p.modelsUrl, { headers: authHeaders(id) }, (c) => { raw += c; });
    if (res.status >= 400) throw new Error(explain(res.status, raw, p));
    const list = C.parseModelList(JSON.parse(raw), p);
    if (!list.length) throw new Error('The provider returned no usable models.');
    settings.models[id] = list; saveSettings();
    return list;
  }
  const modelsFor = (id) => (settings.models[id] && settings.models[id].length ? settings.models[id] : C.PROVIDERS[id].fallbackModels);

  // ------------------------------------------------------------- execution
  let nxSeq = 0; const nxReqs = {};
  window.__nx = (id, res) => { const r = nxReqs[id]; if (r) { delete nxReqs[id]; r(res); } };
  function nativeExec(cmd, timeoutSec) {
    return new Promise((resolve) => { const id = 'x' + (++nxSeq); nxReqs[id] = resolve; Native.exec(id, cmd, timeoutSec | 0); });
  }

  let pyWorker = null, pyLoaded = false;
  function workerRun(kind, msg, timeoutSec, signal) {
    return new Promise((resolve, reject) => {
      let w;
      try {
        if (kind === 'py') { if (!pyWorker) { pyWorker = new Worker('pyworker.mjs', { type: 'module' }); pyLoaded = false; } w = pyWorker; }
        else w = new Worker('jsworker.js');
      } catch (e) { return resolve({ code: 1, out: 'Could not start the ' + (kind === 'py' ? 'Python' : 'JavaScript') + ' runtime: ' + e.message, changed: [], deleted: [] }); }
      const kill = () => { try { w.terminate(); } catch (e) {} if (kind === 'py') { pyWorker = null; pyLoaded = false; } };
      const finish = (fn, v) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); w.onmessage = w.onerror = null; if (kind !== 'py') kill(); fn(v); };
      const onAbort = () => { kill(); finish(reject, abortError()); };
      // the first Python start has to load the interpreter, so it gets extra time
      const limit = (timeoutSec + (kind === 'py' && !pyLoaded ? 60 : 0)) * 1000;
      const timer = setTimeout(() => { kill(); finish(resolve, { code: 124, out: 'Timed out after ' + timeoutSec + ' s and was stopped.', timedOut: true, changed: [], deleted: [] }); }, limit);
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
      w.onmessage = (e) => { if (kind === 'py') pyLoaded = true; finish(resolve, e.data); };
      w.onerror = (e) => { kill(); finish(resolve, { code: 1, out: 'Runtime crashed: ' + (e.message || 'unknown error'), changed: [], deleted: [] }); };
      w.postMessage(msg);
    });
  }

  let execQueue = Promise.resolve();
  /** Run a terminal command: Python and JavaScript in bundled runtimes, everything else in the Android shell. */
  function runCommand(cmd, timeoutSec, signal) {
    const job = execQueue.then(() => runCommandNow(cmd, timeoutSec || 60, signal));
    execQueue = job.catch(() => {});
    return job;
  }
  async function runCommandNow(cmd, timeoutSec, signal) {
    if (signal && signal.aborted) throw abortError();
    const pc = C.parseCommand(cmd);
    if (pc.kind === 'note') return { code: pc.code || 0, out: pc.text, files: [] };
    let r;
    if (pc.kind === 'sh') {
      if (!canShell) return { code: 127, out: 'Shell commands run only in the installed Android app. In this browser preview you can run `python …` and `node …`.', files: [] };
      r = await nativeExec(cmd, timeoutSec);
      const changed = (r.changed || []).filter((c) => !c.tooBig);
      mirror = false;
      try {
        changed.forEach((c) => { const bytes = unb64(c.b64); const t = C.decodeIfText(bytes); ws.set(c.path, t != null ? t : bytes); });
        (r.deleted || []).forEach((p) => ws.remove(p));
      } finally { mirror = true; }
      r.files = (r.changed || []).map((c) => c.path).concat((r.deleted || []).map((p) => p + ' (deleted)'));
      if (/(python3?|pip3?|node|npm|git)(: inaccessible or not found|: not found|: command not found)/.test(r.out || '')) {
        r.out += '\nNote: python and node are separate runtimes here. Run them as the whole command (e.g. `python main.py`), not inside a pipeline, redirect or && chain.';
      }
      return r;
    }
    const files = ws.list().filter((p) => ws.size(p) <= 16 * 1048576).map((p) => ({ path: p, data: ws.bytes(p) }));
    if (pc.kind === 'python' || pc.kind === 'pip') {
      if (!pyLoaded) setStatus('starting Python…');
      r = await workerRun('py', { files, mode: pc.kind === 'pip' ? 'pip' : pc.mode, argv: pc.argv, src: pc.src || '', cwd: pc.cwd }, timeoutSec, signal);
    } else {
      r = await workerRun('js', { files, mode: pc.mode, argv: pc.argv, src: pc.src || '', cwd: pc.cwd }, timeoutSec, signal);
    }
    (r.changed || []).forEach((c) => { const t = C.decodeIfText(c.data); ws.set(c.path, t != null ? t : c.data); });
    (r.deleted || []).forEach((p) => ws.remove(p));
    r.files = (r.changed || []).map((c) => c.path).concat((r.deleted || []).map((p) => p + ' (deleted)'));
    return r;
  }
  function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

  // ------------------------------------------------------------------- web
  const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
  /** Fetch a page as text. Uses the native bridge when present because websites do not allow cross-origin browser requests. */
  async function httpText(url, signal, extraHeaders) {
    let text = '';
    const opt = { signal, headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml,text/plain,*/*' }, extraHeaders || {}) };
    const onChunk = (c) => { if (text.length < 1500000) text += c; };
    let res;
    if (Native) res = await nativeStream(url, opt, onChunk);
    else {
      try { res = await httpStream(url, { signal }, onChunk); }
      catch (e) { if (e.name === 'AbortError') throw e; throw new Error('Web access needs the installed Android app (browsers block cross-site requests).'); }
    }
    return { status: res.status, ctype: res.ctype || '', text };
  }
  function parseHtml(html) { return new DOMParser().parseFromString(html, 'text/html'); }
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function parseSearchResults(html) {
    const doc = parseHtml(html), out = [];
    const realUrl = (href) => {
      if (!href) return '';
      const m = /[?&]uddg=([^&]+)/.exec(href);
      if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return ''; } }
      if (href.startsWith('//')) return 'https:' + href;
      return /^https?:/.test(href) ? href : '';
    };
    doc.querySelectorAll('.result, .web-result').forEach((r) => {
      const a = r.querySelector('a.result__a'); if (!a) return;
      const url = realUrl(a.getAttribute('href')); if (!url || /duckduckgo\.com\/y\.js/.test(url)) return;
      out.push({ title: clean(a.textContent), url, snippet: clean((r.querySelector('.result__snippet') || {}).textContent) });
    });
    if (!out.length) { // lite layout
      doc.querySelectorAll('a.result-link').forEach((a) => {
        const url = realUrl(a.getAttribute('href')); if (!url) return;
        const row = a.closest('tr'), sn = row && row.nextElementSibling && row.nextElementSibling.querySelector('.result-snippet');
        out.push({ title: clean(a.textContent), url, snippet: clean(sn && sn.textContent) });
      });
    }
    return out.slice(0, 8);
  }
  async function webSearch(query, signal) {
    let r = await httpText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), signal);
    let res = parseSearchResults(r.text);
    if (!res.length) { r = await httpText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), signal); res = parseSearchResults(r.text); }
    if (!res.length && (r.status >= 400 || r.status === 202 || /anomaly|captcha|challenge/i.test(r.text))) throw new Error('The search engine blocked this request (HTTP ' + r.status + '). Try again later, or open a known URL with read_url.');
    return res;
  }
  function htmlToText(html, baseUrl) {
    const doc = parseHtml(html);
    doc.querySelectorAll('script,style,noscript,svg,iframe,form,nav,footer,aside,template,button,[hidden],[aria-hidden="true"]').forEach((n) => n.remove());
    const root = doc.querySelector('main, article, [role=main]') || doc.body || doc.documentElement;
    const blocks = [];
    const walk = (n) => {
      n.childNodes.forEach((c) => {
        if (c.nodeType === 3) { const t = c.nodeValue.replace(/\s+/g, ' '); if (t.trim()) blocks.push(t); }
        else if (c.nodeType === 1) {
          const tag = c.tagName.toLowerCase();
          if (tag === 'pre') { blocks.push('\n```\n' + c.textContent.replace(/\s+$/, '') + '\n```\n'); return; }
          const block = /^(p|div|section|h[1-6]|li|tr|br|ul|ol|table|blockquote|dt|dd|header)$/.test(tag);
          if (block) blocks.push('\n');
          if (/^h[1-6]$/.test(tag)) blocks.push('#'.repeat(+tag[1]) + ' ');
          if (tag === 'li') blocks.push('- ');
          walk(c);
          if (tag === 'a' && c.getAttribute('href') && /^https?:/.test(c.getAttribute('href')) && c.textContent.trim().length > 2) blocks.push(' (' + c.getAttribute('href') + ')');
          if (block) blocks.push('\n');
        }
      });
    };
    walk(root);
    const title = clean((doc.querySelector('title') || {}).textContent);
    return (title ? '# ' + title + '\n' + baseUrl + '\n\n' : '') + blocks.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  async function readUrl(url, signal) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const r = await httpText(url, signal);
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' from ' + url);
    if (/json|text\/plain|javascript|xml|csv|markdown/.test(r.ctype) && !/html/.test(r.ctype)) return r.text;
    const text = /<html|<body|<div|<p[\s>]/i.test(r.text) ? htmlToText(r.text, url) : r.text;
    return text || '(the page has no readable text; it may need JavaScript to render)';
  }

  // ------------------------------------------------------------ sub-agents
  let repoBase = load('cyb.repo', null);
  const caps = (extra) => Object.assign({ shell: canShell, repo: repoBase ? repoBase.owner + '/' + repoBase.repo : '' }, extra || {});

  /** Run a helper agent with its own context and return its final report. */
  /** User instructions plus the project's AGENTS.md / CLAUDE.md when enabled. */
  function extraPrompt() {
    let t = settings.extra || '';
    if (settings.agentsMd !== false) {
      const f = ['AGENTS.md', 'CLAUDE.md', 'agents.md'].find((n) => ws.has(n) && !ws.isBinary(n));
      if (f) t += '\n\nProject instructions from ' + f + ':\n' + String(ws.get(f)).slice(0, 6000);
    }
    return t;
  }
  async function spawnAgent(type, prompt, signal) {
    const agent = C.AGENTS[type], msgs = [{ role: 'user', content: prompt }];
    const env = { exec: (c, t) => runCommand(c, t, signal), search: (q) => webSearch(q, signal), readUrl: (u) => readUrl(u, signal) };
    let last = '';
    for (let step = 0; step < 8; step++) {
      const sys = C.buildSystemPrompt(type, ws.summary(), extraPrompt(), caps({ noSpawn: true }));
      setStatus(agent.icon + ' ' + type + (step ? ' step ' + (step + 1) : '') + '…');
      last = await chatStream([{ role: 'system', content: sys }].concat(C.trimHistory(msgs, 40000)), (t) => setStatus(agent.icon + ' ' + type + ' ' + t.length + ' chars'), signal, agent.tools.filter((t) => t !== 'spawn_agent'));
      msgs.push({ role: 'assistant', content: last });
      const calls = C.parseToolCalls(last, agent.tools).filter((c) => C.PASSIVE.indexOf(c.name) < 0);
      if (!calls.length) return C.displayText(last).trim();
      const parts = await C.runTools(calls, ws, env, (l) => setStatus(agent.icon + ' ' + type + ': ' + l));
      msgs.push({ role: 'user', content: C.formatToolResults(parts) });
    }
    return C.displayText(last).trim() + '\n(The helper agent reached its step limit.)';
  }

  // ------------------------------------------------------------- rendering
  marked.setOptions({ gfm: true, breaks: true });
  function renderMd(text) {
    const html = DOMPurify.sanitize(marked.parse(C.displayText(text).replace(/^(\s*)[-*] \[[xX]\] /gm, '$1- ✅ ').replace(/^(\s*)[-*] \[ \] /gm, '$1- ⬜ ')), { FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] });
    const box = el('div', 'md'); box.innerHTML = html;
    box.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    box.querySelectorAll('pre code').forEach((code) => {
      try { hljs.highlightElement(code); } catch (e) {}
      const b = el('button', 'copy', 'copy');
      b.onclick = () => copyText(code.textContent, b);
      code.parentNode.insertBefore(b, code);
    });
    return box;
  }
  function copyText(t, btn) {
    const ok = () => { if (btn) { btn.textContent = 'copied'; setTimeout(() => (btn.textContent = 'copy'), 1200); } else toast('Copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, legacy); else legacy();
    function legacy() { const ta = el('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch (e) {} ta.remove(); }
  }

  function msgNode(m) {
    const n = el('div', 'msg ' + (m.tool ? 'tool' : m.role));
    if (m.tool) {
      const parts = m.parts || [];
      const d = el('details'), s = el('summary');
      const bad = parts.filter((p) => !p.ok).length;
      s.innerHTML = '';
      s.appendChild(el('span', bad ? 'bad' : 'ok', bad ? '✗ ' : '✓ '));
      s.appendChild(document.createTextNode(parts.length ? parts.map((p) => p.label).join(' · ') : 'note to agent'));
      d.appendChild(s); d.appendChild(el('pre', '', parts.length ? parts.map((p) => '[' + p.label + ']\n' + p.text).join('\n\n') : m.content));
      n.appendChild(d);
    } else if (m.role === 'user') n.textContent = m.content;
    else if (m.role === 'error') n.textContent = '⚠ ' + m.content;
    else {
      const a = C.AGENTS[m.agent] || C.AGENTS.coder;
      n.appendChild(el('div', 'who', a.icon + ' ' + a.name.toLowerCase() + (m.model ? ' · ' + m.model : '')));
      n.appendChild(renderMd(m.content));
    }
    return n;
  }

  const SUGGEST = {
    coder: ['Build a pomodoro timer as a single-page web app', 'Write a Python script that finds duplicate files, with unit tests, and run them', 'Review my workspace code, fix the bugs you find and verify the fix'],
    planner: ['Plan a notes app with tags and search', 'Plan how to add dark mode to my project'],
    reviewer: ['Review all files in my workspace for bugs', 'Check my code for security problems'],
    reverse: ['Analyse the APK I imported: permissions, libraries, URLs', 'Explain this decompiled function (paste it below)', 'Find hard-coded keys and endpoints in the imported file'],
    chat: ['Explain async/await with a small example', 'Search the web: what is new in the latest Python release?'],
  };

  function renderMessages() {
    const box = $('messages'); box.innerHTML = '';
    if (!current.messages.length) {
      const a = C.AGENTS[current.agent];
      const w = el('div', 'welcome');
      w.appendChild($('tplLogo').content.cloneNode(true));
      const mp = el('button', 'modepill', a.icon + ' ' + a.name); mp.id = 'modeBtn'; mp.onclick = openModeMenu; w.appendChild(mp);
      w.appendChild(el('div', 'blurb', a.blurb + '. Free models, runs on your phone.'));
      (SUGGEST[current.agent] || []).forEach((t) => { const b = el('button', 'sugg', t); b.onclick = () => { $('input').value = t; autoGrow(); $('input').focus(); }; w.appendChild(b); });
      const p = providerCfg();
      if (p.needsKey && !(settings.keys[settings.provider] || '').trim()) {
        const nt = el('div', 'note', 'No ' + p.name + ' key set. Open Settings to add your free key, or switch to Pollinations.');
        nt.onclick = openSettings; w.appendChild(nt);
      }
      box.appendChild(w);
    } else { current.messages.forEach((m) => box.appendChild(msgNode(m))); renderFollowups(); }
    box.scrollTop = box.scrollHeight;
    $('title').textContent = current.title || 'New chat';
  }
  /** Next-step suggestions from the agent's last reply, as tappable chips. */
  function renderFollowups() {
    const box = $('messages'); const oldChips = box.querySelector('.followups'); if (oldChips) oldChips.remove();
    if (busy || !current) return;
    const last = current.messages[current.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const list = C.followupsOf(last.content); if (!list.length) return;
    const wrap = el('div', 'followups');
    list.forEach((t) => { const b = el('button', 'sugg', '↳ ' + t); b.onclick = () => { $('input').value = t; send(); }; wrap.appendChild(b); });
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.appendChild(wrap); if (stick) box.scrollTop = box.scrollHeight;
  }
  function renderAgents() {
    const nav = $('agents'); nav.innerHTML = '';
    Object.keys(C.AGENTS).filter((id) => !C.AGENTS[id].sub).forEach((id) => {
      const a = C.AGENTS[id], b = el('button', 'pill' + (current.agent === id ? ' on' : ''), a.icon + ' ' + a.name);
      b.appendChild(el('small', '', a.blurb));
      b.onclick = () => { closeDrawer(); if (busy) return; current.agent = id; saveSessions(); renderAgents(); if (!current.messages.length) renderMessages(); };
      nav.appendChild(b);
    });
    $('input').placeholder = placeholder();
    $('btnMode').textContent = C.AGENTS[current.agent].name;
  }
  function openModeMenu() { if (busy) return toast('Wait for the current reply or stop it'); $('agents').hidden = false; $('scrim').hidden = false; }
  const placeholder = () => ({ coder: 'Ask CybNate to build…', planner: 'What should we plan?', reviewer: 'What should I review?', reverse: 'Import a file, then ask…', chat: 'Message CybNate…' })[current.agent];
  function renderModelChip() { $('btnModel').innerHTML = ''; $('btnModel').appendChild(el('span', 'mname', settings.model)); $('btnModel').title = C.PROVIDERS[settings.provider].name + ' / ' + settings.model; }
  function setStatus(t) { $('status').textContent = t || ''; }

  // -------------------------------------------------------------- sessions
  function newSession() {
    const empty = sessions.find((s) => !s.messages.length);
    current = empty || { id: 's' + Date.now(), title: '', agent: current ? current.agent : 'coder', messages: [], updated: Date.now() };
    if (!empty) sessions.unshift(current);
    renderAll();
  }
  function renderAll() { renderAgents(); renderMessages(); renderModelChip(); updateBadge(); }

  // ------------------------------------------------------------ agent loop
  function apiHistory() {
    return C.trimHistory(current.messages.filter((m) => m.role === 'user' || m.role === 'assistant'), 70000);
  }

  async function send() {
    if (busy) { if (abortCtl) abortCtl.abort(); return; }
    const text = $('input').value.trim();
    if (!text) return;
    $('input').value = ''; autoGrow();
    if (!current.messages.length) current.title = text.slice(0, 60);
    current.messages.push({ role: 'user', content: text });
    current.updated = Date.now();
    sessions = [current].concat(sessions.filter((s) => s !== current));
    renderMessages();
    busy = true; abortCtl = new AbortController();
    $('btnSend').classList.add('stop'); sendIcon = sendIcon || $('btnSend').innerHTML; $('btnSend').textContent = '■';
    const box = $('messages');
    try {
      const agent = C.AGENTS[current.agent];
      const maxSteps = agent.tools.length ? Math.max(1, settings.maxSteps | 0) : 1;
      const oldChips = box.querySelector('.followups'); if (oldChips) oldChips.remove();
      let badCalls = 0;
      for (let step = 0; step < maxSteps; step++) {
        const sys = C.buildSystemPrompt(current.agent, ws.summary(), extraPrompt(), caps());
        const msg = { role: 'assistant', content: '', agent: current.agent, model: settings.model };
        const node = msgNode(msg); node.classList.add('cursor'); box.appendChild(node);
        box.scrollTop = box.scrollHeight;
        setStatus(step ? 'step ' + (step + 1) + '…' : 'thinking…');
        let pending = false, latest = '';
        const paint = () => {
          pending = false;
          const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
          node.replaceChild(renderMd(latest), node.lastChild);
          if (stick) box.scrollTop = box.scrollHeight;
        };
        let full;
        try {
          full = await chatStream([{ role: 'system', content: sys }].concat(apiHistory()), (t) => {
            latest = t; setStatus('writing… ' + t.length + ' chars');
            if (!pending) { pending = true; setTimeout(paint, 90); }
          }, abortCtl.signal, agent.tools);
        } catch (e) {
          if (latest) { msg.content = latest; current.messages.push(msg); }
          node.remove(); if (latest) box.appendChild(msgNode(msg));
          throw e;
        }
        msg.content = full; current.messages.push(msg);
        box.replaceChild(msgNode(msg), node);
        saveSessions();

        if (!agent.tools.length) break;
        const calls = C.parseToolCalls(full, agent.tools);
        let toolMsg;
        if (calls.length && !calls.every((c) => C.PASSIVE.indexOf(c.name) >= 0)) {
          const sig = abortCtl.signal;
          const env = { exec: (c, t) => runCommand(c, t, sig), search: (q) => webSearch(q, sig), readUrl: (u) => readUrl(u, sig), spawn: (type, p) => spawnAgent(type, p, sig) };
          const parts = await C.runTools(calls, ws, env, (label) => setStatus(label.slice(0, 60) + '…'));
          toolMsg = { role: 'user', tool: true, parts, content: C.formatToolResults(parts) };
        } else if (new RegExp('<(' + C.BODY_TOOLS.join('|') + ')\\b[^>]*>(?![\\s\\S]*<\\/\\1\\s*>)').test(C.stripThink(full))) {
          toolMsg = { role: 'user', tool: true, parts: [], content: 'Your last reply was cut off before a closing tool tag, so that tool did not run. Send it again; if a file is long, split the work into smaller files or use edit_file.' };
        } else if (/\(The model (tried to call an unknown tool|sent a malformed call)/.test(full) && ++badCalls <= 3) {
          toolMsg = { role: 'user', tool: true, parts: [], content: 'That tool does not exist or the call was malformed, so nothing ran. Use only these tools, written as the XML tags described in your instructions: ' + agent.tools.join(', ') + '.' };
        } else break;
        current.messages.push(toolMsg); box.appendChild(msgNode(toolMsg));
        box.scrollTop = box.scrollHeight; saveSessions(); updateBadge();
        if (step === maxSteps - 1) pushError('Stopped after ' + maxSteps + ' steps. Send "continue" to keep going.');
      }
    } catch (e) {
      if (e.name !== 'AbortError') pushError(e.message || String(e)); else toast('Stopped');
    } finally {
      busy = false; abortCtl = null; setStatus(''); renderFollowups();
      $('btnSend').classList.remove('stop'); $('btnSend').innerHTML = sendIcon;
      current.updated = Date.now(); saveSessions();
    }
  }
  function pushError(t) {
    const m = { role: 'error', content: t }; current.messages.push(m);
    const box = $('messages'); box.appendChild(msgNode(m)); box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------- sheets
  let sheetStack = [];
  function openSheet(title, build, actions) {
    sheetStack.push({ title, build, actions });
    drawSheet();
  }
  function drawSheet() {
    const top = sheetStack[sheetStack.length - 1];
    if (!top) { $('sheet').hidden = true; return; }
    $('sheet').hidden = false; $('sheetTitle').textContent = top.title;
    const act = $('sheetActions'); act.innerHTML = '';
    (top.actions || []).forEach((a) => { const b = el('button', '', a[0]); b.onclick = a[1]; act.appendChild(b); });
    const body = $('sheetBody'); body.innerHTML = ''; body.scrollTop = 0; top.build(body);
  }
  function closeSheet() { sheetStack.pop(); drawSheet(); if (!sheetStack.length) { renderAll(); } }
  function toast(t) { const n = $('toast'); n.textContent = t; n.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (n.hidden = true), 2200); }

  // ----------------------------------------------------------------- files
  function importFiles(fileList, then) {
    const files = Array.from(fileList || []); let left = files.length; const names = [];
    if (!left) return;
    files.forEach((f) => {
      if (f.size > 60 * 1048576) { toast(f.name + ' is larger than 60 MB, skipped'); if (!--left && then) then(names); return; }
      const r = new FileReader();
      r.onload = () => {
        const bytes = new Uint8Array(r.result), text = C.decodeIfText(bytes);
        names.push(ws.set(f.name, text != null ? text : bytes));
        if (!--left && then) then(names);
      };
      r.onerror = () => { if (!--left && then) then(names); };
      r.readAsArrayBuffer(f);
    });
  }
  let pickThen = null;
  function pickFiles(then) { pickThen = then; const p = $('filePick'); p.value = ''; p.click(); }
  $('filePick').onchange = (e) => importFiles(e.target.files, (names) => { toast('Imported ' + names.length + ' file' + (names.length > 1 ? 's' : '')); if (pickThen) pickThen(names); });

  function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function exportBytes(name, bytes, mime) {
    if (Native) { const r = Native.saveFile(name, b64(bytes), mime || ''); toast(/^ERR:/.test(r) ? 'Save failed: ' + r.slice(4) : 'Saved to ' + r); return; }
    const a = el('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function openFiles() {
    openSheet('Workspace', (body) => {
      const btns = el('div', 'btns');
      const add = (t, fn) => { const b = el('button', '', t); b.onclick = fn; btns.appendChild(b); };
      add('⬆ Import', () => pickFiles(drawSheet));
      add('＋ New file', () => { const n = prompt('File name', 'notes.md'); if (n) { ws.set(n, ''); openFile(C.Workspace.norm(n)); } });
      if (ws.list().length) {
        add('⬇ Export ZIP', () => exportBytes('cybnate-workspace.zip', C.zipCreate(ws.list().map((p) => ({ name: p, data: ws.bytes(p) }))), 'application/zip'));
        add('🗑 Clear all', () => { if (confirm('Delete every file in the workspace?')) { ws.list().forEach((p) => ws.remove(p)); drawSheet(); } });
      }
      body.appendChild(btns);
      const list = ws.list();
      if (!list.length) body.appendChild(el('div', 'empty', 'No files yet. Ask the Coder agent to build something, or import files (APK, code, binaries) to analyse.'));
      list.forEach((p) => {
        const row = el('button', 'file'); row.appendChild(el('span', '', ws.isBinary(p) ? '⬢' : '▪'));
        row.appendChild(el('span', 'fn', p)); row.appendChild(el('small', '', C.fmtSize(ws.size(p))));
        row.onclick = () => openFile(p); body.appendChild(row);
      });
    });
  }

  function openFile(p) {
    const isHtml = /\.html?$/i.test(p), bin = ws.isBinary(p);
    const actions = [];
    let ta = null;
    if (!bin) actions.push(['Save', () => { ws.set(p, ta.value); toast('Saved'); }]);
    if (isHtml) actions.push(['▶ Run', () => { if (ta) ws.set(p, ta.value); openPreview(p); }]);
    openSheet(p, (body) => {
      const btns = el('div', 'btns');
      const add = (t, fn) => { const b = el('button', '', t); b.onclick = fn; btns.appendChild(b); };
      add('⬇ Export', () => exportBytes(p.split('/').pop(), ws.bytes(p)));
      if (!bin) add('⧉ Copy', () => copyText(ta.value));
      add('✎ Rename', () => { const n = prompt('New name', p); if (n && n !== p) { ws.set(n, ws.get(p)); ws.remove(p); sheetStack.pop(); openFile(C.Workspace.norm(n)); } });
      add('🗑 Delete', () => { if (confirm('Delete ' + p + '?')) { ws.remove(p); closeSheet(); } });
      body.appendChild(btns);
      if (bin) {
        const pre = el('pre', '', 'Analysing…'); body.appendChild(pre);
        C.fileInfo(ws.bytes(p), p).then((info) => { pre.textContent = info + '\n\n' + C.hexdump(ws.bytes(p), 0, 256); });
        const tip = el('div', 'note', 'Tip: switch to the 🧬 Reverse agent and ask it to analyse ' + p + '.'); body.appendChild(tip);
      } else {
        ta = el('textarea', 'editor'); ta.value = ws.get(p); ta.spellcheck = false; ta.autocapitalize = 'off';
        body.appendChild(ta);
      }
    }, actions);
  }

  /** Inline workspace CSS/JS/images referenced by an HTML file so it can run inside a sandboxed frame. */
  function buildPreview(p) {
    const dir = p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    const res = (ref) => { if (/^(https?:|data:|\/\/|#)/i.test(ref)) return null; const q = C.Workspace.norm(dir + ref.split(/[?#]/)[0]); return ws.has(q) ? q : null; };
    let html = ws.get(p);
    html = html.replace(/<link\b[^>]*?href=["']([^"']+)["'][^>]*>/gi, (all, href) => { const q = /stylesheet/i.test(all) && res(href); return q && !ws.isBinary(q) ? '<style>\n' + ws.get(q).replace(/<\/style/gi, '<\\/style') + '\n</style>' : all; });
    html = html.replace(/<script\b([^>]*?)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (all, a, src, b) => { const q = res(src); return q && !ws.isBinary(q) ? '<script' + a + b + '>\n' + ws.get(q).replace(/<\/script/gi, '<\\/script') + '\n</script>' : all; });
    html = html.replace(/(<img\b[^>]*?src=["'])([^"']+)(["'])/gi, (all, a, src, z) => {
      const q = res(src); if (!q) return all;
      const ext = (q.split('.').pop() || '').toLowerCase(), mime = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
      return a + 'data:' + mime + ';base64,' + b64(ws.bytes(q)) + z;
    });
    return html;
  }
  function openPreview(p) {
    openSheet('▶ ' + p, (body) => {
      const f = el('iframe', 'preview'); f.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms');
      f.srcdoc = buildPreview(p); body.appendChild(f);
    }, [['↻', drawSheet]]);
  }

  // -------------------------------------------------------------- terminal
  let termLog = '';
  function openTerminal() {
    closeDrawer();
    openSheet('Terminal', (body) => {
      const pre = el('pre', 'term'); const row = el('div', 'termrow');
      const prompt = el('span', 'logo', '$'); const inp = el('input'); inp.type = 'text'; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.placeholder = canShell ? 'ls -la · python main.py · node app.js' : 'python main.py · node app.js';
      const go = el('button', '', '⏎');
      const show = () => { pre.textContent = termLog || 'Runs in your workspace folder.\n• python …   CPython 3.14, pip install for pure-Python packages\n• node …     JavaScript runtime\n' + (canShell ? '• anything else runs in the Android shell (ls, cat, grep, sed, find, tar …)\n' : '• shell commands work in the installed Android app\n'); pre.scrollTop = pre.scrollHeight; };
      let running = false, ctl = null;
      const run = async () => {
        if (running) { if (ctl) ctl.abort(); return; }
        const cmd = inp.value.trim(); if (!cmd) return;
        if (cmd === 'clear') { termLog = ''; inp.value = ''; return show(); }
        inp.value = ''; termLog += '$ ' + cmd + '\n'; show(); running = true; go.textContent = '■'; ctl = new AbortController();
        try {
          const r = await runCommand(cmd, 300, ctl.signal);
          termLog += (r.out || '').replace(/\s+$/, '') + (r.out && r.out.trim() ? '\n' : '') + (r.code ? '[exit ' + r.code + ']\n' : '');
        } catch (e) { termLog += (e.name === 'AbortError' ? '^C' : 'error: ' + e.message) + '\n'; }
        if (termLog.length > 60000) termLog = termLog.slice(-60000);
        running = false; go.textContent = '⏎'; setStatus(''); show(); updateBadge();
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') run(); }; go.onclick = run;
      row.appendChild(prompt); row.appendChild(inp); row.appendChild(go);
      body.appendChild(pre); body.appendChild(row); show();
    }, [['Clear', () => { termLog = ''; drawSheet(); }]]);
  }

  // ---------------------------------------------------------------- github
  function openGitHub() {
    closeDrawer();
    let working = false;
    openSheet('GitHub', (body) => {
      const note = (t, cls) => { const n = el('div', cls || 'note', t); body.appendChild(n); return n; };
      const field = (ph, val, type) => { const i = el('input', 'field'); i.type = type || 'text'; i.placeholder = ph; i.value = val || ''; i.autocapitalize = 'off'; i.autocomplete = 'off'; i.spellcheck = false; return i; };
      const card = el('div', 'card'); body.appendChild(card);
      card.appendChild(el('h3', '', 'Access token'));
      card.appendChild(el('p', '', 'Needed for private repositories and for pushing. Create a fine-grained token with "Contents: Read and write" for the repositories you want.'));
      const tok = field('github_pat_…', settings.keys.github, 'password');
      tok.onchange = () => { settings.keys.github = tok.value.trim(); saveSettings(); }; card.appendChild(tok);
      const a = el('a', '', 'Create a token →'); a.href = 'https://github.com/settings/personal-access-tokens/new'; a.target = '_blank'; a.rel = 'noopener'; a.style.cssText = 'display:inline-block;margin-top:8px'; card.appendChild(a);

      const c2 = el('div', 'card'); body.appendChild(c2);
      c2.appendChild(el('h3', '', repoBase ? 'Open another repository' : 'Open a repository'));
      const repo = field('owner/name or GitHub URL', settings.lastRepo || ''); c2.appendChild(repo);
      const br = field('branch (empty = default branch)', ''); c2.appendChild(br);
      const cloneBtn = el('button', 'wide', '⬇ Clone into workspace'); cloneBtn.style.marginTop = '10px'; c2.appendChild(cloneBtn);
      cloneBtn.onclick = async () => {
        if (working) return;
        let pr; try { pr = GitHub.parseRepo(repo.value); } catch (e) { return toast(e.message); }
        if (ws.list().length && !confirm('Cloning replaces the ' + ws.list().length + ' files now in the workspace. Continue?')) return;
        working = true; cloneBtn.textContent = 'Cloning…';
        try {
          settings.keys.github = tok.value.trim(); settings.lastRepo = pr.owner + '/' + pr.repo; saveSettings();
          const res = await GitHub.clone({ token: settings.keys.github, owner: pr.owner, repo: pr.repo, branch: br.value.trim() || pr.branch, onProgress: (d, n) => { cloneBtn.textContent = 'Cloning… ' + d + '/' + n; } });
          ws.list().forEach((p) => ws.remove(p));
          res.files.forEach((v, k) => ws.set(k, v));
          repoBase = res.base; save('cyb.repo', repoBase);
          toast('Cloned ' + res.files.size + ' files' + (res.skipped ? ' (' + res.skipped + ' large or binary files left on GitHub)' : ''));
        } catch (e) { alert(e.message); }
        working = false; drawSheet();
      };

      if (repoBase) {
        const c3 = el('div', 'card on'); body.insertBefore(c3, c2);
        const h = el('h3', '', repoBase.owner + '/' + repoBase.repo + ' '); h.appendChild(el('span', 'tag', repoBase.branch)); c3.appendChild(h);
        c3.appendChild(el('p', '', 'Cloned at commit ' + repoBase.commit.slice(0, 7) + (repoBase.canPush ? '' : ' · this token cannot push here')));
        const st = el('pre', 'changes', 'Checking changes…'); c3.appendChild(st);
        const msg = field('Commit message', ''); c3.appendChild(msg);
        const pushBtn = el('button', 'wide', '⬆ Commit & push'); pushBtn.style.marginTop = '10px'; c3.appendChild(pushBtn);
        const disc = el('button', 'wide ghost', 'Disconnect (keeps the files)'); c3.appendChild(disc);
        disc.onclick = () => { repoBase = null; save('cyb.repo', null); drawSheet(); };
        GitHub.status(repoBase, ws).then((s) => {
          st.textContent = s.count ? s.modified.map((p) => 'M  ' + p).concat(s.added.map((p) => 'A  ' + p), s.deleted.map((p) => 'D  ' + p)).join('\n') : 'No changes to commit.';
          pushBtn.disabled = !s.count; pushBtn.style.opacity = s.count ? 1 : 0.4;
        });
        pushBtn.onclick = async () => {
          if (working || pushBtn.disabled) return;
          if (!msg.value.trim()) return toast('Write a commit message');
          if (!confirm('Push these changes to ' + repoBase.owner + '/' + repoBase.repo + ' (' + repoBase.branch + ')?')) return;
          working = true; pushBtn.textContent = 'Pushing…';
          try {
            const r = await GitHub.push({ token: (settings.keys.github || '').trim(), base: repoBase, ws, message: msg.value.trim() });
            repoBase = r.base; save('cyb.repo', repoBase); toast('Pushed ' + r.changed + ' file change' + (r.changed > 1 ? 's' : '') + ' · ' + r.commit.slice(0, 7));
          } catch (e) { alert(e.message); }
          working = false; drawSheet();
        };
      }
    });
  }

  // -------------------------------------------------------------- settings
  function applyTheme() {
    const t = settings.theme || 'dark';
    const light = t === 'light' || (t === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
  }
  function switchRow(title, sub, get, set) {
    const r = el('div', 'trow'), d = el('div'); d.appendChild(el('b', '', title)); if (sub) d.appendChild(el('small', '', sub));
    const sw = el('button', 'switch' + (get() ? ' on' : '')); sw.setAttribute('role', 'switch');
    sw.onclick = () => { set(!get()); saveSettings(); sw.classList.toggle('on', !!get()); };
    r.appendChild(d); r.appendChild(sw); return r;
  }
  function settingsRow(label, value, fn, plain) { const b = el('button', 'srow' + (plain ? ' plain' : '')); b.appendChild(el('span', '', label)); if (value) b.appendChild(el('small', '', value)); if (fn) b.onclick = fn; return b; }
  function openProviders() {
    openSheet('Model Providers', (body) => {
      body.appendChild(el('div', 'empty', 'Every provider here is free. Pollinations works with no key; the others give a free key in a minute and are much faster.')).style.cssText = 'text-align:left;padding:0 4px 12px';
      Object.keys(C.PROVIDERS).forEach((id) => {
        const p = C.PROVIDERS[id], card = el('div', 'card' + (settings.provider === id ? ' on' : ''));
        const h = el('h3', '', p.name + ' '); h.appendChild(el('span', 'tag', settings.provider === id ? 'active' : p.needsKey ? 'key' : 'no key')); card.appendChild(h);
        card.appendChild(el('p', '', p.tag));
        if (p.custom) {
          const u = el('input', 'field'); u.type = 'text'; u.placeholder = 'http://192.168.1.10:11434/v1'; u.value = settings.customUrl; u.autocapitalize = 'off';
          u.onchange = () => { settings.customUrl = u.value.trim(); saveSettings(); }; card.appendChild(u);
        }
        if (p.needsKey || p.custom) {
          const k = el('input', 'field'); k.type = 'password'; k.placeholder = p.custom ? 'API key (optional)' : 'Paste your free ' + p.name + ' API key'; k.value = settings.keys[id] || ''; k.autocomplete = 'off';
          k.onchange = () => { settings.keys[id] = k.value.trim(); saveSettings(); toast('Key saved on this device'); }; card.appendChild(k);
        }
        if (p.keyUrl) { const a = el('a', '', 'Get a free key →'); a.href = p.keyUrl; a.target = '_blank'; a.rel = 'noopener'; a.style.display = 'inline-block'; a.style.marginTop = '8px'; card.appendChild(a); }
        const use = el('button', 'wide ghost', settings.provider === id ? '✓ In use · choose model' : 'Use ' + p.name);
        use.onclick = () => { openModels(id); }; card.appendChild(use);
        body.appendChild(card);
      });
    });
  }
  function openGeneral() {
    openSheet('General', (body) => {
      const c1 = el('div', 'card'); c1.appendChild(el('div', 'ctitle', 'Agent'));
      c1.appendChild(switchRow('Native tool calls', 'Send tool definitions to the model. Turn off if a model misbehaves.', () => settings.nativeTools !== false, (v) => { settings.nativeTools = v; }));
      c1.appendChild(switchRow('Include AGENTS.md', 'Include the workspace\u2019s AGENTS.md or CLAUDE.md from your next message.', () => settings.agentsMd !== false, (v) => { settings.agentsMd = v; }));
      body.appendChild(c1);
      const c2 = el('div', 'card'); c2.appendChild(el('div', 'ctitle', 'Agent instructions'));
      c2.appendChild(el('p', '', 'Custom instructions added to every agent (optional)'));
      const ex = el('textarea', 'field'); ex.rows = 3; ex.value = settings.extra; ex.placeholder = 'e.g. Always answer in Hinglish. Prefer Python.'; ex.onchange = () => { settings.extra = ex.value; saveSettings(); }; c2.appendChild(ex);
      c2.appendChild(el('p', '', 'Maximum tool steps per message')).style.marginTop = '12px';
      const ms = el('input', 'field'); ms.type = 'text'; ms.inputMode = 'numeric'; ms.value = settings.maxSteps; ms.onchange = () => { settings.maxSteps = Math.min(80, Math.max(1, parseInt(ms.value, 10) || 25)); ms.value = settings.maxSteps; saveSettings(); }; c2.appendChild(ms);
      body.appendChild(c2);
      const c3 = el('div', 'card'); c3.appendChild(el('div', 'ctitle', 'Data'));
      c3.appendChild(el('p', '', 'Chats, files and keys are stored only on this device. Messages are sent directly to the provider you select.'));
      const del = el('button', 'wide danger', 'Delete all chats'); del.onclick = () => { if (confirm('Delete all chats?')) { sessions = []; current = null; newSession(); saveSessions(); toast('Chats deleted'); } }; c3.appendChild(del);
      body.appendChild(c3);
      const c4 = el('div', 'card'); c4.appendChild(settingsRow('Version', Native ? Native.version() : 'web', null, true)); body.appendChild(c4);
    });
  }
  function openAppearance() {
    openSheet('Appearance', (body) => {
      const c = el('div', 'card');
      [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']].forEach((o) => {
        const b = el('button', 'model' + ((settings.theme || 'dark') === o[0] ? ' on' : ''), o[1]);
        b.onclick = () => { settings.theme = o[0]; saveSettings(); applyTheme(); drawSheet(); }; c.appendChild(b);
      });
      body.appendChild(c);
    });
  }
  function openSettings() {
    closeDrawer();
    openSheet('Settings', (body) => {
      const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
      body.appendChild(settingsRow('General', '', openGeneral));
      body.appendChild(settingsRow('Model Providers', C.PROVIDERS[settings.provider].name, openProviders));
      body.appendChild(settingsRow('Model', settings.model.length > 18 ? settings.model.slice(0, 17) + '\u2026' : settings.model, () => openModels()));
      body.appendChild(settingsRow('Appearance', cap(settings.theme || 'dark'), openAppearance));
      body.appendChild(settingsRow('Workspace files', ws.list().length + '', openFiles));
      body.appendChild(settingsRow('Terminal', '', openTerminal));
      body.appendChild(settingsRow('GitHub', '', openGitHub));
    });
  }

  function openModels(id) {
    id = id || settings.provider;
    let loading = false;
    const refresh = () => {
      if (loading) return; loading = true; toast('Loading models…');
      fetchModels(id).then((l) => { loading = false; toast(l.length + ' models'); drawSheet(); }, (e) => { loading = false; toast(e.message.split('\n')[0]); });
    };
    openSheet('Choose model', (body) => {
      const tabs = el('div', 'tabs');
      Object.keys(C.PROVIDERS).forEach((pid) => { const b = el('button', 'pill' + (pid === id ? ' on' : ''), C.PROVIDERS[pid].name); b.onclick = () => { sheetStack.pop(); openModels(pid); }; tabs.appendChild(b); });
      body.appendChild(tabs);
      const p = providerCfg(id);
      if (p.needsKey && !(settings.keys[id] || '').trim()) {
        const n = el('div', 'note', p.name + ' needs a free API key. Tap here to add it in Settings.'); n.style.marginBottom = '10px';
        n.onclick = () => { sheetStack = []; openSettings(); }; body.appendChild(n);
      }
      if (p.custom && !p.chatUrl) { const n = el('div', 'note', 'Set the server URL in Settings first.'); n.onclick = () => { sheetStack = []; openSettings(); }; body.appendChild(n); }
      const add = el('input', 'field'); add.type = 'text'; add.placeholder = 'Search models, or type an id and press Enter'; add.autocapitalize = 'off'; add.style.marginBottom = '8px';
      add.onkeydown = (e) => { if (e.key === 'Enter' && add.value.trim()) pick(add.value.trim()); }; body.appendChild(add);
      add.oninput = () => { const q = add.value.trim().toLowerCase(); body.querySelectorAll('.model').forEach((n) => { n.hidden = !!q && n.textContent.toLowerCase().indexOf(q) < 0; }); };
      const pick = (m) => {
        settings.provider = id; settings.model = m;
        const cur = modelsFor(id); if (cur.indexOf(m) < 0) settings.models[id] = [m].concat(cur);
        saveSettings(); sheetStack.pop(); if (sheetStack.length && sheetStack[sheetStack.length - 1].title === 'Model Providers') sheetStack.pop(); drawSheet(); renderAll(); toast('Using ' + m);
      };
      const list = modelsFor(id);
      if (!list.length) body.appendChild(el('div', 'empty', 'No models listed yet. Tap ↻ Refresh.'));
      list.forEach((m) => { const b = el('button', 'model' + (settings.provider === id && settings.model === m ? ' on' : ''), m); b.onclick = () => pick(m); body.appendChild(b); });
      if (!settings.models[id] && p.modelsUrl && (!p.needsKey || (settings.keys[id] || '').trim())) refresh();
    }, [['↻ Refresh', refresh]]);
  }

  // ---------------------------------------------------------------- drawer
  function openDrawer() {
    const list = $('chatList'); list.innerHTML = '';
    const q = ($('dFilter').hidden ? '' : $('dFilter').value).trim().toLowerCase();
    sessions.filter((s) => s.messages.length && (!q || (s.title || '').toLowerCase().indexOf(q) >= 0)).forEach((s) => {
      const row = el('div', 'chat-item' + (s === current ? ' on' : ''));
      const name = el('button', 'name', (C.AGENTS[s.agent] || C.AGENTS.coder).icon + ' ' + (s.title || 'Untitled'));
      name.onclick = () => { if (busy) return toast('Wait for the current reply or stop it'); current = s; closeDrawer(); renderAll(); };
      const del = el('button', 'del', '✕');
      del.onclick = () => { if (busy && s === current) return; sessions = sessions.filter((x) => x !== s); saveSessions(); if (s === current) { current = null; newSession(); } openDrawer(); };
      row.appendChild(name); row.appendChild(del); list.appendChild(row);
    });
    if (!list.children.length) list.appendChild(el('div', 'empty', q ? 'No matching chats' : 'No chats yet'));
    $('drawer').hidden = false; $('scrim').hidden = false;
  }
  function closeDrawer() { $('drawer').hidden = true; $('scrim').hidden = true; $('agents').hidden = true; }

  // ----------------------------------------------------------------- wiring
  function autoGrow() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(150, t.scrollHeight) + 'px'; }
  $('input').addEventListener('input', autoGrow);
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); send(); } });
  $('btnSend').onclick = send;
  $('btnMenu').onclick = openDrawer; $('scrim').onclick = closeDrawer;
  $('btnNew').onclick = () => { if (busy) return toast('Stop the current reply first'); newSession(); };
  $('dNew').onclick = () => { if (busy) return; closeDrawer(); newSession(); };
  $('btnFiles').onclick = openFiles; $('dFiles').onclick = () => { closeDrawer(); openFiles(); };
  $('dSettings').onclick = openSettings;
  $('btnTerm').onclick = openTerminal; $('dTerm').onclick = openTerminal; $('dGit').onclick = openGitHub;
  $('btnModel').onclick = () => openModels();
  $('btnMode').onclick = openModeMenu;
  $('dSearch').onclick = () => { const f = $('dFilter'); f.hidden = !f.hidden; if (f.hidden) { f.value = ''; openDrawer(); } else f.focus(); };
  $('dFilter').oninput = openDrawer;
  $('dProject').onclick = () => {
    if (busy) return toast('Stop the current reply first');
    closeDrawer();
    if (ws.list().length && !confirm('Start a new project? This removes the ' + ws.list().length + ' files in the current workspace. Export or push them first if you need them.')) return;
    ws.list().forEach((p) => ws.remove(p)); repoBase = null; save('cyb.repo', null);
    newSession(); openGitHub(); toast('Empty workspace. Clone a repo here, or just ask the agent to build.');
  };
  applyTheme();
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme); } catch (e) { /* old WebView */ } }
  $('sheetBack').onclick = closeSheet;
  $('btnAttach').onclick = () => pickFiles((names) => {
    updateBadge(); const t = $('input');
    if (names.length && !t.value.trim()) { t.value = (current.agent === 'reverse' ? 'Analyse ' : 'Look at ') + names.join(', ') + ' '; autoGrow(); }
    if (names.some((n) => ws.isBinary(n)) && current.agent !== 'reverse' && !busy) { current.agent = 'reverse'; renderAgents(); toast('Switched to the Reverse agent for binary files'); }
  });
  window.onNativeBack = () => {
    if (sheetStack.length) { closeSheet(); return true; }
    if (!$('drawer').hidden || !$('agents').hidden) { closeDrawer(); return true; }
    return false;
  };

  if (!C.PROVIDERS[settings.provider]) { settings.provider = 'pollinations'; settings.model = 'openai-fast'; }
  $('ver').textContent = Native ? 'v' + Native.version() : 'web';
  window.__cyb = { C, ws, settings, runCommand, chatStream, fetchModels, webSearch, readUrl, parseSearchResults, htmlToText, spawnAgent, saveSettings };
  window.addEventListener('error', (e) => { console.log('CYBERR ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno); });
  window.addEventListener('unhandledrejection', (e) => { console.log('CYBERR promise ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)); });

  // Draw the UI first; stored files load in the background so a slow database can never leave a blank screen.
  current = sessions[0] || null;
  if (!current) newSession(); else renderAll();
  console.log('CYBUI ready agents=' + $('agents').children.length + ' model=' + settings.model);
  // Some WebViews lay the page out at 0x0 before the window is attached and then skip the first paint: repaint on resize.
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    console.log('CYBUI resize ' + window.innerWidth + 'x' + window.innerHeight);
    if (!lastW && window.innerWidth) { const b = document.body; b.style.display = 'none'; void b.offsetHeight; b.style.display = ''; }
    lastW = window.innerWidth;
  });
  [1500, 6000, 12000, 25000].forEach((ms) => setTimeout(() => { const w = document.querySelector('.welcome'), h = document.querySelector('header'); console.log('CYBUI layout t=' + ms + ' header=' + (h ? h.offsetHeight : -1) + ' welcome=' + (w ? w.offsetHeight : -1) + ' win=' + window.innerWidth + 'x' + window.innerHeight + ' vis=' + document.visibilityState); }, ms));
  openDb().then(() => {
    syncDisk(); updateBadge();
    if (/[?&]selftest=1/.test(location.search)) { const sc = document.createElement('script'); sc.src = 'selftest.js'; document.body.appendChild(sc); }
  });

  // Keyless model names change over time: make sure the selected one still exists.
  function ensureModel() {
    if (settings.provider !== 'pollinations' || busy) return;
    fetchModels('pollinations').then((list) => {
      if (list.indexOf(settings.model) < 0) { settings.model = list.indexOf('openai-fast') >= 0 ? 'openai-fast' : list[0]; saveSettings(); renderModelChip(); }
    }, () => {});
  }
  if (!settings.modelsCheckedAt || Date.now() - settings.modelsCheckedAt > 6 * 3600 * 1000) { settings.modelsCheckedAt = Date.now(); ensureModel(); }
})();
