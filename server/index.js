'use strict';
/* Starts the CybNate backend from environment variables. See docs/BACKEND.md. */
const path = require('node:path');
const App = require('./src/app');

const env = process.env;
let lspServers; try { lspServers = env.CYB_LSP_SERVERS ? JSON.parse(env.CYB_LSP_SERVERS) : undefined; } catch (e) { console.error('CYB_LSP_SERVERS is not valid JSON'); process.exit(2); }
let app;
try {
  app = App.create({
    dataDir: path.resolve(env.CYB_DATA_DIR || './data'),
    accessKey: env.CYB_ACCESS_KEY, masterKey: env.CYB_MASTER_KEY, publicUrl: env.CYB_PUBLIC_URL || '',
    allowShared: env.CYB_ALLOW_SHARED === '1', allowPrivate: env.CYB_ALLOW_PRIVATE === '1', trustProxy: env.CYB_TRUST_PROXY === '1',
    maxParallel: parseInt(env.CYB_MAX_PARALLEL, 10) || 4, maxTimeoutSec: parseInt(env.CYB_MAX_TIMEOUT, 10) || 900,
    lspServers, env: { GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET },
    log: (o) => { if (o.level === 'error' || env.CYB_LOG === '1') console.log(JSON.stringify(o)); },
  });
} catch (e) { console.error('Cannot start: ' + e.message); process.exit(2); }

const port = parseInt(env.PORT, 10) || 8787;
app.server.listen(port, env.CYB_HOST || '0.0.0.0', () => {
  console.log('CybNate server ' + App.VERSION + ' on port ' + port + ' · user isolation: ' + app.workspace.isolation() + ' · master key from: ' + app.store.masterSource);
  if (app.workspace.isolation() === 'none') console.log('Not running as root: commands of all users run as the same Unix user, so only one user is accepted (CYB_ALLOW_SHARED=1 lifts that).');
  if (!env.CYB_PUBLIC_URL) console.log('CYB_PUBLIC_URL is not set: Google and GitHub sign-in are off until the public https address of this server is given.');
});
let closing = false;
const stop = () => { if (closing) return; closing = true; app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
