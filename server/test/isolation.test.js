// Needs root (as in the Docker image): each user gets an own Unix uid, so commands cannot cross over.
// Run: sudo node test/isolation.test.js      (prints SKIPPED when not root)
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const App = require('../src/app');
if (process.getuid() !== 0) { console.log('SKIPPED: not root'); process.exit(0); }
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyb-iso-'));
  const app = App.create({ dataDir, accessKey: 'test-access-key-123456' });
  const BASE = await new Promise((r) => app.server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.server.address().port)));
  const call = async (method, p, body, token) => { const r = await fetch(BASE + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  assert.strictEqual((await call('GET', '/v1/health')).json.isolation, 'uid');
  const A = (await call('POST', '/v1/auth/register', { accessKey: 'test-access-key-123456' })).json, B = (await call('POST', '/v1/auth/register', { accessKey: 'test-access-key-123456' })).json;
  assert.ok(A.token && B.token, 'with uid isolation a second user is accepted without CYB_ALLOW_SHARED');
  await call('PUT', '/v1/secrets/K', { value: 'secret-of-A-1234' }, A.token);
  await call('POST', '/v1/files/sync', { write: [{ path: 'deep/dir/private.txt', text: 'only for A\n' }] }, A.token);
  const run = async (cmd, tok) => (await call('POST', '/v1/exec', { command: cmd }, tok)).json;
  let r = await run('id -u; cat deep/dir/private.txt; echo more >> deep/dir/private.txt; touch deep/dir/mine.txt && echo wrote', A.token);
  assert.ok(/^1000\d\d\n/.test(r.out) && /only for A/.test(r.out) && /wrote/.test(r.out), 'the owner works in files the server wrote: ' + r.out);
  const aWs = path.join(dataDir, 'users', A.userId, 'ws');
  r = await run('id -u; cat ' + aWs + '/deep/dir/private.txt; ls ' + aWs + '; ls ' + path.join(dataDir, 'users', A.userId) + '; echo x > ' + aWs + '/hack.txt; echo done', B.token);
  assert.ok(!/only for A/.test(r.out) && /Permission denied/.test(r.out) && !fs.existsSync(path.join(aWs, 'hack.txt')), 'another user cannot read or write there: ' + r.out);
  r = await run('cat ' + dataDir + '/cybnate.db | head -c 20; cat ' + dataDir + '/master.key; ls ' + dataDir + '; echo done', B.token);
  assert.ok(/Permission denied/.test(r.out) && !/[0-9a-f]{64}/.test(r.out) && !/SQLite/.test(r.out), 'nor the database or the key: ' + r.out);
  r = await run('kill -9 ' + process.pid + ' 2>&1; echo still', B.token); assert.ok(/not permitted|still/.test(r.out)); assert.strictEqual((await call('GET', '/v1/health')).status, 200, 'and cannot kill the server');
  await app.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('ISOLATION TEST PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
