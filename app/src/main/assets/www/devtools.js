/* CybNate developer tools: fuzzy search/replace, unified-diff patching, repo map, diagnostics,
 * and recovery of edits from replies that do not use the tool tags.
 * No DOM access so it can be unit-tested under Node.
 *
 * The designs follow well-known open-source coding agents (see NOTICE):
 *  - layered search/replace matching and SEARCH/REPLACE blocks: Aider (Apache-2.0), Roo Code (Apache-2.0)
 *  - line-numbered views and a check after every edit: SWE-agent (MIT), OpenHands (MIT)
 *  - code definition listing / repo map: Cline (Apache-2.0), Aider (Apache-2.0)
 * The code here is written for CybNate; no source was copied from those projects. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DevTools = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ fuzzy matching
  const indentOf = (l) => /^[ \t]*/.exec(l)[0];
  const blank = (l) => !l.trim();
  function minIndent(lines) {
    let m = null;
    lines.forEach((l) => { if (blank(l)) return; const i = indentOf(l); if (m === null || i.length < m.length) m = i; });
    return m || '';
  }
  /** Similarity of two strings, 0..1 (character bigram overlap; cheap and good enough for lines of code). */
  function similarity(a, b) {
    a = a.trim(); b = b.trim();
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = new Map();
    for (let i = 0; i < a.length - 1; i++) { const g = a.substr(i, 2); grams.set(g, (grams.get(g) || 0) + 1); }
    let hit = 0;
    for (let i = 0; i < b.length - 1; i++) { const g = b.substr(i, 2), n = grams.get(g) || 0; if (n > 0) { grams.set(g, n - 1); hit++; } }
    return (2 * hit) / (a.length + b.length - 2);
  }
  function offsetOfLine(lines, i) { let o = 0; for (let k = 0; k < i; k++) o += lines[k].length + 1; return o; }
  function trimBlankEdges(lines) {
    lines = lines.slice();
    while (lines.length && blank(lines[lines.length - 1])) lines.pop();
    while (lines.length && blank(lines[0])) lines.shift();
    return lines;
  }

  /**
   * Find `search` in `text` with four increasingly tolerant stages:
   *  1 exact, 2 ignoring trailing whitespace, 3 ignoring a uniform indentation shift, 4 line-by-line fuzzy (>= 3 lines, clear best match).
   * @returns {start, end, stage, fileIndent, searchIndent} (character range of whole lines for stages 2-4) or null.
   */
  function fuzzyFind(text, search) {
    if (!search) return null;
    const idx = text.indexOf(search);
    if (idx >= 0) return { start: idx, end: idx + search.length, stage: 1, fileIndent: '', searchIndent: '' };
    const tl = text.split('\n'), sl = trimBlankEdges(search.split('\n'));
    if (!sl.length) return null;
    const range = (i) => { const start = offsetOfLine(tl, i); let end = start; for (let k = 0; k < sl.length; k++) end += tl[i + k].length + 1; return { start, end: Math.min(end - 1, text.length) }; };
    const rt = (l) => l.replace(/\s+$/, '');
    const scan = (same) => { for (let i = 0; i + sl.length <= tl.length; i++) { let ok = true; for (let j = 0; j < sl.length; j++) if (!same(tl[i + j], sl[j], i, j)) { ok = false; break; } if (ok) return i; } return -1; };
    // 2: trailing whitespace
    let at = scan((a, b) => rt(a) === rt(b));
    if (at >= 0) return Object.assign(range(at), { stage: 2, fileIndent: '', searchIndent: '' });
    // 3: the same lines with a uniform indentation shift (or indentation ignored on blank lines)
    const sMin = minIndent(sl), sRel = sl.map((l) => (blank(l) ? '' : rt(l.slice(sMin.length))));
    for (let i = 0; i + sl.length <= tl.length; i++) {
      const win = tl.slice(i, i + sl.length), wMin = minIndent(win);
      let ok = true;
      for (let j = 0; j < sl.length; j++) { const w = blank(win[j]) ? '' : rt(win[j].slice(wMin.length)); if (w !== sRel[j]) { ok = false; break; } }
      if (ok) return Object.assign(range(i), { stage: 3, fileIndent: wMin, searchIndent: sMin });
    }
    // 4: fuzzy, only for blocks with enough context and one clearly best place
    if (sl.length >= 3) {
      let best = -1, bestScore = 0, second = 0;
      for (let i = 0; i + sl.length <= tl.length; i++) {
        let sum = 0, exact = 0;
        for (let j = 0; j < sl.length; j++) { const s = similarity(tl[i + j], sl[j]); sum += s; if (s === 1) exact++; }
        const score = sum / sl.length;
        if (exact < Math.ceil(sl.length / 2)) continue; // at least half of the lines must be identical
        if (score > bestScore) { second = bestScore; bestScore = score; best = i; } else if (score > second) second = score;
      }
      if (best >= 0 && bestScore >= 0.85 && bestScore - second >= 0.05) {
        const win = tl.slice(best, best + sl.length);
        return Object.assign(range(best), { stage: 4, fileIndent: minIndent(win), searchIndent: sMin });
      }
    }
    return null;
  }
  /** Shift the indentation of a replacement the same way the matched block differs from the search text. */
  function reindent(replace, from, to) {
    if (from === to) return replace;
    return replace.split('\n').map((l) => (blank(l) ? l : (l.indexOf(from) === 0 ? to + l.slice(from.length) : to + l.replace(/^[ \t]+/, '')))).join('\n');
  }
  /** Replace the first place `search` matches. @returns {text, stage} or null when nothing matches. */
  function fuzzyReplace(text, search, replace) {
    const m = fuzzyFind(text, search);
    if (!m) return null;
    let rep = replace;
    if (m.stage === 1) {
      // a snippet indented less than the file can match mid-indentation: take the rest of that indentation too
      const ls = text.lastIndexOf('\n', m.start - 1) + 1;
      if (ls < m.start && /^\s/.test(search) && /^[ \t]+$/.test(text.slice(ls, m.start))) m.start = ls;
    } else {
      rep = trimBlankEdges(replace.split('\n')).join('\n');
      if (m.stage >= 3) {
        // learn how each indentation of the search text looks in the file (tabs vs spaces, another width) and write the replacement the same way
        const lead = (l) => /^[ \t]*/.exec(l)[0];
        const fl = text.slice(m.start, m.end).split('\n'), sl = trimBlankEdges(search.split('\n')), map = new Map();
        for (let j = 0; j < sl.length && j < fl.length; j++) if (!blank(sl[j]) && !blank(fl[j]) && !map.has(lead(sl[j]))) map.set(lead(sl[j]), lead(fl[j]));
        const shifted = reindent(rep, m.searchIndent, m.fileIndent).split('\n');
        rep = rep.split('\n').map((l, j) => (blank(l) ? l : map.has(lead(l)) ? map.get(lead(l)) + l.slice(lead(l).length) : shifted[j])).join('\n');
      }
    }
    return { text: text.slice(0, m.start) + rep + text.slice(m.end), stage: m.stage };
  }
  const STAGE_NAMES = ['', 'exact', 'ignoring trailing whitespace', 'ignoring indentation', 'fuzzy'];
  /** The lines of the file closest to a search block that failed to match, with line numbers. */
  function nearby(text, search, radius) {
    const tl = text.split('\n'), sl = trimBlankEdges(String(search || '').split('\n')).filter((l) => l.trim().length > 2);
    if (!sl.length || !tl.length) return '';
    let best = -1, bestScore = 0.45;
    sl.slice(0, 3).forEach((probe, pi) => {
      tl.forEach((l, i) => { const s = similarity(l, probe); if (s > bestScore) { bestScore = s; best = Math.max(0, i - pi); } });
    });
    if (best < 0) return '';
    radius = radius || 4;
    const from = Math.max(0, best - 2), to = Math.min(tl.length, best + sl.length + radius);
    return numbered(tl.slice(from, to).join('\n'), from + 1);
  }
  /** Prefix each line with its 1-based number: "  12| code". */
  function numbered(text, first) {
    const lines = String(text).split('\n'), w = String((first || 1) + lines.length - 1).length;
    return lines.map((l, i) => String((first || 1) + i).padStart(Math.max(3, w), ' ') + '| ' + l).join('\n');
  }

  // ------------------------------------------------------- search/replace blocks
  const SR_RE = /^[ \t]*<{5,9} ?(?:SEARCH|ORIGINAL)[^\n]*\n([\s\S]*?)\n?^[ \t]*={5,9}[ \t]*\n([\s\S]*?)\n?^[ \t]*>{5,9} ?(?:REPLACE|UPDATED)[^\n]*$/gm;
  /** All "<<<<<<< SEARCH / ======= / >>>>>>> REPLACE" blocks in a text. @returns [{search, replace, index, length}] */
  function parseSearchReplace(text) {
    const out = []; let m; SR_RE.lastIndex = 0;
    while ((m = SR_RE.exec(String(text || '')))) out.push({ search: m[1], replace: m[2], index: m.index, length: m[0].length });
    return out;
  }

  // ---------------------------------------------------------------- unified diff
  const cleanDiffPath = (p) => { p = String(p || '').trim().split('\t')[0].replace(/^["']|["']$/g, ''); return p === '/dev/null' ? null : p.replace(/^[ab]\//, ''); };
  /**
   * Parse a unified diff (one or more files).
   * @returns [{path, isNew, isDelete, hunks: [{oldStart, before: [lines], after: [lines]}]}]
   */
  function parseUnifiedDiff(diff) {
    const lines = String(diff || '').replace(/\r\n/g, '\n').split('\n'), files = [];
    let cur = null, hunk = null;
    const fileFor = (oldP, newP) => { cur = { path: newP || oldP, isNew: oldP === null, isDelete: newP === null, hunks: [] }; files.push(cur); hunk = null; };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^--- /.test(l) && i + 1 < lines.length && /^\+\+\+ /.test(lines[i + 1])) { fileFor(cleanDiffPath(l.slice(4)), cleanDiffPath(lines[i + 1].slice(4))); i++; continue; }
      const h = /^@@+ *(?:-(\d+)(?:,\d+)?)? *(?:\+(\d+)(?:,\d+)?)? *@@+/.exec(l);
      if (h) { if (!cur) fileFor('', ''); hunk = { oldStart: h[1] ? parseInt(h[1], 10) : 0, before: [], after: [] }; cur.hunks.push(hunk); continue; }
      if (!hunk) continue;
      if (/^(diff --git|index [0-9a-f]+\.\.|new file mode|deleted file mode|similarity index|rename (from|to))/.test(l)) { hunk = null; continue; }
      if (l === '\\ No newline at end of file') continue;
      const c = l[0], rest = l.slice(1);
      if (c === '+') hunk.after.push(rest);
      else if (c === '-') hunk.before.push(rest);
      else if (c === ' ' || l === '') { hunk.before.push(rest); hunk.after.push(rest); }
      else hunk = null; // text after the diff
    }
    files.forEach((f) => f.hunks.forEach((hk) => {
      // a trailing empty context line usually comes from the text after the diff, not from the file
      while (hk.before.length && hk.after.length && hk.before[hk.before.length - 1] === '' && hk.after[hk.after.length - 1] === '') { hk.before.pop(); hk.after.pop(); }
    }));
    return files.filter((f) => f.hunks.length);
  }
  /**
   * Apply hunks to a text. Each hunk is located by its content (fuzzy), not by its line numbers, which models often get wrong.
   * @returns {text, applied, failed: [{hunk, reason, near}], stages: [n]}
   */
  function applyHunks(text, hunks) {
    let out = text == null ? '' : String(text), applied = 0; const failed = [], stages = [];
    hunks.forEach((hk, i) => {
      const before = hk.before.join('\n'), after = hk.after.join('\n');
      if (!hk.before.length || !before.trim()) {
        // pure addition: at the given line, or at the end
        const tl = out.split('\n');
        if (!out) out = after;
        else if (hk.oldStart > 0 && hk.oldStart <= tl.length) { tl.splice(hk.oldStart - (hk.before.length ? 0 : 0), 0, ...hk.after.slice(0, hk.after.length - hk.before.length || hk.after.length)); out = tl.join('\n'); }
        else out = out.replace(/\n?$/, '\n') + after + '\n';
        applied++; stages.push(1); return;
      }
      const r = fuzzyReplace(out, before, after);
      if (r) { out = r.text; applied++; stages.push(r.stage); }
      else failed.push({ hunk: i + 1, reason: 'context not found', near: nearby(out, before) });
    });
    return { text: out, applied, failed, stages };
  }

  // -------------------------------------------- edits written without tool tags
  const PATH_RE = /^[\w.@~+-][\w.@~+\/-]*\.[A-Za-z0-9_+-]{1,10}$|^(?:Dockerfile|Makefile|Procfile|\.gitignore|\.env\.example)$/;
  const cleanPath = (s) => String(s || '').trim().replace(/^[`*_"'#\s>-]+|[`*_"':\s]+$/g, '').replace(/^(?:file(?:name)?|path)\s*[:=]\s*/i, '').replace(/^[`*"']+|[`*"']+$/g, '').replace(/^\.\//, '');
  const looksLikePath = (s) => !!s && s.length < 160 && !/\s/.test(s) && !/^https?:/i.test(s) && PATH_RE.test(s.split('/').pop()) && (PATH_RE.test(s) || /\//.test(s));
  const ELISION = /^\s*(?:\/\/|#|\/\*|<!--|\.\.\.)?\s*(?:\.\.\.|…)\s*(?:rest of|existing|remaining|other|unchanged|previous|same as|keep|your)\b|^\s*(?:\/\/|#|\/\*|<!--)\s*(?:rest of (?:the )?(?:code|file)|existing code|unchanged|\.\.\.\s*$)/im;
  /** A filename from the text just above a block: a bare path line, **path**, `path`, "### path", "File: path". */
  function pathAbove(text, index) {
    const head = text.slice(Math.max(0, index - 300), index).replace(/\s+$/, '');
    const last = head.split('\n').pop() || '';
    const p = cleanPath(last);
    return looksLikePath(p) ? p : '';
  }
  /**
   * Recover file edits from a reply that used no tool tags (free models often answer in Aider or Markdown style):
   *  a) "<<<<<<< SEARCH / ======= / >>>>>>> REPLACE" blocks under a file name  -> edit_file (or write_file when SEARCH is empty)
   *  b) unified diffs ("--- a/x", "+++ b/x", "@@")                              -> edit_file carrying the diff
   *  c) fenced code blocks that name their file (```py main.py, "# filename: main.py", or a path line above) -> write_file
   * A fenced block with an elision marker ("... rest of the code") is never turned into a whole-file write.
   * @returns calls in the same shape parseToolCalls produces, each with `recovered: true`.
   */
  function looseCalls(text) {
    text = String(text || '');
    const calls = [], taken = [];
    const free = (i, n) => !taken.some((t) => i < t[1] && i + n > t[0]);
    const take = (i, n) => taken.push([i, i + n]);
    // a) search/replace blocks; the path is on a line above the block (possibly above an opening fence)
    const sr = parseSearchReplace(text); let lastPath = '';
    sr.forEach((b) => {
      let head = text.slice(0, b.index).replace(/\s+$/, '');
      head = head.replace(/```[\w.+-]*$/, '').replace(/\s+$/, '');
      const p = cleanPath(head.split('\n').pop() || '');
      const path = looksLikePath(p) ? p : lastPath;
      if (!path) return;
      lastPath = path; take(b.index, b.length);
      const prev = calls[calls.length - 1];
      if (!b.search.trim()) calls.push({ name: 'write_file', attrs: { path }, body: b.replace, index: b.index, length: b.length, recovered: true });
      else if (prev && prev.name === 'edit_file' && prev.attrs.path === path && prev.edits) { prev.edits.push({ search: b.search, replace: b.replace }); prev.length = b.index + b.length - prev.index; }
      else calls.push({ name: 'edit_file', attrs: { path }, edits: [{ search: b.search, replace: b.replace }], index: b.index, length: b.length, recovered: true });
    });
    // fenced blocks
    const fence = /^([ \t]*)(```+|~~~+)([^\n]*)\n([\s\S]*?)\n\1\2[ \t]*$/gm; let m;
    while ((m = fence.exec(text))) {
      if (!free(m.index, m[0].length)) continue;
      const info = m[3].trim(), body = m[4];
      // b) a diff inside a fence
      if (/^(diff|patch|udiff)\b/i.test(info) || (/^--- /m.test(body) && /^\+\+\+ /m.test(body) && /^@@/m.test(body))) {
        parseUnifiedDiff(body).forEach((f) => { if (f.path && looksLikePath(f.path)) calls.push({ name: f.isDelete ? 'delete_file' : 'edit_file', attrs: { path: f.path }, diff: f, index: m.index, length: m[0].length, recovered: true }); });
        take(m.index, m[0].length); continue;
      }
      // c) a named fence
      const parts = info.split(/\s+/).filter(Boolean);
      let path = '', content = body;
      const infoPath = parts.map((x) => cleanPath(x.replace(/^(?:title|file(?:name)?|path)=/i, ''))).find((x, i) => looksLikePath(x) && (i > 0 || /[\/.]/.test(x)));
      if (infoPath && !(parts.length === 1 && /^[a-z0-9+#-]+$/i.test(parts[0]))) path = infoPath;
      if (!path) {
        const first = /^[ \t]*(?:\/\/|#|--|;|\/\*|<!--)\s*(?:file(?:name)?|path)\s*[:=]\s*([^\s*>]+)\s*(?:\*\/|-->)?[ \t]*\n/i.exec(body);
        if (first && looksLikePath(cleanPath(first[1]))) { path = cleanPath(first[1]); content = body.slice(first[0].length); }
      }
      if (!path) path = pathAbove(text, m.index);
      if (!path || /^(text|output|console|log|bash|sh|shell|zsh|terminal|plaintext|stdout)$/i.test(parts[0] || '')) continue;
      if (ELISION.test(content)) continue;
      calls.push({ name: 'write_file', attrs: { path }, body: content, index: m.index, length: m[0].length, recovered: true });
      take(m.index, m[0].length);
    }
    // b) a diff outside any fence
    if (/^--- \S/m.test(text) && /^\+\+\+ \S/m.test(text) && /^@@/m.test(text)) {
      const start = text.search(/^--- \S/m);
      if (free(start, 1)) parseUnifiedDiff(text.slice(start)).forEach((f) => { if (f.path && looksLikePath(f.path)) calls.push({ name: f.isDelete ? 'delete_file' : 'edit_file', attrs: { path: f.path }, diff: f, index: start, length: text.length - start, recovered: true }); });
    }
    return calls.sort((x, y) => x.index - y.index);
  }

  // ------------------------------------------------------------------- repo map
  const LANG = { py: 'py', pyw: 'py', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', java: 'java', kt: 'java', kts: 'java', cs: 'java', c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', go: 'go', rs: 'rs', html: 'html', htm: 'html', vue: 'html', svelte: 'html', css: 'css', scss: 'css', less: 'css', rb: 'rb', php: 'php', sh: 'sh', bash: 'sh', sql: 'sql' };
  const extOf = (p) => { const m = /\.([A-Za-z0-9_]+)$/.exec(String(p || '')); return m ? m[1].toLowerCase() : ''; };
  const RULES = {
    py: [[/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)/, (m) => [m[1] ? 'method' : 'def', m[2] + '(' + m[3].trim().slice(0, 60) + ')']], [/^(\s*)class\s+([A-Za-z_]\w*)/, (m) => ['class', m[2]]],
      [/^\s*@(?:\w+\.)?(?:route|get|post|put|delete|patch)\(\s*["']([^"']+)/, (m) => ['route', m[1]]]],
    js: [[/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)/, (m) => ['function', m[1] + '(' + m[2].trim().slice(0, 60) + ')']],
      [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, (m) => ['class', m[1]]],
      [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, (m) => ['type', m[1]]],
      [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, (m) => ['function', m[1]]],
      [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/, (m) => ['function', m[1]]],
      [/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, (m) => ['export', m[1]]],
      [/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/, (m) => ['export', m[1]]],
      [/^\s*(?:app|router|server|api)\.(get|post|put|delete|patch|use|all)\(\s*["'`]([^"'`]+)/, (m) => ['route', m[1].toUpperCase() + ' ' + m[2]]],
      [/^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{\s*$/, (m) => (/^(if|for|while|switch|catch|function|return|else|do|try)$/.test(m[1]) ? null : ['method', m[1] + '()'])]],
    java: [[/^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|open|data)\s+)*(class|interface|enum|object|record)\s+([A-Za-z_]\w*)/, (m) => [m[1], m[2]]],
      [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|suspend|open)\s+)+(?:<[^>]+>\s*)?(?:[\w.<>\[\],?]+\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)?\s*(?:throws [\w., ]+)?\s*\{?\s*$/, (m) => (/^(if|for|while|switch|catch|return|new)$/.test(m[1]) ? null : ['method', m[1] + '()'])],
      [/^\s*(?:(?:public|private|protected|internal|override|suspend|open)\s+)*fun\s+(?:<[^>]+>\s*)?([A-Za-z_][\w.]*)\s*\(/, (m) => ['fun', m[1] + '()']]],
    c: [[/^\s*(?:typedef\s+)?(struct|class|enum|union|namespace)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/, (m) => [m[1], m[2]]],
      [/^(?:[A-Za-z_][\w:<>,*&\s]*?[\s*&])([A-Za-z_~][\w:~]*)\s*\(([^;{]*)\)\s*(?:const\s*)?(?:\{|$)/, (m) => (/^(if|for|while|switch|return|else|sizeof)$/.test(m[1]) ? null : ['function', m[1] + '()'])],
      [/^\s*#define\s+([A-Za-z_]\w*)\(/, (m) => ['macro', m[1]]]],
    go: [[/^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*\(/, (m) => [m[1] ? 'method' : 'func', (m[1] ? '(' + m[1].trim().split(/\s+/).pop() + ') ' : '') + m[2] + '()']], [/^type\s+([A-Za-z_]\w*)\s+(struct|interface)/, (m) => [m[2], m[1]]]],
    rs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, (m) => ['fn', m[1] + '()']], [/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod|type)\s+([A-Za-z_]\w*)/, (m) => [m[1], m[2]]], [/^\s*impl(?:<[^>]*>)?\s+(.+?)\s*\{/, (m) => ['impl', m[1].slice(0, 60)]]],
    html: [[/<([a-z][\w-]*)\b[^>]*\bid=["']([^"']+)["']/i, (m) => ['#' + m[2], '<' + m[1].toLowerCase() + '>']], [/<(script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/i, (m) => [m[1].toLowerCase(), m[2]]], [/<title>([^<]*)<\/title>/i, (m) => ['title', m[1].trim()]],
      [/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, (m) => ['function', m[1] + '()']]],
    css: [[/^\s*([.#@:\w][^{};]{0,80}?)\s*\{\s*$/, (m) => ['rule', m[1].trim()]]],
    rb: [[/^\s*def\s+([\w.?!=]+)/, (m) => ['def', m[1]]], [/^\s*(class|module)\s+([A-Z][\w:]*)/, (m) => [m[1], m[2]]]],
    php: [[/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/, (m) => ['function', m[1] + '()']], [/^\s*(?:abstract\s+|final\s+)?(class|interface|trait)\s+([A-Za-z_]\w*)/, (m) => [m[1], m[2]]]],
    sh: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, (m) => ['function', m[1] + '()']]],
    sql: [[/^\s*create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(table|view|index|trigger|function|procedure)\s+(?:if\s+not\s+exists\s+)?["`\[]?([\w.]+)/i, (m) => [m[1].toLowerCase(), m[2]]]],
  };
  /** Classes, functions, methods, routes and exports of one file. @returns [{line, kind, name}] */
  function definitions(path, text) {
    const rules = RULES[LANG[extOf(path)]];
    if (!rules || typeof text !== 'string') return [];
    const out = [], lines = text.split('\n');
    for (let i = 0; i < lines.length && out.length < 400; i++) {
      const l = lines[i];
      if (l.length > 400) continue;
      for (const r of rules) { const m = r[0].exec(l); if (m) { const d = r[1](m); if (d) { out.push({ line: i + 1, kind: d[0], name: d[1] }); break; } } }
    }
    return out;
  }
  /**
   * Compact structural outline of a workspace for the system prompt.
   * @param files [{path, text}] (text only)  @param maxChars total budget
   */
  function repoMap(files, maxChars) {
    maxChars = maxChars || 2500;
    const parts = []; let used = 0, skipped = 0;
    const ranked = files.filter((f) => typeof f.text === 'string' && LANG[extOf(f.path)] && !/(^|\/)(node_modules|vendor|dist|build|\.git)\//.test(f.path) && !/\.min\.\w+$/.test(f.path) && f.text.length < 400000)
      .map((f) => ({ path: f.path, defs: definitions(f.path, f.text).filter((d) => d.kind !== 'rule' && d.kind[0] !== '#' && d.kind !== 'script' && d.kind !== 'link') }))
      .filter((f) => f.defs.length);
    for (const f of ranked) {
      const per = Math.max(4, Math.min(14, Math.floor(40 / Math.max(1, ranked.length / 4))));
      const names = f.defs.slice(0, per).map((d) => d.name + ':' + d.line);
      const line = f.path + ': ' + names.join(', ') + (f.defs.length > per ? ', … +' + (f.defs.length - per) : '');
      if (used + line.length > maxChars) { skipped++; continue; }
      parts.push(line); used += line.length + 1;
    }
    if (skipped) parts.push('… ' + skipped + ' more files (use list_code_definition_names)');
    return parts.join('\n');
  }

  // ---------------------------------------------------------------- diagnostics
  /** Unbalanced brackets, aware of strings and comments. `lang`: 'js' | 'py' | 'css' | 'c'. @returns [messages] */
  function bracketErrors(text, lang) {
    const open = { '(': ')', '[': ']', '{': '}' }, close = { ')': '(', ']': '[', '}': '{' };
    const stack = [], errs = [];
    let line = 1, i = 0;
    const n = text.length, py = lang === 'py';
    while (i < n && errs.length < 3) {
      const c = text[i], d = text[i + 1];
      if (c === '\n') { line++; i++; continue; }
      if (py && c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
      if (!py && c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      if (!py && c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; for (let k = i; k < end; k++) if (text[k] === '\n') line++; i = end; continue; }
      if (c === '"' || c === "'" || (!py && c === '`')) {
        const triple = py && text.substr(i, 3) === c + c + c, q = triple ? c + c + c : c, start = line;
        i += q.length;
        let closed = false;
        while (i < n) {
          if (text[i] === '\\') { if (text[i + 1] === '\n') line++; i += 2; continue; }
          if (text.substr(i, q.length) === q) { i += q.length; closed = true; break; }
          if (text[i] === '\n') { if (!triple && c !== '`') break; line++; }
          i++;
        }
        if (!closed && (triple || c === '`')) errs.push('line ' + start + ': unterminated ' + (triple ? 'triple-quoted string' : 'template string'));
        continue;
      }
      if (open[c]) stack.push([c, line]);
      else if (close[c]) {
        const top = stack.pop();
        if (!top) errs.push('line ' + line + ': unexpected "' + c + '"');
        else if (top[0] !== close[c]) errs.push('line ' + line + ': "' + c + '" closes "' + top[0] + '" opened on line ' + top[1]);
      }
      i++;
    }
    if (!errs.length && stack.length) { const t = stack[stack.length - 1]; errs.push('line ' + t[1] + ': "' + t[0] + '" is never closed'); }
    return errs;
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  /** Syntax-check JavaScript by compiling it (never runs it). Module syntax is neutralised first. */
  function jsSyntaxError(code, isModule) {
    let src = code.replace(/^#!.*/, '');
    if (isModule || /^\s*(import\s[\s\S]*?from\s|import\s*["']|export\s)/m.test(src)) {
      src = src.replace(/^(\s*)import\s+(?:[\w*${}\s,]+\s+from\s+)?["'][^"']+["'];?/gm, '$1;')
        .replace(/^(\s*)import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/gm, '$1;')
        .replace(/^(\s*)export\s+default\s+(?=(async\s+)?function|class)/gm, '$1').replace(/^(\s*)export\s+default\s+/gm, '$1void ')
        .replace(/^(\s*)export\s+\{[^}]*\}(?:\s*from\s*["'][^"']+["'])?;?/gm, '$1;').replace(/^(\s*)export\s+\*\s+(?:as\s+\w+\s+)?from\s*["'][^"']+["'];?/gm, '$1;')
        .replace(/^(\s*)export\s+(?=(const|let|var|async|function|class)\b)/gm, '$1').replace(/\bimport\.meta\b/g, '({})');
    }
    try { new AsyncFunction(src); return ''; } catch (e) { return e instanceof SyntaxError ? e.message : ''; }
  }
  function pyErrors(path, text, has) {
    const errs = bracketErrors(text, 'py');
    const lines = text.split('\n'); let sawTab = false, sawSpace = false;
    let depth = 0, inTriple = '';
    for (let i = 0; i < lines.length && errs.length < 4; i++) {
      const l = lines[i], code = l.replace(/#.*$/, '').replace(/\s+$/, '');
      // skip the inside of triple-quoted strings and bracketed continuations
      const tq = (l.match(/"""|'''/g) || []);
      if (inTriple) { if (tq.indexOf(inTriple) >= 0) inTriple = ''; continue; }
      if (tq.length % 2 === 1) { inTriple = tq[tq.length - 1]; continue; }
      const wasInside = depth > 0;
      for (const ch of code.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""')) { if ('([{'.indexOf(ch) >= 0) depth++; else if (')]}'.indexOf(ch) >= 0) depth = Math.max(0, depth - 1); }
      if (wasInside || !code.trim()) continue;
      const ind = indentOf(l);
      if (/\t/.test(ind)) sawTab = true; if (/ /.test(ind)) sawSpace = true;
      if (/ \t|\t /.test(ind)) errs.push('line ' + (i + 1) + ': tabs and spaces mixed in indentation');
      if (depth === 0 && /^\s*(def|class|if|elif|else|for|while|try|except|finally|with|async\s+def|async\s+for|async\s+with)\b.*:\s*$/.test(code)) {
        let j = i + 1; while (j < lines.length && !lines[j].replace(/#.*$/, '').trim()) j++;
        if (j >= lines.length || indentOf(lines[j]).length <= ind.length) errs.push('line ' + (i + 1) + ': expected an indented block after "' + code.trim().slice(0, 40) + '"');
      }
      if (depth === 0 && /^\s*(def|class|if|elif|for|while|with|except)\b[^:]*$/.test(code) && !/\\$/.test(code) && !/^\s*(if|for|while|with)\b.*\b(else|in)\b.*$/.test('') && /^\s*(def|class)\b/.test(code)) errs.push('line ' + (i + 1) + ': missing ":" at the end of "' + code.trim().slice(0, 40) + '"');
      const rel = /^\s*from\s+(\.+)([\w.]*)\s+import\b/.exec(code);
      if (rel && has && rel[2]) {
        let dir = path.split('/').slice(0, -1); for (let k = 1; k < rel[1].length; k++) dir.pop();
        const base = dir.concat(rel[2].split('.')).join('/');
        if (!has(base + '.py') && !has(base + '/__init__.py')) errs.push('line ' + (i + 1) + ': local module "' + rel[1] + rel[2] + '" not found (' + base + '.py)');
      }
    }
    if (sawTab && sawSpace && !errs.some((e) => /mixed/.test(e))) errs.push('some lines are indented with tabs and others with spaces');
    return errs;
  }
  function htmlErrors(path, text, has) {
    const errs = [], lower = text.toLowerCase();
    ['script', 'style'].forEach((tag) => {
      const opens = (lower.match(new RegExp('<' + tag + '\\b[^>]*>', 'g')) || []).filter((t) => !/\/>$/.test(t)).length, closes = (lower.match(new RegExp('</' + tag + '\\s*>', 'g')) || []).length;
      if (opens > closes) errs.push('unclosed <' + tag + '> tag (' + opens + ' opened, ' + closes + ' closed)');
    });
    if (has) {
      const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/') + 1) : '';
      const re = /<(script|link|img|source|audio|video|iframe)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi; let m;
      while ((m = re.exec(text)) && errs.length < 6) {
        const ref = m[3].trim();
        if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{|<%)/i.test(ref) || ref[0] === '/') continue;
        const parts = []; (dir + ref.split(/[?#]/)[0]).split('/').forEach((s) => { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); });
        if (!has(parts.join('/'))) errs.push('<' + m[1].toLowerCase() + ' ' + m[2].toLowerCase() + '="' + ref + '"> points to a file that is not in the workspace');
      }
    }
    const sre = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi; let s;
    while ((s = sre.exec(text)) && errs.length < 6) {
      if (/\bsrc\s*=/.test(s[1]) || !s[2].trim()) continue;
      const type = (/\btype\s*=\s*["']([^"']+)["']/i.exec(s[1]) || [])[1] || '';
      if (type && !/javascript|module|ecmascript/i.test(type)) continue;
      const e = jsSyntaxError(s[2], /module/i.test(type));
      if (e) errs.push('inline <script> near line ' + text.slice(0, s.index).split('\n').length + ': ' + e);
    }
    return errs;
  }
  /**
   * Static check of one file after an edit. Never executes the file.
   * @param has optional (path) => boolean, to verify local references
   * @returns {checked: boolean, errors: [string]}
   */
  function diagnose(path, text, has) {
    const ext = extOf(path);
    if (typeof text !== 'string') return { checked: false, errors: [] };
    if (text.length > 600000) return { checked: false, errors: [] };
    let errors = [];
    try {
      if (ext === 'json' || ext === 'webmanifest') { try { JSON.parse(text); } catch (e) { errors.push(String(e.message).replace(/^JSON\.parse: /, '')); } }
      else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') { const e = jsSyntaxError(text, ext === 'mjs'); if (e) { errors.push(e); bracketErrors(text, 'js').forEach((b) => errors.push(b)); } }
      else if (ext === 'ts' || ext === 'tsx' || ext === 'jsx' || ext === 'java' || ext === 'kt' || ext === 'c' || ext === 'cpp' || ext === 'h' || ext === 'go' || ext === 'rs' || ext === 'css' || ext === 'scss') errors = bracketErrors(text, 'js');
      else if (ext === 'py') errors = pyErrors(path, text, has);
      else if (ext === 'html' || ext === 'htm') errors = htmlErrors(path, text, has);
      else return { checked: false, errors: [] };
    } catch (e) { return { checked: false, errors: [] }; }
    return { checked: true, errors: errors.slice(0, 6) };
  }
  /** The line appended to an edit result. */
  function diagLine(path, text, has) {
    const d = diagnose(path, text, has);
    if (!d.checked) return '';
    return d.errors.length ? '[diagnostics: ERROR in ' + path + ': ' + d.errors.join('; ') + ']' : '[diagnostics: OK]';
  }

  return { fuzzyFind, fuzzyReplace, reindent, nearby, numbered, similarity, STAGE_NAMES, parseSearchReplace, parseUnifiedDiff, applyHunks, looseCalls, looksLikePath,
    definitions, repoMap, extOf, LANG, bracketErrors, jsSyntaxError, diagnose, diagLine };
});
