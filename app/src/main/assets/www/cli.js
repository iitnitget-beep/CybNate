/*
 * CybNate built-in command line tools: git (simplified), npm install (CDN bundles), curl / wget.
 * These are real implementations inside the app, not a Linux userland: each one says what it cannot do.
 * No DOM access here: everything the tools need is passed in as `deps`, so the same code runs in the unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./devtools.js'));
  else root.Cli = factory(root.DevTools);
})(typeof self !== 'undefined' ? self : this, function (DevTools) {
  'use strict';

  const IGNORE_DIRS = /(^|\/)(node_modules|__pycache__|\.git|\.venv|venv|\.pytest_cache|\.mypy_cache)(\/|$)/;
  const isBytes = (v) => v instanceof Uint8Array;
  function sig(v) { // cheap content signature for binary files
    let h = 2166136261 >>> 0; for (let i = 0; i < v.length; i++) { h ^= v[i]; h = Math.imul(h, 16777619) >>> 0; }
    return v.length + ':' + h.toString(16);
  }
  function hashHex(s) { // 40 hex characters, for local commit ids (not a real git object id)
    let out = ''; for (let k = 0; k < 5; k++) { let h = (2166136261 ^ (k * 0x9e3779b1)) >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } out += ('0000000' + h.toString(16)).slice(-8); }
    return out;
  }
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB');

  /**
   * deps: ws (Workspace), kv {get(key), set(key, value)} (async, structured values), http(url, {method, headers, body, signal}) -> {status, ctype, headers, text},
   *       GitHub, getRepo(), setRepo(base), token(), blob(sha) -> string|Uint8Array, approvePush({repo, branch, files, message}) -> bool,
   *       confirm(text) -> bool, run(cmd, timeoutSec, signal) -> {code, out, files}, matchGlob(glob, path), now()
   */
  function create(deps) {
    const ws = deps.ws;
    const now = () => (deps.now ? deps.now() : Date.now());
    const done = (out, code, files) => ({ code: code || 0, out: out == null ? '' : String(out), files: files || [] });

    // ------------------------------------------------------------------ git
    let G = null, loaded = false;
    async function gitLoad() {
      if (!loaded) { loaded = true; try { G = (await deps.kv.get('git')) || null; } catch (e) { G = null; } }
      const repo = deps.getRepo && deps.getRepo();
      // a repository cloned before this feature existed has no snapshot yet: rebuild it from the blob ids recorded at clone time
      if (!G && repo && repo.shas) {
        const base = {};
        for (const p of Object.keys(repo.shas)) {
          let same = false;
          if (ws.has(p)) { try { same = (await deps.GitHub.blobSha(ws.bytes(p))) === repo.shas[p]; } catch (e) { same = false; } }
          if (same) base[p] = snap(ws.get(p));
          else { try { base[p] = snap(await deps.blob(repo.shas[p])); } catch (e) { base[p] = { missing: true }; } }
        }
        G = { branch: repo.branch, commits: [{ id: repo.commit, msg: 'cloned from ' + repo.owner + '/' + repo.repo, time: repo.clonedAt || now(), remote: true }], base, pushed: 1 };
        await gitSave();
      }
      return G;
    }
    const gitSave = async () => { try { await deps.kv.set('git', G); } catch (e) { /* storage full: the repository still works for this session */ } };
    const snap = (v) => (isBytes(v) ? { bin: true, sig: sig(v) } : String(v));
    const ignoreRules = () => {
      if (!ws.has('.gitignore') || ws.isBinary('.gitignore')) return [];
      return ws.get('.gitignore').split('\n').map((l) => l.trim()).filter((l) => l && l[0] !== '#' && l[0] !== '!');
    };
    function ignored(p, rules) {
      if (IGNORE_DIRS.test(p)) return true;
      const mg = deps.matchGlob || (() => false);
      return rules.some((r) => {
        const dir = r.endsWith('/'), pat = r.replace(/^\//, '').replace(/\/$/, '');
        if (p === pat || p.indexOf(pat + '/') === 0 || p.indexOf('/' + pat + '/') >= 0) return true;
        if (dir) return false;
        return mg(pat, p) || mg(pat, p.split('/').pop()) || mg('**/' + pat, p);
      });
    }
    /** Changes of the workspace against the last commit: {added, modified, deleted} (sorted paths). */
    function gitChanges(g) {
      const base = (g || G || {}).base || {}, rules = ignoreRules();
      const added = [], modified = [], deleted = [];
      ws.list().forEach((p) => {
        if (ignored(p, rules)) return;
        if (!(p in base)) return added.push(p);
        const b = base[p], cur = ws.get(p);
        if (b && b.missing) return; // original unknown: cannot tell
        if (b && b.bin ? !(isBytes(cur) && sig(cur) === b.sig) : cur !== b) modified.push(p);
      });
      Object.keys(base).forEach((p) => { if (!ws.has(p)) deleted.push(p); });
      return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort(), count: added.length + modified.length + deleted.length };
    }
    const NOREPO = 'fatal: not a git repository. Run `git init` to start tracking this workspace, or `git clone <owner/repo>`.';
    function fileDiff(g, p) {
      const b = g.base[p], has = ws.has(p);
      if ((b && b.bin) || (has && ws.isBinary(p))) return 'Binary file ' + p + ' differs';
      if (b && b.missing) return p + ': the original content is not available (could not be downloaded)';
      return DevTools.unifiedDiff(b == null ? null : b, has ? ws.get(p) : null, p);
    }
    async function git(argv, signal) {
      const sub = argv[0] || '', rest = argv.slice(1);
      if (!sub || sub === '--help' || sub === 'help') return done('Built-in git (simplified). Commands: init, status, diff [--stat] [file], log [--oneline] [-n N], show, branch [name], checkout -- <file> | -b <branch>, restore <file>, add, commit -m "msg", clone <owner/repo> [-b branch], push, remote -v, rev-parse.\nNot available: merge, rebase, pull, fetch, stash, tags, submodules.');
      if (sub === '--version' || sub === 'version') return done('git (CybNate built-in, simplified)');
      if (sub === 'clone') return gitClone(rest, signal);
      let g = await gitLoad();
      if (sub === 'init') {
        if (g) return done('Reinitialized existing repository (' + g.commits.length + ' commits kept).');
        G = g = { branch: 'main', commits: [], base: {}, pushed: 0 }; await gitSave();
        return done('Initialized empty repository on branch main. Every file is untracked until the first `git commit -m "..."`.');
      }
      if (sub === 'config') return done('');
      if (!g) return done(NOREPO, 128);
      const repo = deps.getRepo && deps.getRepo();
      const ahead = g.commits.length - (g.pushed || 0);
      switch (sub) {
        case 'status': {
          const c = gitChanges(g), short = rest.some((x) => x === '-s' || x === '--short' || x === '--porcelain');
          if (short) return done(c.modified.map((p) => ' M ' + p).concat(c.deleted.map((p) => ' D ' + p), c.added.map((p) => '?? ' + p)).join('\n'));
          let o = 'On branch ' + g.branch + '\n';
          if (repo) o += ahead > 0 ? 'Your branch is ahead of origin/' + repo.branch + ' by ' + plural(ahead, 'commit') + ' (use `git push`).\n' : 'Your branch is up to date with origin/' + repo.branch + ' (as of the clone or last push).\n';
          if (!g.commits.length) o += '\nNo commits yet\n';
          if (!c.count) return done(o + 'nothing to commit, working tree clean');
          if (c.modified.length || c.deleted.length) o += '\nChanges not yet committed:\n' + c.modified.map((p) => '\tmodified:   ' + p).concat(c.deleted.map((p) => '\tdeleted:    ' + p)).join('\n') + '\n';
          if (c.added.length) o += '\nNew files:\n' + c.added.map((p) => '\t' + p).join('\n') + '\n';
          return done(o + '\n' + plural(c.count, 'change') + ' will be included in the next `git commit -m "..."` (there is no separate staging step).');
        }
        case 'diff': {
          const stat = rest.some((x) => x === '--stat' || x === '--shortstat' || x === '--numstat'), names = rest.some((x) => x === '--name-only' || x === '--name-status');
          const want = rest.filter((x) => x[0] !== '-' && x !== 'HEAD' && !/^(origin\/|HEAD[~^])/.test(x)).map((x) => x.replace(/^\.\//, '').replace(/\/$/, ''));
          const c = gitChanges(g);
          let paths = c.modified.concat(c.deleted, c.added).sort();
          if (want.length) paths = paths.filter((p) => want.some((w) => w === '.' || p === w || p.indexOf(w + '/') === 0));
          if (!paths.length) return done('');
          if (names) return done(paths.join('\n'));
          if (stat) {
            let ta = 0, td = 0;
            const rows = paths.map((p) => {
              const b = g.base[p]; if ((b && (b.bin || b.missing)) || (ws.has(p) && ws.isBinary(p))) return ' ' + p + ' | Bin';
              const s = DevTools.diffStat(b == null ? null : b, ws.has(p) ? ws.get(p) : null); ta += s.add; td += s.del;
              return ' ' + p + ' | ' + (s.add + s.del) + ' ' + '+'.repeat(Math.min(s.add, 30)) + '-'.repeat(Math.min(s.del, 30));
            });
            return done(rows.join('\n') + '\n ' + plural(paths.length, 'file') + ' changed, ' + plural(ta, 'insertion') + '(+), ' + plural(td, 'deletion') + '(-)');
          }
          return done(paths.map((p) => 'diff --git a/' + p + ' b/' + p + '\n' + fileDiff(g, p)).join('\n'));
        }
        case 'log': {
          if (!g.commits.length) return done("fatal: your current branch '" + g.branch + "' does not have any commits yet", 128);
          const one = rest.indexOf('--oneline') >= 0; let n = 20;
          rest.forEach((x, i) => { const m = /^-(\d+)$/.exec(x) || (/^(-n|--max-count)$/.test(x) ? [0, rest[i + 1]] : /^--max-count=(\d+)$/.exec(x)); if (m && +m[1] > 0) n = +m[1]; });
          const list = g.commits.slice().reverse().slice(0, n);
          return done(list.map((c, i) => {
            const tag = i === 0 ? ' (HEAD -> ' + g.branch + ')' : '';
            if (one) return c.id.slice(0, 7) + tag + ' ' + c.msg.split('\n')[0];
            return 'commit ' + c.id + tag + (c.remote ? '  [on GitHub]' : g.commits.indexOf(c) >= (g.pushed || 0) ? '  [local, not pushed]' : '  [pushed]') + '\nDate:   ' + new Date(c.time).toISOString() + '\n\n    ' + c.msg.split('\n').join('\n    ') + (c.stat ? '\n\n    ' + c.stat : '') + '\n';
          }).join('\n'));
        }
        case 'show': {
          const c = g.commits[g.commits.length - 1];
          if (!c) return done('fatal: no commits yet', 128);
          return done('commit ' + c.id + '\nDate:   ' + new Date(c.time).toISOString() + '\n\n    ' + c.msg + '\n\n' + (c.files ? c.files.join('\n') : '') + '\n(The built-in git keeps the file list of a commit, not its full diff.)');
        }
        case 'branch': {
          const name = rest.filter((x) => x[0] !== '-')[0];
          if (rest.indexOf('--show-current') >= 0) return done(g.branch);
          if (!name) return done('* ' + g.branch + (repo && rest.some((x) => x === '-a' || x === '-r') ? '\n  remotes/origin/' + repo.branch : ''));
          return done("Branches here are a label on one working copy. Use `git checkout -b " + name + "` to continue on a new branch name (git push then creates it on GitHub).", 1);
        }
        case 'switch': case 'checkout': case 'restore': case 'reset': {
          if (sub === 'reset' && rest.indexOf('--hard') < 0) return done('Only `git reset --hard` (discard all uncommitted changes) is supported; there is no staging area to reset.', 1);
          const bi = rest.findIndex((x) => x === '-b' || x === '-c' || x === '-B');
          if (bi >= 0 && (sub === 'checkout' || sub === 'switch')) {
            const name = rest[bi + 1]; if (!name || !/^[\w./-]+$/.test(name)) return done('fatal: a valid branch name is required', 128);
            g.branch = name; await gitSave(); return done("Switched to a new branch '" + name + "'");
          }
          let targets = rest.filter((x) => x !== '--' && x[0] !== '-' && x !== 'HEAD').map((x) => x.replace(/^\.\//, '').replace(/\/$/, ''));
          if (sub === 'reset') targets = ['.'];
          if (!targets.length) return done(sub === 'restore' ? 'fatal: you must specify path(s) to restore' : 'Usage: git checkout -- <file>   or   git checkout -b <new-branch>', 1);
          if ((sub === 'checkout' || sub === 'switch') && rest.indexOf('--') < 0 && targets.length === 1 && !(targets[0] in g.base) && !ws.has(targets[0]) && targets[0] !== '.') {
            if (targets[0] === g.branch) return done("Already on '" + g.branch + "'");
            return done("error: branch '" + targets[0] + "' is not available here: this git keeps one working copy. To work on another GitHub branch run `git clone <owner/repo> -b " + targets[0] + '`; to start a new branch run `git checkout -b ' + targets[0] + '`.', 1);
          }
          const c = gitChanges(g), hit = (p) => targets.some((w) => w === '.' || p === w || p.indexOf(w + '/') === 0);
          const touched = [], problems = [];
          c.modified.concat(c.deleted).filter(hit).forEach((p) => {
            const b = g.base[p];
            if (typeof b !== 'string') { problems.push(p + ' (binary or unavailable original: cannot be restored)'); return; }
            if (ws.remember) ws.remember(p); ws.set(p, b); touched.push(p);
          });
          if (sub === 'reset') c.added.forEach(() => {}); // untracked files stay, as in git
          if (!touched.length && !problems.length) return done(targets[0] === '.' ? 'Nothing to restore: no tracked file has uncommitted changes.' : "error: pathspec '" + targets.join(' ') + "' did not match any changed tracked file", targets[0] === '.' ? 0 : 1);
          return done((touched.length ? 'Restored ' + plural(touched.length, 'file') + ' from the last commit: ' + touched.join(', ') : '') + (problems.length ? '\nNot restored: ' + problems.join('; ') : ''), problems.length && !touched.length ? 1 : 0, touched);
        }
        case 'add': case 'stage': return done('');
        case 'rm': return done('Delete the file (rm or delete_file); the deletion is included in the next commit.', 1);
        case 'commit': {
          let msg = '';
          rest.forEach((x, i) => { if (/^-[a-z]*m$/.test(x) && rest[i + 1] != null) msg += (msg ? '\n\n' : '') + rest[i + 1]; const m = /^--message=(.*)$/.exec(x); if (m) msg = m[1]; });
          if (!msg.trim()) return done('error: a commit message is required: git commit -m "message"', 1);
          const c = gitChanges(g);
          if (!c.count) return done('On branch ' + g.branch + '\nnothing to commit, working tree clean', 1);
          const files = c.added.map((p) => 'A  ' + p).concat(c.modified.map((p) => 'M  ' + p), c.deleted.map((p) => 'D  ' + p));
          let ins = 0, del = 0;
          c.added.concat(c.modified, c.deleted).forEach((p) => { const b = g.base[p]; if ((b && typeof b !== 'string') || (ws.has(p) && ws.isBinary(p))) return; const s = DevTools.diffStat(b == null ? null : b, ws.has(p) ? ws.get(p) : null); ins += s.add; del += s.del; });
          const rules = ignoreRules(), base = {};
          ws.list().forEach((p) => { if (!ignored(p, rules)) base[p] = snap(ws.get(p)); });
          const stat = plural(c.count, 'file') + ' changed, ' + plural(ins, 'insertion') + '(+), ' + plural(del, 'deletion') + '(-)';
          const id = hashHex(msg + '|' + now() + '|' + files.join(',') + '|' + (g.commits.length ? g.commits[g.commits.length - 1].id : ''));
          g.base = base; g.commits.push({ id, msg: msg.trim(), time: now(), files, stat }); await gitSave();
          return done('[' + g.branch + ' ' + id.slice(0, 7) + '] ' + msg.trim().split('\n')[0] + '\n ' + stat + (repo ? '\nThis commit is local. `git push` sends it to GitHub.' : ''));
        }
        case 'remote': return done(repo ? (rest.indexOf('-v') >= 0 ? 'origin\thttps://github.com/' + repo.owner + '/' + repo.repo + '.git (fetch)\norigin\thttps://github.com/' + repo.owner + '/' + repo.repo + '.git (push)' : 'origin') : '');
        case 'rev-parse': {
          if (rest.indexOf('--abbrev-ref') >= 0) return done(g.branch);
          if (rest.indexOf('--show-toplevel') >= 0) return done('/');
          if (rest.indexOf('--is-inside-work-tree') >= 0) return done('true');
          const c = g.commits[g.commits.length - 1]; if (!c) return done('fatal: no commits yet', 128);
          return done(rest.indexOf('--short') >= 0 ? c.id.slice(0, 7) : c.id);
        }
        case 'push': {
          if (!repo) return done('fatal: no GitHub repository is connected. Clone one with `git clone <owner/repo>`; this git cannot create a new repository on GitHub.', 128);
          const c = gitChanges(g);
          if (c.count) return done('error: ' + plural(c.count, 'uncommitted change') + '. Commit them first (`git commit -m "..."`) or discard them (`git checkout -- <file>`).', 1);
          const local = g.commits.slice(g.pushed || 0).filter((x) => !x.remote);
          const newBranch = g.branch !== repo.branch;
          if (!local.length && !newBranch) return done('Everything up-to-date');
          if (!deps.token || !deps.token()) return done('fatal: a GitHub token is needed to push. The user adds it in the GitHub screen of the app.', 128);
          const message = local.length === 1 ? local[0].msg : local.length ? local[local.length - 1].msg.split('\n')[0] + '\n\n' + local.map((x) => '* ' + x.msg.split('\n')[0]).join('\n') : 'Create branch ' + g.branch;
          const files = [].concat.apply([], local.map((x) => x.files || []));
          const ok = await deps.approvePush({ repo: repo.owner + '/' + repo.repo, branch: g.branch, files, message });
          if (!ok) return done('DENIED by the user: nothing was pushed. Do not retry; ask the user what they want.', 1);
          let r;
          try { r = await deps.GitHub.push({ token: deps.token(), base: repo, ws, message, branch: g.branch, allowEmpty: newBranch }); }
          catch (e) { return done('error: push failed: ' + (e && e.message ? e.message : e), 1); }
          deps.setRepo(r.base); g.pushed = g.commits.length; g.commits.push({ id: r.commit, msg: message.split('\n')[0], time: now(), remote: true }); g.pushed = g.commits.length; await gitSave();
          return done('To https://github.com/' + repo.owner + '/' + repo.repo + '.git\n   ' + repo.commit.slice(0, 7) + '..' + r.commit.slice(0, 7) + '  ' + g.branch + ' -> ' + g.branch + (local.length > 1 ? '\n(' + local.length + ' local commits were sent as one GitHub commit.)' : '') + (r.url ? '\n' + r.url : ''));
        }
        case 'pull': case 'fetch': case 'merge': case 'rebase': case 'stash': case 'tag': case 'cherry-pick': case 'revert': case 'submodule': case 'bisect': case 'worktree':
          return done('git ' + sub + ' is not available in the built-in git (one working copy, no merge engine). ' + (sub === 'pull' || sub === 'fetch' ? 'To get the newest GitHub state, commit or export your work and run `git clone <owner/repo>` again.' : sub === 'stash' ? 'Use the app\'s Undo, or commit your work first.' : ''), 1);
      }
      return done("git: '" + sub + "' is not a command of the built-in git. Run `git help`.", 1);
    }
    async function gitClone(rest, signal) {
      let branch = ''; const pos = [];
      for (let i = 0; i < rest.length; i++) { if (rest[i] === '-b' || rest[i] === '--branch') branch = rest[++i] || ''; else if (rest[i] === '--depth') i++; else if (rest[i][0] !== '-') pos.push(rest[i]); }
      if (!pos[0]) return done('usage: git clone <owner/repo or GitHub URL> [-b branch]', 129);
      let pr; try { pr = deps.GitHub.parseRepo(pos[0]); } catch (e) { return done('fatal: ' + e.message + ' (only GitHub repositories can be cloned)', 128); }
      const n = ws.list().length;
      if (n && !(await deps.confirm('Cloning ' + pr.owner + '/' + pr.repo + ' replaces the ' + n + ' files now in the workspace. Continue?'))) return done('DENIED by the user: the workspace was not replaced. Do not retry; ask the user what they want.', 1);
      let res;
      try { res = await deps.GitHub.clone({ token: deps.token ? deps.token() : '', owner: pr.owner, repo: pr.repo, branch: branch || pr.branch }); }
      catch (e) { return done('fatal: ' + (e && e.message ? e.message : e), 128); }
      if (signal && signal.aborted) return done('stopped', 130);
      ws.list().forEach((p) => ws.remove(p));
      res.files.forEach((v, k) => ws.set(k, v));
      deps.setRepo(res.base);
      await adoptClone(res.base);
      return done("Cloning into the workspace...\n" + plural(res.files.size, 'file') + ' from ' + pr.owner + '/' + pr.repo + ' (branch ' + res.base.branch + ', commit ' + res.base.commit.slice(0, 7) + ')' + (res.skipped ? '\n' + res.skipped + ' large or binary files were left on GitHub.' : ''), 0, Array.from(res.files.keys()).slice(0, 20));
    }
    /** Take the current workspace as the state of a fresh clone (also called by the GitHub screen). */
    async function adoptClone(base) {
      const snapd = {}; ws.list().forEach((p) => { snapd[p] = snap(ws.get(p)); });
      G = { branch: base.branch, commits: [{ id: base.commit, msg: 'cloned from ' + base.owner + '/' + base.repo, time: now(), remote: true }], base: snapd, pushed: 1 }; loaded = true;
      await gitSave();
    }
    /** After a push made from the GitHub screen: the workspace is the new baseline. */
    async function adoptPush(base, message) {
      await gitLoad(); if (!G) return adoptClone(base);
      const snapd = {}, rules = ignoreRules(); ws.list().forEach((p) => { if (!ignored(p, rules)) snapd[p] = snap(ws.get(p)); });
      G.base = snapd; G.commits.push({ id: base.commit, msg: message || 'Update from CybNate', time: now(), remote: true }); G.pushed = G.commits.length; await gitSave();
    }
    async function gitForget() { G = null; loaded = true; try { await deps.kv.set('git', null); } catch (e) { /* nothing stored */ } }
    /** For the file list: {path: 'M'|'A'} against the last commit, or null when there is no repository. */
    async function gitBadges() { const g = await gitLoad(); if (!g) return null; const c = gitChanges(g), o = {}; c.modified.forEach((p) => { o[p] = 'M'; }); c.added.forEach((p) => { o[p] = 'A'; }); return o; }
    /** Last committed text of a file: string, null (new file) or undefined (unknown / binary). */
    async function gitBaseText(p) { const g = await gitLoad(); if (!g) return undefined; const b = g.base[p]; return b == null ? null : typeof b === 'string' ? b : undefined; }

    // ----------------------------------------------------------------- curl
    async function curl(prog, argv, cwd, signal) {
      const o = { method: '', headers: {}, data: [], include: false, head: false, out: '', fail: false, silent: false, json: false, form: false, url: '', writeOut: '', user: '' };
      const wget = prog === 'wget'; const bad = [];
      // -qO- and -ofile: split flags glued to their value
      argv = [].concat.apply([], argv.map((x) => { const m = wget ? /^-([a-zA-Z]*)O(.+)$/.exec(x) : /^-([sSLkif]*)([oXHdAuw])(.+)$/.exec(x); return m && !/^--/.test(x) ? (m[1] ? ['-' + m[1]] : []).concat(wget ? ['-O', m[2]] : ['-' + m[2], m[3]]) : [x]; }));
      const val = (i) => argv[i + 1];
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-X' || a === '--request' || a === '--method') o.method = String(val(i++) || '').toUpperCase();
        else if (/^--method=/.test(a)) o.method = a.slice(9).toUpperCase();
        else if (a === '-H' || a === '--header') { const h = String(val(i++) || ''), k = h.indexOf(':'); if (k > 0) o.headers[h.slice(0, k).trim()] = h.slice(k + 1).trim(); }
        else if (/^--header=/.test(a)) { const h = a.slice(9), k = h.indexOf(':'); if (k > 0) o.headers[h.slice(0, k).trim()] = h.slice(k + 1).trim(); }
        else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary' || a === '--data-ascii' || a === '--post-data' || a === '--body-data') { let d = String(val(i++) || ''); if (d[0] === '@' && a !== '--data-raw') { const p = (cwd ? cwd + '/' : '') + d.slice(1); if (!ws.has(p)) return done(prog + ": cannot read '" + d.slice(1) + "': no such file in the workspace", 26); d = ws.isBinary(p) ? '' : ws.get(p); } o.data.push(d); }
        else if (/^--post-data=/.test(a)) o.data.push(a.slice(12));
        else if (a === '--json') { o.data.push(String(val(i++) || '')); o.json = true; }
        else if (a === '--data-urlencode') { const d = String(val(i++) || ''), k = d.indexOf('='); o.data.push(k >= 0 ? d.slice(0, k) + '=' + encodeURIComponent(d.slice(k + 1)) : encodeURIComponent(d)); }
        else if (a === '-o' || a === '--output' || (wget && (a === '-O' || a === '--output-document'))) o.out = String(val(i++) || '');
        else if (/^--output-document=/.test(a)) o.out = a.slice(18);
        else if (a === '-O' || a === '--remote-name') o.out = '\u0000remote';
        else if (a === '-A' || a === '--user-agent') o.headers['User-Agent'] = String(val(i++) || '');
        else if (a === '-e' || a === '--referer') o.headers.Referer = String(val(i++) || '');
        else if (a === '-b' || a === '--cookie') o.headers.Cookie = String(val(i++) || '');
        else if (a === '-u' || a === '--user') o.user = String(val(i++) || '');
        else if (a === '-w' || a === '--write-out') o.writeOut = String(val(i++) || '');
        else if (a === '-m' || a === '--max-time' || a === '--connect-timeout' || a === '--retry' || a === '-T' || a === '--timeout' || a === '--tries' || a === '-t') i++;
        else if (a === '--url') o.url = String(val(i++) || '');
        else if (a === '-F' || a === '--form') { bad.push(a + ' (multipart form upload)'); i++; }
        else if (a === '-G' || a === '--get') o.method = 'GET';
        else if (/^--/.test(a)) { if (a === '--include') o.include = true; else if (a === '--head') o.head = true; else if (a === '--fail' || a === '--fail-with-body') o.fail = true; else if (a === '--silent' || a === '--quiet') o.silent = true; /* --location, --compressed, --insecure, --show-error, --no-progress-meter: nothing to do */ }
        else if (/^-[a-zA-Z]+$/.test(a)) { for (const ch of a.slice(1)) { if (ch === 'i') o.include = true; else if (ch === 'I') o.head = true; else if (ch === 'f') o.fail = true; else if (ch === 's' || ch === 'q') o.silent = true; else if ('LkSvN#gc'.indexOf(ch) < 0) bad.push('-' + ch); } }
        else if (!o.url) o.url = a;
      }
      if (bad.length) return done(prog + ': option not supported by the built-in ' + prog + ': ' + bad.join(', '), 2);
      if (!o.url) return done(prog + ': no URL given. Usage: ' + prog + ' [-X METHOD] [-H "Name: value"] [-d data] [-i] [-s] [-o file] <url>', 2);
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(o.url)) o.url = 'http://' + o.url;
      let host = ''; try { host = new URL(o.url).hostname; } catch (e) { return done(prog + ': (3) URL rejected: malformed URL', 3); }
      if (!/^https?:/i.test(o.url)) return done(prog + ': (1) only http and https URLs are supported', 1);
      if (/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/.test(host)) return done(prog + ': (7) Failed to connect to ' + host + ': no server can listen on a port inside this app. Test the server\'s code by calling its functions directly (or run it on a real machine).', 7);
      if (o.head) o.method = 'HEAD';
      const body = o.data.length ? o.data.join('&') : '';
      const method = o.method || (body ? 'POST' : 'GET');
      const has = (n) => Object.keys(o.headers).some((k) => k.toLowerCase() === n);
      if (body && !has('content-type')) o.headers['Content-Type'] = o.json ? 'application/json' : 'application/x-www-form-urlencoded';
      if (o.json && !has('accept')) o.headers.Accept = 'application/json';
      if (o.user && !has('authorization')) { try { o.headers.Authorization = 'Basic ' + (typeof btoa === 'function' ? btoa(o.user) : Buffer.from(o.user).toString('base64')); } catch (e) { /* non-latin credentials */ } }
      let res; const t0 = now();
      try { res = await deps.http(o.url, { method, headers: o.headers, body: body || undefined, signal }); }
      catch (e) { if (e && e.name === 'AbortError') throw e; return done(prog + ': (6) ' + (e && e.message ? e.message : 'request failed') + ' [' + host + ']', 6); }
      const ctype = res.ctype || '', text = res.text || '';
      const hdr = 'HTTP ' + res.status + '\n' + (ctype ? 'content-type: ' + ctype + '\n' : '') + Object.keys(res.headers || {}).filter((k) => k.toLowerCase() !== 'content-type').map((k) => k + ': ' + res.headers[k] + '\n').join('');
      let outFile = o.out === '\u0000remote' || (wget && !o.out) ? (o.url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || 'index.html') : o.out;
      if (wget && !o.out && !/\./.test(outFile)) outFile = 'index.html';
      if (outFile === '-') outFile = '';
      const failed = res.status >= 400;
      if ((o.fail || wget) && failed) return done(prog + ': (22) The requested URL returned error: ' + res.status, wget ? 8 : 22);
      const w = o.writeOut ? o.writeOut.replace(/%\{http_code\}|%\{response_code\}/g, String(res.status)).replace(/%\{content_type\}/g, ctype).replace(/%\{size_download\}/g, String(text.length)).replace(/%\{time_total\}/g, ((now() - t0) / 1000).toFixed(3)).replace(/%\{url_effective\}/g, o.url).replace(/\\n/g, '\n') : '';
      if (outFile === '/dev/null') return done((o.include ? hdr : '') + w);
      if (outFile) {
        if (/^(image|audio|video|font)\//.test(ctype) || /zip|gzip|pdf|octet-stream|wasm|x-tar|protobuf|msword|officedocument|android\.package/.test(ctype))
          return done(prog + ': (23) ' + (ctype || 'this response') + ' is binary: the built-in ' + prog + ' transfers text only, so the file was not saved (it would be corrupted).', 23);
        const p = ws.set((cwd ? cwd + '/' : '') + outFile, text);
        return done((o.include ? hdr + '\n' : '') + (o.silent ? '' : 'Saved ' + p + ' (' + fmtSize(text.length) + ', HTTP ' + res.status + ')') + w, 0, [p]);
      }
      if (o.head) return done(hdr + w);
      return done((o.include ? hdr + '\n' : '') + text + w);
    }

    // ------------------------------------------------------------------ npm
    const CDN = 'https://cdn.jsdelivr.net/npm/';
    const NODE_BUILTINS = ['fs', 'path', 'assert', 'util', 'os', 'events', 'buffer', 'url', 'querystring', 'crypto', 'child_process', 'http', 'https', 'stream', 'zlib', 'net', 'tls', 'dns', 'readline', 'worker_threads', 'cluster', 'vm', 'module', 'string_decoder', 'timers', 'tty', 'perf_hooks', 'process', 'constants', 'punycode', 'v8', 'async_hooks', 'http2', 'dgram', 'fs/promises', 'timers/promises', 'util/types', 'diagnostics_channel'];
    const pjPath = (cwd) => (cwd ? cwd + '/' : '') + 'package.json';
    function readPj(cwd) { const p = pjPath(cwd); if (!ws.has(p)) return null; try { return JSON.parse(ws.get(p)); } catch (e) { throw new Error('package.json is not valid JSON: ' + e.message); } }
    const norm = (p) => { const parts = []; String(p).split('/').forEach((s) => { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); }); return parts.join('/'); };
    const dirOf = (p) => (p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '');
    const looksEsm = (src) => /^\s*(import\s+[\w{*"']|import\s*\{|export\s+(default|const|let|var|function|class|async|\{|\*))/m.test(src) && !/\bmodule\.exports\b|\bexports\.[\w$]+\s*=|typeof exports|typeof define/.test(src);
    function parseSpec(s) { const m = /^(@[^/]+\/[^@/]+|[^@/]+)(?:@(.+))?$/.exec(s); return m && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(m[1]) ? { name: m[1], range: m[2] || '' } : null; }
    async function getText(url, signal) {
      const r = await deps.http(url, { method: 'GET', headers: { Accept: '*/*' }, signal });
      return r.status >= 200 && r.status < 300 ? r.text || '' : null;
    }
    /** Download one package (its browser bundle when it has one) into <root>node_modules/<name>/. */
    async function installOne(spec, rootDir, st, depth, signal) {
      if (st.done[spec.name]) return st.done[spec.name];
      if (Object.keys(st.done).length >= 30) throw new Error('too many dependencies (limit 30 packages per install)');
      const at = spec.name + (spec.range ? '@' + spec.range : '');
      const metaText = await getText(CDN + at + '/package.json', signal);
      if (metaText == null) throw new Error("'" + at + "' was not found on the npm CDN (check the name and version)");
      let meta; try { meta = JSON.parse(metaText); } catch (e) { throw new Error('bad package.json for ' + at); }
      const ver = meta.version || spec.range || 'latest', base = CDN + spec.name + '@' + ver + '/';
      const info = (st.done[spec.name] = { name: spec.name, version: ver, files: 0, bytes: 0, notes: [] });
      const dest = (rootDir ? rootDir + '/' : '') + 'node_modules/' + spec.name + '/';
      const exp = meta.exports && typeof meta.exports === 'object' ? (meta.exports['.'] || meta.exports) : null;
      const pick = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (pick(v.require) || pick(v.default) || pick(v.browser) || pick(v.node)) : '');
      const cands = [];
      [meta.unpkg, meta.jsdelivr, typeof meta.browser === 'string' ? meta.browser : '', pick(exp && exp.require), meta.main, pick(exp), 'index.js'].forEach((c) => { if (c && typeof c === 'string') { c = norm(c); if (cands.indexOf(c) < 0) cands.push(c); } });
      const files = {}; let entry = '', esmOnly = false;
      const fetchRel = async (rel) => {
        const tries = /\.(js|cjs|json|mjs)$/.test(rel) ? [rel] : [rel + '.js', rel + '.json', rel + '/index.js', rel + '.cjs', rel];
        for (const t of tries) { if (t in files) return t; const src = await getText(base + t, signal); if (src != null && !/^<!DOCTYPE html/i.test(src)) { files[t] = src; return t; } }
        return '';
      };
      for (const c of cands) {
        const got = await fetchRel(c);
        if (!got) continue;
        if (/\.mjs$/.test(got) || looksEsm(files[got])) { esmOnly = true; delete files[got]; continue; }
        entry = got; break;
      }
      if (!entry) throw new Error(esmOnly ? spec.name + '@' + ver + ' ships only ES modules; this runtime loads CommonJS/UMD bundles. Look for an older version or a package with a UMD/CommonJS build.' : spec.name + '@' + ver + ' has no loadable entry file');
      // follow relative requires inside the package, and collect bare requires as dependencies
      const queue = [entry], seen = new Set([entry]), bare = new Set(); let total = files[entry].length;
      while (queue.length) {
        const f = queue.shift(), src = files[f];
        if (/\.json$/.test(f)) continue;
        const re = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g; let m;
        while ((m = re.exec(src))) {
          const name = m[2].replace(/^node:/, '');
          if (/^\.{1,2}(\/|$)/.test(name)) {
            if (seen.size >= 150 || total > 4 * 1048576) { if (info.notes.indexOf('large package: only part of it was downloaded') < 0) info.notes.push('large package: only part of it was downloaded'); continue; }
            const got = await fetchRel(norm(dirOf(f) + '/' + name));
            if (got && !seen.has(got)) { seen.add(got); queue.push(got); total += files[got].length; }
          } else if (NODE_BUILTINS.indexOf(name) < 0) bare.add(name.split('/').slice(0, name[0] === '@' ? 2 : 1).join('/'));
        }
      }
      Object.keys(files).forEach((f) => { ws.set(dest + f, files[f]); st.written.push(dest + f); });
      ws.set(dest + 'package.json', JSON.stringify({ name: spec.name, version: ver, main: entry, license: meta.license, _from: base + entry }, null, 2) + '\n'); st.written.push(dest + 'package.json');
      info.files = Object.keys(files).length; info.bytes = total; info.entry = entry;
      const needsNode = Object.keys(files).some((f) => /\brequire\(\s*['"](node:)?(net|tls|dns|child_process|cluster|worker_threads|zlib|http2|dgram|readline)['"]\s*\)/.test(files[f]));
      if (needsNode) info.notes.push('uses Node.js internals that this runtime does not have: parts of it may fail when called');
      for (const dep of bare) {
        if (st.done[dep]) continue;
        const range = (meta.dependencies && meta.dependencies[dep]) || (meta.peerDependencies && meta.peerDependencies[dep]) || '';
        if (!range && !(meta.optionalDependencies && meta.optionalDependencies[dep])) { continue; } // optional / guarded require
        if (depth >= 4) { info.notes.push('dependency ' + dep + ' not installed (too deep)'); continue; }
        try { await installOne({ name: dep, range: /^[\^~]?\d[\w.-]*$/.test(range) ? range : '' }, rootDir, st, depth + 1, signal); }
        catch (e) { if (e && e.name === 'AbortError') throw e; info.notes.push('dependency ' + dep + ' failed: ' + (e.message || e)); }
      }
      return info;
    }
    async function npm(pc, signal) {
      const cwd = pc.cwd || '';
      let pj; try { pj = readPj(cwd); } catch (e) { return done('npm ERR! ' + e.message, 1); }
      if (pc.sub === 'init') {
        if (pj) return done('package.json already exists.');
        const p = ws.set(pjPath(cwd), JSON.stringify({ name: (cwd.split('/').pop() || 'app').toLowerCase().replace(/[^a-z0-9-_.]/g, '-'), version: '1.0.0', description: '', main: 'index.js', scripts: { test: 'node test.js' }, dependencies: {} }, null, 2) + '\n');
        return done('Wrote ' + p, 0, [p]);
      }
      if (pc.sub === 'scripts') return done(pj && pj.scripts ? 'Scripts in package.json:\n' + Object.keys(pj.scripts).map((k) => '  ' + k + '\n    ' + pj.scripts[k]).join('\n') : 'No scripts in package.json.');
      if (pc.sub === 'list') {
        const pre = (cwd ? cwd + '/' : '') + 'node_modules/', rows = [];
        ws.list().forEach((p) => { const m = p.indexOf(pre) === 0 && /^((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(p.slice(pre.length)); if (m) { let v = ''; try { v = JSON.parse(ws.get(p)).version; } catch (e) { v = '?'; } rows.push(m[1] + '@' + v); } });
        return done((pj && pj.name ? pj.name + '@' + (pj.version || '0.0.0') : 'workspace') + '\n' + (rows.length ? rows.map((r) => '├── ' + r).join('\n') : '└── (empty)'));
      }
      if (pc.sub === 'run') {
        const s = pj && pj.scripts && pj.scripts[pc.script];
        if (!s) return done('npm ERR! Missing script: "' + pc.script + '"' + (pj && pj.scripts ? '\nAvailable: ' + Object.keys(pj.scripts).join(', ') : '\nThere is no package.json with scripts here.'), 1);
        const parts = s.split(/\s*&&\s*/); let out = '', files = [];
        for (const part of parts) {
          out += '\n> ' + part + '\n';
          const r = await deps.run((cwd ? 'cd ' + cwd + ' && ' : '') + part, pc.timeout || 120, signal);
          out += (r.out || ''); files = files.concat(r.files || []);
          if (r.code) return done(out.trim() + '\nnpm ERR! script "' + pc.script + '" exited with code ' + r.code, r.code, files);
        }
        return done(out.trim(), 0, files);
      }
      if (pc.sub === 'install') {
        let specs = (pc.pkgs || []).map(parseSpec);
        if (specs.some((x) => !x)) return done('npm ERR! Invalid package name: ' + pc.pkgs[specs.findIndex((x) => !x)], 1);
        const fromPj = !specs.length;
        if (fromPj) {
          if (!pj) return done('npm ERR! no package.json here and no package named. Usage: npm install <package>', 1);
          const all = Object.assign({}, pj.dependencies || {}, pj.devDependencies || {});
          specs = Object.keys(all).map((n) => ({ name: n, range: /^[\^~]?\d[\w.-]*$/.test(all[n]) ? all[n] : '' }));
          if (!specs.length) return done('up to date: package.json lists no dependencies.');
        }
        const st = { done: {}, written: [] }, errors = [], top = [];
        for (const sp of specs) {
          try { top.push(await installOne(sp, cwd, st, 0, signal)); }
          catch (e) { if (e && e.name === 'AbortError') throw e; delete st.done[sp.name]; errors.push('npm ERR! ' + sp.name + ': ' + (e && e.message ? e.message : e)); }
        }
        if (top.length && !fromPj) {
          pj = pj || { name: (cwd.split('/').pop() || 'workspace').toLowerCase().replace(/[^a-z0-9-_.]/g, '-'), version: '1.0.0', private: true };
          const key = pc.dev ? 'devDependencies' : 'dependencies'; pj[key] = pj[key] || {};
          top.forEach((i) => { pj[key][i.name] = '^' + i.version; });
          const sorted = {}; Object.keys(pj[key]).sort().forEach((k) => { sorted[k] = pj[key][k]; }); pj[key] = sorted;
          st.written.push(ws.set(pjPath(cwd), JSON.stringify(pj, null, 2) + '\n'));
        }
        const all = Object.keys(st.done).map((k) => st.done[k]).filter((i) => i.files);
        let out = all.length ? 'added ' + plural(all.length, 'package') + ':\n' + all.map((i) => '  ' + i.name + '@' + i.version + '  (' + plural(i.files, 'file') + ', ' + fmtSize(i.bytes) + ', entry ' + i.entry + ')' + i.notes.map((n) => '\n    note: ' + n).join('')).join('\n') : '';
        if (errors.length) out += (out ? '\n' : '') + errors.join('\n');
        if (all.length) out += '\nUse them with require(\'<name>\') in files run by `node`. These are CDN builds (browser/UMD where the package has one), not a full npm install: no install scripts, no native addons.';
        return done(out, errors.length ? 1 : 0, st.written.slice(0, 20));
      }
      return done('npm: unsupported command', 1);
    }

    return { git, npm, curl, gitChanges: async () => { const g = await gitLoad(); return g ? gitChanges(g) : null; }, gitBadges, gitBaseText, adoptClone, adoptPush, gitForget, hasRepo: async () => !!(await gitLoad()) };
  }

  return { create };
});
