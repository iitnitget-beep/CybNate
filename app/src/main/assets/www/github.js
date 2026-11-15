/* GitHub sync without git: clone a repository into the workspace through the REST API,
 * and push the changes back as one commit. Needs only fetch + crypto.subtle. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GitHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const API = 'https://api.github.com';
  const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|\.next|\.gradle|__pycache__|\.venv|venv)\//;
  const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tar|7z|rar|jar|aar|apk|so|dll|exe|bin|dylib|class|woff2?|ttf|otf|eot|mp[34]|mov|avi|wav|ogg|psd|keystore|jks|lock)$/i;
  const SKIP_NAME = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
  const MAX_FILE = 400 * 1024, MAX_FILES = 500;

  function b64ToBytes(b64) {
    const bin = atob(b64.replace(/\s/g, '')); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  const utf8 = (s) => new TextEncoder().encode(s);
  function textOrBytes(bytes) {
    const n = Math.min(bytes.length, 8192);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return bytes;
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (e) { return bytes; }
  }

  /** The SHA-1 git uses for a blob, so local files can be compared with the repository without downloading. */
  async function blobSha(bytes) {
    const head = utf8('blob ' + bytes.length + '\0'), buf = new Uint8Array(head.length + bytes.length);
    buf.set(head); buf.set(bytes, head.length);
    const d = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
    return Array.from(d).map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function parseRepo(input) {
    const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^\s?#]+))?\/?$/.exec(String(input || '').trim());
    if (!m) throw new Error('Enter the repository as owner/name or paste its GitHub URL.');
    return { owner: m[1], repo: m[2], branch: m[3] || '' };
  }

  function client(token, fetchImpl) {
    const f = fetchImpl || fetch.bind(globalThis);
    return async function api(path, opt) {
      opt = opt || {};
      const headers = { Accept: 'application/vnd.github+json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (opt.body) headers['Content-Type'] = 'application/json';
      let res;
      try { res = await f(path.startsWith('http') ? path : API + path, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
      catch (e) { throw new Error('Could not reach GitHub. Check your internet connection.'); }
      if (opt.raw) { if (!res.ok) throw new Error('GitHub returned ' + res.status + ' for ' + path); return new Uint8Array(await res.arrayBuffer()); }
      let json = null; try { json = await res.json(); } catch (e) { /* empty body */ }
      if (!res.ok) {
        const msg = (json && json.message) || 'HTTP ' + res.status;
        if (res.status === 401) throw new Error('GitHub rejected the token. Create a new one and paste it again.');
        if (res.status === 403 && /rate limit/i.test(msg)) throw new Error('GitHub rate limit reached. Add a token (60 requests/hour without one) or wait.');
        if (res.status === 404) throw new Error('Not found: ' + (opt.what || path) + '. Check the name, and for a private repository that the token can access it.');
        if (res.status === 403) throw new Error('GitHub refused: ' + msg + '. The token needs "Contents: read and write" permission for this repository.');
        const err = new Error('GitHub: ' + msg); err.status = res.status; throw err;
      }
      return json;
    };
  }

  async function pool(items, n, fn) {
    let i = 0; const out = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }

  /** Download a repository. Returns { files: Map(path → string|Uint8Array), base, skipped }. */
  async function clone(opt) {
    const api = client(opt.token, opt.fetch);
    const { owner, repo } = opt;
    const r = '/repos/' + owner + '/' + repo;
    const info = await api(r, { what: owner + '/' + repo });
    const branch = opt.branch || info.default_branch;
    const ref = await api(r + '/git/ref/heads/' + branch.split('/').map(encodeURIComponent).join('/'), { what: 'branch ' + branch });
    const commit = ref.object.sha;
    const c = await api(r + '/git/commits/' + commit);
    const tree = await api(r + '/git/trees/' + c.tree.sha + '?recursive=1');
    const blobs = tree.tree.filter((e) => e.type === 'blob');
    const wanted = blobs.filter((e) => !SKIP_DIR.test(e.path + '/') && !SKIP_DIR.test(e.path) && !SKIP_EXT.test(e.path) && !SKIP_NAME.test(e.path) && (e.size || 0) <= MAX_FILE).slice(0, MAX_FILES);
    let done = 0;
    const files = new Map(), shas = {}, modes = {};
    await pool(wanted, 8, async (e) => {
      let bytes;
      if (opt.token || info.private) bytes = b64ToBytes((await api(r + '/git/blobs/' + e.sha)).content);
      else bytes = await api('https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + commit + '/' + e.path.split('/').map(encodeURIComponent).join('/'), { raw: true });
      files.set(e.path, textOrBytes(bytes)); shas[e.path] = e.sha; modes[e.path] = e.mode;
      if (opt.onProgress) opt.onProgress(++done, wanted.length);
    });
    return {
      files,
      skipped: blobs.length - wanted.length + (tree.truncated ? 1 : 0),
      base: { owner, repo, branch, commit, tree: c.tree.sha, shas, modes, canPush: !!(info.permissions && info.permissions.push), private: !!info.private, clonedAt: Date.now() },
    };
  }

  /** Compare the workspace with what was cloned. `ws` needs list() and bytes(path). */
  async function status(base, ws) {
    const added = [], modified = [], deleted = [];
    const here = new Set(ws.list());
    for (const p of here) {
      if (SKIP_DIR.test(p + '/') || SKIP_DIR.test(p)) continue;
      const sha = await blobSha(ws.bytes(p));
      if (!(p in base.shas)) added.push(p); else if (base.shas[p] !== sha) modified.push(p);
    }
    for (const p in base.shas) if (!here.has(p)) deleted.push(p);
    return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort(), count: added.length + modified.length + deleted.length };
  }

  /** Commit every workspace change on top of the cloned commit and move the branch. Returns the updated base. */
  async function push(opt) {
    const { base, ws, message } = opt;
    if (!opt.token) throw new Error('A GitHub token is required to push.');
    const api = client(opt.token, opt.fetch);
    const r = '/repos/' + base.owner + '/' + base.repo;
    const st = await status(base, ws);
    const branch = opt.branch || base.branch, newBranch = branch !== base.branch;
    if (!st.count && !(newBranch && opt.allowEmpty)) throw new Error('Nothing to commit: the workspace matches the repository.');
    const refPath = (b) => b.split('/').map(encodeURIComponent).join('/');
    if (!st.count) { // only a new branch name: point it at the cloned commit
      await api(r + '/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + branch, sha: base.commit } });
      return { base: Object.assign({}, base, { branch }), commit: base.commit, changed: 0, url: 'https://github.com/' + base.owner + '/' + base.repo + '/tree/' + refPath(branch) };
    }
    const entries = [];
    const newShas = Object.assign({}, base.shas);
    await pool(st.added.concat(st.modified), 4, async (p) => {
      const blob = await api(r + '/git/blobs', { method: 'POST', body: { content: bytesToB64(ws.bytes(p)), encoding: 'base64' } });
      entries.push({ path: p, mode: (base.modes && base.modes[p]) || '100644', type: 'blob', sha: blob.sha });
      newShas[p] = blob.sha;
    });
    st.deleted.forEach((p) => { entries.push({ path: p, mode: (base.modes && base.modes[p]) || '100644', type: 'blob', sha: null }); delete newShas[p]; });
    const tree = await api(r + '/git/trees', { method: 'POST', body: { base_tree: base.tree, tree: entries } });
    const commit = await api(r + '/git/commits', { method: 'POST', body: { message: message || 'Update from CybNate', tree: tree.sha, parents: [base.commit] } });
    try {
      if (newBranch) await api(r + '/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + branch, sha: commit.sha } });
      else await api(r + '/git/refs/heads/' + refPath(base.branch), { method: 'PATCH', body: { sha: commit.sha, force: false } });
    } catch (e) {
      if (newBranch && e.status === 422) throw new Error('The branch ' + branch + ' already exists on GitHub. Pick another name with `git checkout -b <name>`.');
      if (e.status === 422 || /fast.forward/i.test(e.message)) throw new Error('The branch has new commits on GitHub since you cloned. Export your work, clone again, and re-apply it.');
      throw e;
    }
    return { base: Object.assign({}, base, { branch, commit: commit.sha, tree: tree.sha, shas: newShas }), commit: commit.sha, changed: st.count, url: 'https://github.com/' + base.owner + '/' + base.repo + '/commit/' + commit.sha };
  }

  return { parseRepo, clone, status, push, blobSha };
});
