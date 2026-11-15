'use strict';
/*
 * Durable state: one SQLite file in WAL mode (node:sqlite, no native add-on to install).
 * Secrets and OAuth tokens are encrypted with AES-256-GCM before they are written; the key never enters the database.
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function loadMasterKey(dataDir, fromEnv) {
  if (fromEnv) {
    const raw = /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, 'hex') : Buffer.from(fromEnv, 'base64');
    if (raw.length !== 32) throw new Error('CYB_MASTER_KEY must be 32 bytes, as 64 hex characters or base64');
    return { key: raw, source: 'env' };
  }
  // No key given: make one and keep it beside the data. Good enough for a private server; a key from the environment
  // (kept out of the data volume) is what protects the secrets when the volume itself leaks.
  const file = path.join(dataDir, 'master.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return { key: Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'), source: 'file' };
}

function open(dataDir, masterKeyEnv) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const master = loadMasterKey(dataDir, masterKeyEnv);
  const db = new DatabaseSync(path.join(dataDir, 'cybnate.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, n INTEGER UNIQUE, name TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user TEXT NOT NULL, device TEXT, created INTEGER, seen INTEGER);
    CREATE TABLE IF NOT EXISTS secrets (user TEXT, name TEXT, blob BLOB, updated INTEGER, PRIMARY KEY (user, name));
    CREATE TABLE IF NOT EXISTS oauth (user TEXT, provider TEXT, blob BLOB, updated INTEGER, PRIMARY KEY (user, provider));
    CREATE TABLE IF NOT EXISTS kv (user TEXT, key TEXT, value TEXT, version INTEGER, updated INTEGER, PRIMARY KEY (user, key));
    CREATE TABLE IF NOT EXISTS idem (user TEXT, key TEXT, status INTEGER, body TEXT, created INTEGER, PRIMARY KEY (user, key));
    CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, expires INTEGER);
  `);

  const seal = (text, aad) => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', master.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  };
  const unseal = (blob, aad) => {
    const b = Buffer.from(blob), d = crypto.createDecipheriv('aes-256-gcm', master.key, b.subarray(0, 12));
    d.setAAD(Buffer.from(aad)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  };
  const q = (sql) => db.prepare(sql);
  const st = {
    userNew: q('INSERT INTO users (id, n, name, created) VALUES (?, (SELECT COALESCE(MAX(n), 0) + 1 FROM users), ?, ?)'),
    userGet: q('SELECT * FROM users WHERE id = ?'), userCount: q('SELECT COUNT(*) AS c FROM users'),
    tokNew: q('INSERT INTO tokens (hash, user, device, created, seen) VALUES (?, ?, ?, ?, ?)'),
    tokGet: q('SELECT t.user, u.n, u.name FROM tokens t JOIN users u ON u.id = t.user WHERE t.hash = ?'),
    tokSeen: q('UPDATE tokens SET seen = ? WHERE hash = ?'), tokDel: q('DELETE FROM tokens WHERE hash = ?'),
    secPut: q('INSERT INTO secrets (user, name, blob, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user, name) DO UPDATE SET blob = excluded.blob, updated = excluded.updated'),
    secGet: q('SELECT blob FROM secrets WHERE user = ? AND name = ?'), secList: q('SELECT name, updated FROM secrets WHERE user = ? ORDER BY name'), secDel: q('DELETE FROM secrets WHERE user = ? AND name = ?'),
    oaPut: q('INSERT INTO oauth (user, provider, blob, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user, provider) DO UPDATE SET blob = excluded.blob, updated = excluded.updated'),
    oaGet: q('SELECT blob FROM oauth WHERE user = ? AND provider = ?'), oaDel: q('DELETE FROM oauth WHERE user = ? AND provider = ?'),
    kvGet: q('SELECT value, version, updated FROM kv WHERE user = ? AND key = ?'), kvList: q('SELECT key, version, updated FROM kv WHERE user = ? ORDER BY key'),
    kvIns: q('INSERT INTO kv (user, key, value, version, updated) VALUES (?, ?, ?, 1, ?)'),
    kvUpd: q('UPDATE kv SET value = ?, version = version + 1, updated = ? WHERE user = ? AND key = ? AND version = ?'), kvDel: q('DELETE FROM kv WHERE user = ? AND key = ?'),
    idGet: q('SELECT status, body FROM idem WHERE user = ? AND key = ?'), idPut: q('INSERT OR REPLACE INTO idem (user, key, status, body, created) VALUES (?, ?, ?, ?, ?)'), idGc: q('DELETE FROM idem WHERE created < ?'),
    caGet: q('SELECT value, expires FROM cache WHERE key = ?'), caPut: q('INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)'), caGc: q('DELETE FROM cache WHERE expires < ?'),
  };
  const now = () => Date.now();

  return {
    masterSource: master.source,
    close: () => db.close(),
    // ---- users and device tokens (only the SHA-256 of a token is stored)
    userCount: () => st.userCount.get().c,
    register(name, device) {
      const id = crypto.randomUUID(), token = 'cyb_' + crypto.randomBytes(32).toString('base64url');
      db.exec('BEGIN IMMEDIATE');
      try { st.userNew.run(id, String(name || '').slice(0, 80), now()); st.tokNew.run(sha256(token), id, String(device || '').slice(0, 80), now(), now()); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      return { id, token, n: st.userGet.get(id).n };
    },
    auth(token) { if (!token) return null; const h = sha256(token), r = st.tokGet.get(h); if (!r) return null; st.tokSeen.run(now(), h); return { id: r.user, n: r.n, name: r.name }; },
    logout: (token) => st.tokDel.run(sha256(token)).changes > 0,
    // ---- secrets
    secretPut(user, name, value) { st.secPut.run(user, name, seal(value, 'secret:' + user + ':' + name), now()); },
    secretGet(user, name) { const r = st.secGet.get(user, name); return r ? unseal(r.blob, 'secret:' + user + ':' + name) : null; },
    secretList: (user) => st.secList.all(user).map((r) => ({ name: r.name, updated: r.updated })),
    secretDel: (user, name) => st.secDel.run(user, name).changes > 0,
    // ---- OAuth sessions (tokens encrypted like secrets)
    oauthPut(user, provider, data) { st.oaPut.run(user, provider, seal(JSON.stringify(data), 'oauth:' + user + ':' + provider), now()); },
    oauthGet(user, provider) { const r = st.oaGet.get(user, provider); return r ? JSON.parse(unseal(r.blob, 'oauth:' + user + ':' + provider)) : null; },
    oauthDel: (user, provider) => st.oaDel.run(user, provider).changes > 0,
    // ---- saved app state with versions: a write must name the version it was based on
    kvGet(user, key) { const r = st.kvGet.get(user, key); return r ? { value: JSON.parse(r.value), version: r.version, updated: r.updated } : null; },
    kvList: (user) => st.kvList.all(user),
    /** Returns { ok: true, version } or { ok: false, current } when someone else wrote first. baseVersion 0 means "create". */
    kvPut(user, key, value, baseVersion) {
      const text = JSON.stringify(value);
      db.exec('BEGIN IMMEDIATE');
      try {
        const cur = st.kvGet.get(user, key); let ok = false;
        if (!cur && !baseVersion) { st.kvIns.run(user, key, text, now()); ok = true; }
        else if (cur && cur.version === baseVersion) ok = st.kvUpd.run(text, now(), user, key, baseVersion).changes === 1;
        db.exec('COMMIT');
        const after = st.kvGet.get(user, key);
        return ok ? { ok: true, version: after.version } : { ok: false, current: after ? { value: JSON.parse(after.value), version: after.version } : null };
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    kvDel: (user, key) => st.kvDel.run(user, key).changes > 0,
    // ---- finished requests, so a retry gets the first answer instead of running twice
    idemGet(user, key) { const r = st.idGet.get(user, key); return r ? { status: r.status, body: r.body } : null; },
    idemPut(user, key, status, body) { st.idPut.run(user, key, status, body, now()); },
    // ---- small cache with expiry (model lists and the like)
    cacheGet(key) { const r = st.caGet.get(key); return r && r.expires > now() ? JSON.parse(r.value) : null; },
    cachePut(key, value, ttlMs) { st.caPut.run(key, JSON.stringify(value), now() + ttlMs); },
    gc() { st.idGc.run(now() - 24 * 3600 * 1000); st.caGc.run(now()); },
  };
}

module.exports = { open, sha256 };
