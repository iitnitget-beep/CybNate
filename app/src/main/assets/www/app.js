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
    provider: 'pollinations', model: 'openai', keys: {}, customUrl: '', models: {}, extra: '', maxSteps: 12,
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
  const ws = new C.Workspace((path, value) => {
    if (!db) return;
    try {
      const st = db.transaction('files', 'readwrite').objectStore('files');
      if (value === null) st.delete(path); else st.put(value, path);
    } catch (e) { /* persistence is best effort */ }
    updateBadge();
  });
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
  function updateBadge() { const n = ws.list().length; $('fileBadge').hidden = !n; $('fileBadge').textContent = n; }

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
    else if (status === 429) hint = 'Free rate limit reached on ' + p.name + '. Wait a little, or switch model or provider.';
    else if (status === 404 || status === 400) hint = 'The model "' + settings.model + '" may no longer be available. Tap the model name and refresh the list.';
    else if (status >= 500) hint = p.name + ' is having problems right now. Try again or switch provider.';
    return (hint ? hint + '\n' : '') + 'HTTP ' + status + (msg ? ': ' + msg : '');
  }

  async function chatStream(messages, onText, signal) {
    const p = providerCfg();
    if (!p.chatUrl) throw new Error('Set the server URL for the Custom provider in Settings.');
    if (p.needsKey && !(settings.keys[settings.provider] || '').trim()) throw new Error('Add your free ' + p.name + ' key in Settings, or switch to Pollinations (no key).');
    const sse = C.createSseParser(); let full = '', raw = '', streamErr = '';
    const res = await httpStream(p.chatUrl, {
      method: 'POST', signal,
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(settings.provider)),
      body: JSON.stringify({ model: settings.model, messages, stream: true }),
    }, (chunk) => {
      if (raw.length < 200000) raw += chunk;
      for (const ev of sse.feed(chunk)) { if (ev.error) streamErr = ev.error; else { full += ev.text; onText(full); } }
    });
    if (res.status >= 400) throw new Error(explain(res.status, raw, p));
    for (const ev of sse.feed('\n')) if (ev.text) { full += ev.text; onText(full); }
    if (!full) {
      try { const j = JSON.parse(raw); const m = j.choices && j.choices[0] && j.choices[0].message; if (m && m.content) { full = m.content; onText(full); } else if (j.error) streamErr = j.error.message || String(j.error); } catch (e) {}
    }
    if (!full && streamErr) throw new Error(p.name + ': ' + streamErr);
    if (!full) throw new Error('The model returned an empty reply. Try again or pick another model.');
    return full;
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

  // ------------------------------------------------------------- rendering
  marked.setOptions({ gfm: true, breaks: true });
  function renderMd(text) {
    const html = DOMPurify.sanitize(marked.parse(C.displayText(text)), { FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] });
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
    coder: ['Build a pomodoro timer as a single-page web app', 'Create a Python script that renames files by date', 'Make a landing page for a coffee shop'],
    planner: ['Plan a notes app with tags and search', 'Plan how to add dark mode to my project'],
    reviewer: ['Review all files in my workspace for bugs', 'Check my code for security problems'],
    reverse: ['Analyse the APK I imported: permissions, libraries, URLs', 'Explain this decompiled function (paste it below)', 'Find hard-coded keys and endpoints in the imported file'],
    chat: ['Explain async/await with a small example', 'What is the difference between ELF and PE files?'],
  };

  function renderMessages() {
    const box = $('messages'); box.innerHTML = '';
    if (!current.messages.length) {
      const a = C.AGENTS[current.agent];
      const w = el('div', 'welcome');
      w.appendChild(el('div', 'big', '❯_'));
      w.appendChild(el('h1', '', 'CybNate'));
      w.appendChild(el('div', '', 'Free AI coding agent in your pocket. ' + a.icon + ' ' + a.name + ': ' + a.blurb.toLowerCase() + '.'));
      (SUGGEST[current.agent] || []).forEach((t) => { const b = el('button', 'sugg', t); b.onclick = () => { $('input').value = t; autoGrow(); $('input').focus(); }; w.appendChild(b); });
      const p = providerCfg();
      if (p.needsKey && !(settings.keys[settings.provider] || '').trim()) {
        const nt = el('div', 'note', 'No ' + p.name + ' key set. Open Settings to add your free key, or switch to Pollinations.');
        nt.onclick = openSettings; w.appendChild(nt);
      }
      box.appendChild(w);
    } else current.messages.forEach((m) => box.appendChild(msgNode(m)));
    box.scrollTop = box.scrollHeight;
    $('title').textContent = current.title || 'New chat';
  }
  function renderAgents() {
    const nav = $('agents'); nav.innerHTML = '';
    Object.keys(C.AGENTS).forEach((id) => {
      const a = C.AGENTS[id], b = el('button', 'pill' + (current.agent === id ? ' on' : ''), a.icon + ' ' + a.name);
      b.onclick = () => { if (busy) return; current.agent = id; saveSessions(); renderAgents(); if (!current.messages.length) renderMessages(); $('input').placeholder = placeholder(); };
      nav.appendChild(b);
    });
    $('input').placeholder = placeholder();
  }
  const placeholder = () => ({ coder: 'Ask CybNate to build something…', planner: 'What should we plan?', reviewer: 'What should I review?', reverse: 'Import a file with ＋ and ask about it…', chat: 'Message CybNate…' })[current.agent];
  function renderModelChip() { $('btnModel').textContent = C.PROVIDERS[settings.provider].name.toLowerCase() + ' / ' + settings.model + ' ▾'; }
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
    return C.trimHistory(current.messages.filter((m) => m.role === 'user' || m.role === 'assistant'), 48000);
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
    $('btnSend').classList.add('stop'); $('btnSend').textContent = '■';
    const box = $('messages');
    try {
      const agent = C.AGENTS[current.agent];
      const maxSteps = agent.tools.length ? Math.max(1, settings.maxSteps | 0) : 1;
      for (let step = 0; step < maxSteps; step++) {
        const sys = C.buildSystemPrompt(current.agent, ws.summary(), settings.extra);
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
          }, abortCtl.signal);
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
        if (calls.length) {
          setStatus('running ' + calls.length + ' tool' + (calls.length > 1 ? 's' : '') + '…');
          const parts = await C.runTools(calls, ws);
          toolMsg = { role: 'user', tool: true, parts, content: C.formatToolResults(parts) };
        } else if (/<(write_file|edit_file)\b[^>]*>(?![\s\S]*<\/\1\s*>)/.test(full)) {
          toolMsg = { role: 'user', tool: true, parts: [], content: 'Your last reply was cut off before the closing tag, so nothing was saved. Write that file again; if it is long, split the work into smaller files or use edit_file.' };
        } else break;
        current.messages.push(toolMsg); box.appendChild(msgNode(toolMsg));
        box.scrollTop = box.scrollHeight; saveSessions(); updateBadge();
        if (step === maxSteps - 1) pushError('Stopped after ' + maxSteps + ' steps. Send "continue" to keep going.');
      }
    } catch (e) {
      if (e.name !== 'AbortError') pushError(e.message || String(e)); else toast('Stopped');
    } finally {
      busy = false; abortCtl = null; setStatus('');
      $('btnSend').classList.remove('stop'); $('btnSend').textContent = '➤';
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

  // -------------------------------------------------------------- settings
  function openSettings() {
    closeDrawer();
    openSheet('Settings', (body) => {
      body.appendChild(el('div', 'label', 'AI providers (all free)'));
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
      body.appendChild(el('div', 'label', 'Agent'));
      const c2 = el('div', 'card');
      c2.appendChild(el('p', '', 'Custom instructions added to every agent (optional)'));
      const ex = el('textarea', 'field'); ex.rows = 3; ex.value = settings.extra; ex.placeholder = 'e.g. Always answer in Hinglish. Prefer Python.'; ex.onchange = () => { settings.extra = ex.value; saveSettings(); }; c2.appendChild(ex);
      c2.appendChild(el('p', '', 'Maximum tool steps per message'));
      const ms = el('input', 'field'); ms.type = 'text'; ms.inputMode = 'numeric'; ms.value = settings.maxSteps; ms.onchange = () => { settings.maxSteps = Math.min(40, Math.max(1, parseInt(ms.value, 10) || 12)); ms.value = settings.maxSteps; saveSettings(); }; c2.appendChild(ms);
      body.appendChild(c2);
      body.appendChild(el('div', 'label', 'Data'));
      const c3 = el('div', 'card');
      c3.appendChild(el('p', '', 'Chats, files and keys are stored only on this device. Messages are sent directly to the provider you select.'));
      const del = el('button', 'wide danger', 'Delete all chats'); del.onclick = () => { if (confirm('Delete all chats?')) { sessions = []; current = null; newSession(); saveSessions(); toast('Chats deleted'); } }; c3.appendChild(del);
      body.appendChild(c3);
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
      const add = el('input', 'field'); add.type = 'text'; add.placeholder = 'Or type a model id and press Enter'; add.autocapitalize = 'off'; add.style.marginBottom = '8px';
      add.onkeydown = (e) => { if (e.key === 'Enter' && add.value.trim()) pick(add.value.trim()); }; body.appendChild(add);
      const pick = (m) => {
        settings.provider = id; settings.model = m;
        const cur = modelsFor(id); if (cur.indexOf(m) < 0) settings.models[id] = [m].concat(cur);
        saveSettings(); sheetStack = []; drawSheet(); renderAll(); toast('Using ' + m);
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
    sessions.filter((s) => s.messages.length).forEach((s) => {
      const row = el('div', 'chat-item' + (s === current ? ' on' : ''));
      const name = el('button', 'name', (C.AGENTS[s.agent] || C.AGENTS.coder).icon + ' ' + (s.title || 'Untitled'));
      name.onclick = () => { if (busy) return toast('Wait for the current reply or stop it'); current = s; closeDrawer(); renderAll(); };
      const del = el('button', 'del', '✕');
      del.onclick = () => { if (busy && s === current) return; sessions = sessions.filter((x) => x !== s); saveSessions(); if (s === current) { current = null; newSession(); } openDrawer(); };
      row.appendChild(name); row.appendChild(del); list.appendChild(row);
    });
    if (!list.children.length) list.appendChild(el('div', 'empty', 'No chats yet'));
    $('drawer').hidden = false; $('scrim').hidden = false;
  }
  function closeDrawer() { $('drawer').hidden = true; $('scrim').hidden = true; }

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
  $('btnModel').onclick = () => openModels();
  $('sheetBack').onclick = closeSheet;
  $('btnAttach').onclick = () => pickFiles((names) => {
    updateBadge(); const t = $('input');
    if (names.length && !t.value.trim()) { t.value = (current.agent === 'reverse' ? 'Analyse ' : 'Look at ') + names.join(', ') + ' '; autoGrow(); }
    if (names.some((n) => ws.isBinary(n)) && current.agent !== 'reverse' && !busy) { current.agent = 'reverse'; renderAgents(); toast('Switched to the Reverse agent for binary files'); }
  });
  window.onNativeBack = () => {
    if (sheetStack.length) { closeSheet(); return true; }
    if (!$('drawer').hidden) { closeDrawer(); return true; }
    return false;
  };

  if (!C.PROVIDERS[settings.provider]) { settings.provider = 'pollinations'; settings.model = 'openai'; }
  $('ver').textContent = Native ? 'v' + Native.version() : 'web';
  openDb().then(() => {
    current = sessions[0] || null;
    if (!current) newSession(); else renderAll();
  });
})();
