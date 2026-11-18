/* CybNate safety: permission modes, approval rules, read-only command list, untrusted-data wrapper, checkpoints.
 * No DOM access so it can be unit-tested under Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Safety = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MODES = ['ask', 'autoedit', 'auto'];
  const RO_PROGS = ['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'stat', 'file', 'du', 'df', 'date', 'whoami', 'uname', 'id', 'tree', 'grep', 'diff',
    'md5sum', 'sha1sum', 'sha256sum', 'which', 'basename', 'dirname'];
  const RO_GIT = ['status', 'diff', 'log', 'show'];

  /** True when the command uses shell operators: pipes, redirects, chaining, substitution, variables, line breaks. */
  function hasShellMeta(cmd) { return /[|&;<>`$\\\n\r(){}]/.test(String(cmd || '')); }

  /** Plainly read-only commands run without approval. A command with any shell operator never counts. */
  function isReadOnlyCommand(cmd) {
    cmd = String(cmd || '').trim();
    if (!cmd || hasShellMeta(cmd)) return false;
    const a = cmd.split(/\s+/), prog = a[0];
    // Audit rules (Phase 1 follow-up):
    //  - no absolute, home or parent paths: the app's own data folder holds API keys and secrets
    //  - no option that writes a file, follows a file forever, or makes the tool start another program
    if (a.slice(1).some((x) => /(^|=|["'])(\/|~)/.test(x) || /\.\./.test(x))) return false;
    const opt = (re) => a.slice(1).some((x) => re.test(x));
    if (prog === 'git') return RO_GIT.indexOf(a[1]) >= 0 && !opt(/^(--output|-o$|--ext-diff|--textconv|--no-index|--exec|-c$|-C$|--git-dir|--work-tree)/);
    if (prog === 'date') return a.slice(1).every((x) => /^(\+[\w%:.\-\/]*|-u|-R|-I\w*|--utc|--iso-8601(=\w+)?|--rfc-\w+(=\w+)?)$/.test(x));
    if (prog === 'tree' && opt(/^(-o|--output)/)) return false;
    if (prog === 'file' && opt(/^(-C|--compile|-m|--magic-file)/)) return false;
    if (prog === 'tail' && opt(/^(-[a-zA-Z0-9]*[fF]|--follow|--retry|--pid)/)) return false;
    if ((prog === 'python' || prog === 'python3' || prog === 'node') && a.length === 2 && /^(--version|-V|-v)$/.test(a[1])) return true;
    return RO_PROGS.indexOf(prog) >= 0;
  }

  function normPath(p) {
    const parts = [];
    String(p || '').replace(/\\/g, '/').split('/').forEach((s) => { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); });
    return parts.join('/');
  }
  /** Files whose change is asked about even in Auto mode: CI, licence notices, settings and secrets. */
  function isSensitivePath(p) {
    p = normPath(p).toLowerCase();
    const base = p.split('/').pop();
    if (p === '.github' || p.indexOf('.github/') === 0 || p.indexOf('/.github/') >= 0) return true;
    // git settings and hooks can make a later "read-only" git command start another program
    if (p === '.git' || p.indexOf('.git/') === 0 || p.indexOf('/.git/') >= 0 || base === '.gitconfig' || base === '.gitattributes') return true;
    if (/^(notice|license|licence|copying)(\.[a-z]+)?$/.test(base)) return true;
    if (/^\.env(\..*)?$/.test(base) || /\.(jks|keystore|pem|key|p12|pfx)$/.test(base)) return true;
    if (/^(secrets?|credentials?|settings|local)\.(json|ya?ml|toml|properties|xml|ini)$/.test(base)) return true;
    if (/^(\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|google-services\.json)$/.test(base)) return true;
    return false;
  }
  /** A command that names a sensitive file is asked about even in Auto mode. */
  function commandTouchesSensitive(cmd) {
    cmd = String(cmd || '');
    // the app's private data (WebView storage) holds API keys and secrets
    if (/app_webview|shared_prefs|\/data\/(data|user)\//.test(cmd)) return true;
    return cmd.split(/[\s"'=:,;|&<>()]+/).some((w) => w && isSensitivePath(w));
  }

  /**
   * Decide whether a tool call needs the user's approval.
   * Returns null (run it) or { kind: 'shell' | 'edit' | 'delete', sensitive, always } where `always` says
   * whether "allow always for this chat" may be offered (never for delete or sensitive files).
   */
  function approvalFor(call, mode) {
    mode = MODES.indexOf(mode) >= 0 ? mode : 'ask';
    const a = (call && call.attrs) || {};
    switch (call && call.name) {
      case 'run_terminal_command': {
        const cmd = String(call.body || '');
        const secrets = secretNames(a.secrets);
        const sens = commandTouchesSensitive(cmd);
        if (secrets.length || sens) return { kind: 'shell', sensitive: sens, always: false, secrets, network: sendsData(cmd) };
        // sending data out of the device is asked about in every mode, Auto included
        if (sendsData(cmd)) return { kind: 'shell', sensitive: false, always: false, secrets, network: true };
        if (isReadOnlyCommand(cmd) || mode === 'auto') return null;
        return { kind: 'shell', sensitive: false, always: true, secrets };
      }
      case 'write_file': case 'edit_file': case 'zip_extract': {
        // zip_extract writes the extracted entry into the workspace, so it counts as a file write
        const sens = isSensitivePath(call.name === 'zip_extract' ? (a.dest || a.entry) : a.path);
        if (sens) return { kind: 'edit', sensitive: true, always: false };
        return mode === 'ask' ? { kind: 'edit', sensitive: false, always: false } : null;
      }
      case 'delete_file': {
        const sens = isSensitivePath(a.path);
        if (sens || mode !== 'auto') return { kind: 'delete', sensitive: sens, always: false };
        return null;
      }
      default: return null;
    }
  }
  /** True for a command that uploads something: curl/wget with a body, a form, a file or a writing method, and git push. */
  function sendsData(cmd) {
    cmd = String(cmd || '');
    if (/(^|[\s;&|(])git\s+push\b/.test(cmd)) return true;
    if (!/(^|[\s;&|(])(curl|wget)\s/.test(cmd)) return false;
    return /\s(-d|--data(-raw|-binary|-urlencode|-ascii)?|--json|-F|--form|-T|--upload-file|--post-data|--post-file|--body-data|--body-file)(\s|=|$)/.test(cmd)
      || /\s(-X|--request|--method)[\s=]*(POST|PUT|PATCH|DELETE)\b/i.test(cmd);
  }
  function secretNames(v) { return String(v || '').split(/[\s,]+/).filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x)); }

  /** "Allow always for this chat" rules: { exact: cmd } or { prefix: 'npm test' }. A prefix never covers a command with shell operators. */
  function ruleAllows(rules, cmd) {
    cmd = String(cmd || '').trim();
    return (rules || []).some((r) => {
      if (r.exact != null) return r.exact === cmd;
      if (r.prefix) return !hasShellMeta(cmd) && (cmd === r.prefix || cmd.indexOf(r.prefix + ' ') === 0);
      return false;
    });
  }
  /** The prefix offered for a command: its program plus sub-command (e.g. "pip install"), or '' when none is safe. */
  function prefixOf(cmd) {
    cmd = String(cmd || '').trim();
    if (!cmd || hasShellMeta(cmd)) return '';
    const a = cmd.split(/\s+/);
    if (/^(rm|rmdir|mv|dd|chmod|chown|sh|bash|su|sudo|eval|exec|kill|pkill)$/.test(a[0])) return '';
    return a.length > 2 && /^[a-z][\w-]*$/i.test(a[1]) ? a[0] + ' ' + a[1] : a[0];
  }

  /** Small line diff for the approval sheet: common head and tail trimmed, then removed and added lines. */
  function lineDiff(before, after, maxLines) {
    const A = String(before == null ? '' : before).split('\n'), B = String(after == null ? '' : after).split('\n');
    let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
    const out = [];
    for (let i = Math.max(0, s - 2); i < s; i++) out.push('  ' + A[i]);
    for (let i = s; i < A.length - e; i++) out.push('- ' + A[i]);
    for (let i = s; i < B.length - e; i++) out.push('+ ' + B[i]);
    for (let i = A.length - e; i < Math.min(A.length, A.length - e + 2); i++) out.push('  ' + A[i]);
    const max = maxLines || 120;
    return out.length > max ? out.slice(0, max).join('\n') + '\n… ' + (out.length - max) + ' more lines' : out.join('\n');
  }

  /** Wrap a tool result so the model treats it as data. The closing tag cannot be forged from inside. */
  function wrapUntrusted(source, text) {
    const src = String(source || 'tool').replace(/["<>\n\r]/g, ' ').slice(0, 120);
    const body = String(text == null ? '' : text).replace(/<(\/?)\s*untrusted_data/gi, '<$1 untrusted-data');
    return '<untrusted_data source="' + src + '">\n' + body + '\n</untrusted_data>';
  }

  // ---- approval gate
  function deniedError(what) {
    const e = new Error('DENIED by the user: ' + what + ' was not run. Do not retry it or work around it; ask the user what they want instead.');
    e.denied = true; return e;
  }
  const modeOf = (env) => { const m = env && (typeof env.mode === 'function' ? env.mode() : env.mode); return MODES.indexOf(m) >= 0 ? m : 'ask'; };
  const what = (call) => call.name === 'run_terminal_command' ? 'the command' : call.name + ' ' + ((call.attrs || {}).path || '');

  /** Called before every tool runs. Fails closed: with no approval handler, anything that needs approval is refused. */
  async function ensureApproved(call, env, gate, preview) {
    if (env && env.signal && env.signal.aborted) { const e = new Error('Stopped'); e.name = 'AbortError'; e.code = 'cancelled'; throw e; }
    const need = approvalFor(call, modeOf(env));
    if (!need) return;
    if (gate && gate.ok.has(call)) return;
    if (gate && gate.no.has(call)) throw deniedError(what(call));
    if (!env || typeof env.approve !== 'function') throw deniedError(what(call) + ' (no approval screen is available here)');
    let req;
    if (need.kind === 'shell') req = { kind: 'shell', command: String(call.body || ''), secrets: need.secrets, sensitive: need.sensitive, always: need.always, network: !!need.network };
    else if (need.kind === 'delete') req = { kind: 'delete', path: (call.attrs || {}).path || '', sensitive: need.sensitive };
    else req = { kind: 'edits', items: [preview ? preview(call) : { path: (call.attrs || {}).path || '' }] };
    const ans = await env.approve(req);
    if (ans !== 'allow') throw deniedError(what(call));
  }

  /** One sheet for all file edits of a step. Fills gate.ok / gate.no for every edit call that needs approval. */
  async function approveEdits(calls, env, gate, previewAll) {
    const mode = modeOf(env);
    const list = calls.filter((c) => { const n = approvalFor(c, mode); return n && n.kind === 'edit'; });
    if (!list.length) return;
    if (!env || typeof env.approve !== 'function') { list.forEach((c) => gate.no.add(c)); return; }
    const ans = await env.approve({ kind: 'edits', items: previewAll(list) });
    list.forEach((c) => (ans === 'allow' ? gate.ok : gate.no).add(c));
  }

  // ---- checkpoints
  const sizeOf = (v) => (v == null ? 0 : v instanceof Uint8Array ? v.length : String(v).length);
  /** Remember every file (by reference, no copy). Files past the size limits are listed in `skipped` and left alone on restore. */
  function makeCheckpoint(ws, maxTotal, maxFile) {
    maxTotal = maxTotal || 40 * 1048576; maxFile = maxFile || 5 * 1048576;
    const cp = { files: new Map(), skipped: [], skippedSize: {}, bytes: 0, time: Date.now() };
    ws.list().forEach((p) => {
      const v = ws.get(p), n = sizeOf(v);
      if (n > maxFile || cp.bytes + n > maxTotal) { cp.skipped.push(p); cp.skippedSize[p] = n; return; }
      cp.files.set(p, v); cp.bytes += n;
    });
    return cp;
  }
  /** Paths that differ from the checkpoint: changed, deleted or newly created. */
  function changedSince(ws, cp) {
    const out = [];
    cp.files.forEach((v, p) => { if (!ws.has(p)) out.push(p + ' (deleted)'); else if (ws.get(p) !== v) out.push(p); });
    ws.list().forEach((p) => { if (!cp.files.has(p) && cp.skipped.indexOf(p) < 0) out.push(p + ' (new)'); });
    return out;
  }
  /** Put the workspace back: changed and deleted files return, files created since are removed. */
  function restoreCheckpoint(ws, cp) {
    let restored = 0, removed = 0;
    cp.files.forEach((v, p) => { if (!ws.has(p) || ws.get(p) !== v) { ws.set(p, v); restored++; } });
    ws.list().forEach((p) => { if (!cp.files.has(p) && cp.skipped.indexOf(p) < 0) { ws.remove(p); removed++; } });
    return { restored, removed, skipped: cp.skipped.slice() };
  }

  return { MODES, hasShellMeta, isReadOnlyCommand, isSensitivePath, commandTouchesSensitive, approvalFor, sendsData, secretNames, ruleAllows, prefixOf,
    lineDiff, wrapUntrusted, deniedError, modeOf, ensureApproved, approveEdits, makeCheckpoint, changedSince, restoreCheckpoint };
});
