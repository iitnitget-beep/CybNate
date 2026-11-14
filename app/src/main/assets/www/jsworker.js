// Runs a JavaScript file "node style" in a worker: CommonJS require() between workspace files,
// console capture, and small fs/path shims backed by a copy of the workspace.
'use strict';
self.onmessage = async (e) => {
  const m = e.data;
  const td = new TextDecoder(), te = new TextEncoder();
  const files = {}; const original = {};
  m.files.forEach((f) => { files[f.path] = f.data; original[f.path] = f.data; });
  let out = ''; let exitCode = 0; let exited = false;
  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || String(v);
    try { const s = JSON.stringify(v, null, 2); return s === undefined ? String(v) : s; } catch (err) { return String(v); }
  };
  const write = (...a) => { if (out.length < 200000) out += a.map(fmt).join(' ') + '\n'; };
  const con = { log: write, info: write, warn: write, error: write, debug: write, table: write, assert: (c, ...a) => { if (!c) write('Assertion failed:', ...a); } };

  const norm = (p) => { const parts = []; p.split('/').forEach((s) => { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); }); return parts.join('/'); };
  const dirOf = (p) => (p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '');
  const cwd = norm(m.cwd || '');
  const abs = (p) => norm(p.startsWith('/') ? p.replace(/^\/+(work\/)?/, '') : (cwd ? cwd + '/' : '') + p);
  const isDir = (p) => p === '' || Object.keys(files).some((k) => k.startsWith(p + '/'));
  const enoent = (p) => Object.assign(new Error("ENOENT: no such file or directory, open '" + p + "'"), { code: 'ENOENT' });

  const pathMod = {
    sep: '/', join: (...a) => norm(a.join('/')) || '.', resolve: (...a) => '/' + abs(a.join('/')), dirname: (p) => dirOf(p) || '.',
    basename: (p, ext) => { let b = p.split('/').pop(); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
    extname: (p) => { const b = p.split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }, normalize: (p) => norm(p) || '.',
  };
  const fsMod = {
    existsSync: (p) => abs(p) in files || isDir(abs(p)),
    readFileSync: (p, enc) => { const q = abs(p); if (!(q in files)) throw enoent(p); const d = files[q]; return enc ? td.decode(d) : d; },
    writeFileSync: (p, d) => { files[abs(p)] = typeof d === 'string' ? te.encode(d) : new Uint8Array(d); },
    appendFileSync: (p, d) => { const q = abs(p); const old = files[q] || new Uint8Array(0), add = typeof d === 'string' ? te.encode(d) : new Uint8Array(d); const n = new Uint8Array(old.length + add.length); n.set(old); n.set(add, old.length); files[q] = n; },
    unlinkSync: (p) => { const q = abs(p); if (!(q in files)) throw enoent(p); delete files[q]; },
    mkdirSync: () => {},
    readdirSync: (p) => { const q = abs(p), pre = q ? q + '/' : ''; if (!isDir(q)) throw enoent(p); return Array.from(new Set(Object.keys(files).filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split('/')[0]))).sort(); },
    statSync: (p) => { const q = abs(p); if (q in files) return { size: files[q].length, isFile: () => true, isDirectory: () => false }; if (isDir(q)) return { size: 0, isFile: () => false, isDirectory: () => true }; throw enoent(p); },
  };
  fsMod.promises = { readFile: async (p, enc) => fsMod.readFileSync(p, enc), writeFile: async (p, d) => fsMod.writeFileSync(p, d) };
  const assertMod = Object.assign((c, msg) => { if (!c) throw new Error(msg || 'Assertion failed'); }, {
    ok: (c, msg) => { if (!c) throw new Error(msg || 'Assertion failed'); },
    equal: (a, b, msg) => { if (a != b) throw new Error(msg || fmt(a) + ' == ' + fmt(b)); },
    strictEqual: (a, b, msg) => { if (a !== b) throw new Error(msg || 'Expected ' + fmt(b) + ' but got ' + fmt(a)); },
    deepStrictEqual: (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || 'Expected ' + fmt(b) + ' but got ' + fmt(a)); },
    throws: (fn) => { let t = false; try { fn(); } catch (err) { t = true; } if (!t) throw new Error('Missing expected exception'); },
  });
  assertMod.deepEqual = assertMod.deepStrictEqual;
  const builtins = { fs: fsMod, path: pathMod, assert: assertMod, util: { inspect: fmt, format: (...a) => a.map(fmt).join(' ') }, os: { EOL: '\n', platform: () => 'android' } };

  class Exit extends Error {}
  const proc = { argv: ['node'].concat(m.argv), env: {}, platform: 'android', cwd: () => '/' + cwd, exit: (c) => { exitCode = c | 0; exited = true; throw new Exit(); }, stdout: { write: (s) => { if (out.length < 200000) out += s; } }, stderr: { write: (s) => { if (out.length < 200000) out += s; } } };

  // keep the worker alive until timers have fired
  let pending = 0; const realSet = self.setTimeout.bind(self), realClear = self.clearTimeout.bind(self);
  const timers = new Set();
  const setT = (fn, ms, ...a) => { pending++; const id = realSet(() => { timers.delete(id); try { fn(...a); } catch (err) { if (!(err instanceof Exit)) { write('Uncaught', err); exitCode = 1; } } finally { pending--; } }, ms); timers.add(id); return id; };
  const clearT = (id) => { if (timers.has(id)) { timers.delete(id); pending--; realClear(id); } };

  const cache = {};
  const resolveFile = (from, req) => {
    const base = norm((req.startsWith('/') ? '' : dirOf(from) + '/') + req);
    for (const c of [base, base + '.js', base + '.json', base + '/index.js']) if (c in files) return c;
    return null;
  };
  const load = (file) => {
    if (cache[file]) return cache[file].exports;
    const mod = (cache[file] = { exports: {} });
    const src = td.decode(files[file]);
    if (/\.json$/.test(file)) { mod.exports = JSON.parse(src); return mod.exports; }
    const req = (name) => {
      name = name.replace(/^node:/, '');
      if (builtins[name]) return builtins[name];
      if (/^[./]/.test(name)) { const f = resolveFile(file, name); if (!f) throw new Error("Cannot find module '" + name + "' (required from " + file + ')'); return load(f); }
      throw new Error("Cannot find module '" + name + "'. npm packages are not available in this runtime; only fs, path, assert, util, os and files in the workspace.");
    };
    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', 'console', 'process', 'setTimeout', 'clearTimeout', src + '\n//# sourceURL=' + file);
    fn(mod.exports, req, mod, '/' + file, '/' + dirOf(file), con, proc, setT, clearT);
    return mod.exports;
  };

  self.addEventListener('unhandledrejection', (ev) => { ev.preventDefault(); if (!(ev.reason instanceof Exit)) { write('Uncaught (in promise)', ev.reason); exitCode = 1; } });
  try {
    if (m.mode === 'check') {
      const f = abs(m.argv[0]); if (!(f in files)) throw new Error("Cannot find module '" + m.argv[0] + "'");
      new Function(td.decode(files[f])); write('Syntax OK: ' + m.argv[0]);
    } else if (m.mode === 'code') { files['__eval__.js'] = te.encode(m.src); load('__eval__.js'); delete files['__eval__.js']; }
    else {
      const entry = resolveFile((cwd ? cwd + '/' : '') + 'x', './' + m.argv[0]) || resolveFile('x', m.argv[0]);
      if (!entry) throw new Error("Cannot find module '" + m.argv[0] + "'");
      load(entry);
    }
  } catch (err) { if (!(err instanceof Exit)) { write(err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : String(err)); exitCode = 1; } }

  // let promises and timers settle
  for (let i = 0; i < 3000 && !exited; i++) { await new Promise((r) => realSet(r, 10)); if (pending <= 0 && i > 2) break; }

  const changed = [], deleted = [];
  for (const p in files) { const a = files[p], b = original[p]; if (!b || a !== b) changed.push({ path: p, data: a }); }
  for (const p in original) if (!(p in files)) deleted.push(p);
  self.postMessage({ id: m.id, code: exitCode, out, changed, deleted });
};
