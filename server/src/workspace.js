'use strict';
/*
 * One directory tree per user: <data>/users/<id>/ws is the project, <id>/home is $HOME for commands.
 * When the server runs as root every user gets an own Unix uid and a 0700 tree, so one user's commands
 * cannot read another user's files or the server database. Without root there is no such wall (see isolation()).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.mypy_cache', '.pytest_cache']);
const MAX_INLINE = 1024 * 1024, MAX_INLINE_TOTAL = 4 * 1024 * 1024, MAX_FILES = 20000;

function create(dataDir, opts) {
  opts = opts || {};
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const uidBase = opts.uidBase || 100000;
  const usersDir = path.join(dataDir, 'users');
  fs.mkdirSync(usersDir, { recursive: true, mode: 0o711 });

  const ids = (user) => (isRoot ? { uid: uidBase + user.n, gid: uidBase + user.n } : {});
  const dirs = (user) => { const base = path.join(usersDir, user.id); return { base, ws: path.join(base, 'ws'), home: path.join(base, 'home') }; };
  function ensure(user) {
    const d = dirs(user);
    if (!fs.existsSync(d.ws)) {
      fs.mkdirSync(d.ws, { recursive: true }); fs.mkdirSync(d.home, { recursive: true });
      fs.chmodSync(d.base, 0o700);
      if (isRoot) { const o = ids(user); [d.base, d.ws, d.home].forEach((p) => fs.chownSync(p, o.uid, o.gid)); }
    }
    return d;
  }
  /** Absolute path of a workspace-relative path, or an error when it would leave the workspace (.., absolute paths, symlinks). */
  function resolve(user, rel) {
    const root = ensure(user).ws;
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!clean || clean.includes('\0') || path.isAbsolute(clean) || clean.split('/').some((s) => s === '..')) throw Object.assign(new Error('Path is outside the workspace: ' + rel), { status: 400 });
    const abs = path.join(root, clean);
    // a symlink inside the workspace must not lead a server-side read or write out of it
    let probe = abs;
    for (;;) { try { const real = fs.realpathSync(probe); if (real !== root && !real.startsWith(root + path.sep)) throw Object.assign(new Error('Path is outside the workspace: ' + rel), { status: 400 }); break; } catch (e) { if (e.status) throw e; const up = path.dirname(probe); if (up === probe) break; probe = up; } }
    return abs;
  }
  /** Map of relative path -> "size:mtime" for every regular file, skipping dependency and cache folders. */
  async function scan(user) {
    const root = ensure(user).ws, out = new Map();
    const walk = async (dir, rel) => {
      let list; try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of list) {
        if (out.size >= MAX_FILES) return;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), r); }
        else if (e.isFile()) { try { const s = await fsp.stat(path.join(dir, e.name)); out.set(r, s.size + ':' + s.mtimeMs + ':' + s.ctimeMs); } catch (er) { /* gone meanwhile */ } }
      }
    };
    await walk(root, '');
    return out;
  }
  async function list(user) {
    const root = ensure(user).ws, files = [];
    for (const rel of (await scan(user)).keys()) {
      const buf = await fsp.readFile(path.join(root, rel)).catch(() => null); if (!buf) continue;
      files.push({ path: rel, size: buf.length, sha1: crypto.createHash('sha1').update(buf).digest('hex') });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : 1));
  }
  async function write(user, rel, buf) {
    const abs = resolve(user, rel), o = ids(user), root = ensure(user).ws;
    // create missing folders one by one so each new one belongs to the user, not to root
    const parts = path.relative(root, path.dirname(abs)).split(path.sep).filter(Boolean); let cur = root;
    for (const p of parts) { cur = path.join(cur, p); if (!fs.existsSync(cur)) { await fsp.mkdir(cur); if (isRoot) await fsp.chown(cur, o.uid, o.gid); } }
    const tmp = abs + '.cyb-' + crypto.randomBytes(4).toString('hex');
    await fsp.writeFile(tmp, buf); if (isRoot) await fsp.chown(tmp, o.uid, o.gid);
    await fsp.rename(tmp, abs); // a crash leaves the old file or the new one, never half of it
  }
  async function read(user, rel) { return fsp.readFile(resolve(user, rel)); }
  async function remove(user, rel) { await fsp.rm(resolve(user, rel), { force: true, recursive: true }); }
  /** What a command changed: files with their content (small ones), files too big to send, and deleted paths. */
  async function diff(user, before) {
    const root = ensure(user).ws, after = await scan(user), changed = [], deleted = []; let total = 0;
    for (const [rel, sig] of after) {
      if (before.get(rel) === sig) continue;
      const size = Number(sig.split(':')[0]);
      if (size > MAX_INLINE || total + size > MAX_INLINE_TOTAL) { changed.push({ path: rel, tooBig: true, size }); continue; }
      const buf = await fsp.readFile(path.join(root, rel)).catch(() => null); if (!buf) continue;
      total += buf.length; changed.push({ path: rel, b64: buf.toString('base64') });
    }
    for (const rel of before.keys()) if (!after.has(rel)) deleted.push(rel);
    return { changed, deleted };
  }
  return { ensure, dirs, ids, resolve, scan, list, write, read, remove, diff, isolation: () => (isRoot ? 'uid' : 'none') };
}

module.exports = { create, SKIP_DIRS };
