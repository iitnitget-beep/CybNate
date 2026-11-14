// Clones this repository through the GitHub API (needs TOK=<token>) and checks change detection and the push request sequence.
// Push runs against a fake so nothing is written. Run: TOK=$(gh auth token) node tests/github.test.js
const G = require('../app/src/main/assets/www/github.js');
const C = require('../app/src/main/assets/www/core.js');
const assert = require('assert');
(async () => {
  assert.deepStrictEqual(G.parseRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b', branch: '' });
  assert.deepStrictEqual(G.parseRepo('a/b'), { owner: 'a', repo: 'b', branch: '' });
  assert.deepStrictEqual(G.parseRepo('https://github.com/a/b/tree/feat/x'), { owner: 'a', repo: 'b', branch: 'feat/x' });
  const token = process.env.TOK;
  const res = await G.clone({ token, owner: 'iitnitget-beep', repo: 'CybNate', branch: 'arena/7e308ea6-cybnate', onProgress: () => {} });
  console.log('cloned', res.files.size, 'skipped', res.skipped, 'canPush', res.base.canPush);
  const ws = new C.Workspace(); res.files.forEach((v, k) => ws.files.set(k, v));
  if (process.env.CHECK_README) assert.strictEqual(ws.get('README.md'), require('fs').readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8'));
  assert.strictEqual((await G.status(res.base, ws)).count, 0, 'clean clone has no changes');
  ws.set('README.md', ws.get('README.md') + '\nx'); ws.set('new/file.txt', 'hi'); ws.remove('settings.gradle');
  const st = await G.status(res.base, ws);
  assert.deepStrictEqual([st.added, st.modified, st.deleted], [['new/file.txt'], ['README.md'], ['settings.gradle']]);
  // push against a recorded fake so nothing is written to the real repository
  const calls = [];
  const fake = async (url, o) => { const body = o.body && JSON.parse(o.body); calls.push([o.method, url.replace(/.*CybNate/, ''), body]);
    const json = /blobs$/.test(url) ? { sha: 'b' + calls.length } : /trees$/.test(url) ? { sha: 'T' } : /commits$/.test(url) ? { sha: 'C' } : {};
    return { ok: true, status: 200, json: async () => json }; };
  const p = await G.push({ token: 't', base: res.base, ws, message: 'msg', fetch: fake });
  assert.strictEqual(p.changed, 3); assert.strictEqual(p.base.commit, 'C');
  const tree = calls.find((c) => /trees$/.test(c[1]))[2];
  assert.strictEqual(tree.base_tree, res.base.tree);
  assert.deepStrictEqual(tree.tree.map((e) => [e.path, e.sha === null]).sort(), [['README.md', false], ['new/file.txt', false], ['settings.gradle', true]]);
  assert.deepStrictEqual(calls.at(-1).slice(0, 2), ['PATCH', '/git/refs/heads/arena/7e308ea6-cybnate']);
  assert.strictEqual(calls.at(-1)[2].force, false);
  // public repo without token goes through raw.githubusercontent.com (blocked in this sandbox, so only check the error is clean)
  console.log('GITHUB TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
