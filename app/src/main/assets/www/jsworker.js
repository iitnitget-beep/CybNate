// Runs a JavaScript file "node style" in a worker: CommonJS require() between workspace files and node_modules,
// console capture, and small versions of fs, path, assert, util, os, events, buffer, url, querystring, crypto, http/https
// backed by a copy of the workspace. It is not Node.js: no sockets, child processes, streams or native addons.
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
  assertMod.notStrictEqual = (a, b, msg) => { if (a === b) throw new Error(msg || 'Expected values to differ: ' + fmt(a)); };
  assertMod.notEqual = (a, b, msg) => { if (a == b) throw new Error(msg || 'Expected values to differ: ' + fmt(a)); };
  assertMod.notDeepStrictEqual = (a, b, msg) => { if (JSON.stringify(a) === JSON.stringify(b)) throw new Error(msg || 'Expected values to differ'); };
  assertMod.match = (str, re, msg) => { if (!re.test(str)) throw new Error(msg || fmt(str) + ' does not match ' + re); };
  assertMod.fail = (msg) => { throw new Error(msg || 'Failed'); };
  assertMod.rejects = async (p, msg) => { let t = false; try { await (typeof p === 'function' ? p() : p); } catch (err) { t = true; } if (!t) throw new Error(msg || 'Missing expected rejection'); };
  assertMod.strict = assertMod;

  // ---- small versions of common Node.js modules (enough for typical scripts and CDN builds of packages)
  class EventEmitter {
    constructor() { this._ev = {}; }
    on(n, f) { (this._ev[n] = this._ev[n] || []).push(f); return this; }
    addListener(n, f) { return this.on(n, f); }
    prependListener(n, f) { (this._ev[n] = this._ev[n] || []).unshift(f); return this; }
    once(n, f) { const g = (...a) => { this.off(n, g); f.apply(this, a); }; g.listener = f; return this.on(n, g); }
    off(n, f) { const l = this._ev[n]; if (l) this._ev[n] = l.filter((x) => x !== f && x.listener !== f); return this; }
    removeListener(n, f) { return this.off(n, f); }
    removeAllListeners(n) { if (n) delete this._ev[n]; else this._ev = {}; return this; }
    emit(n, ...a) { const l = (this._ev[n] || []).slice(); if (!l.length) { if (n === 'error') throw (a[0] instanceof Error ? a[0] : new Error('Unhandled error: ' + fmt(a[0]))); return false; } l.forEach((f) => f.apply(this, a)); return true; }
    listenerCount(n) { return (this._ev[n] || []).length; }
    listeners(n) { return (this._ev[n] || []).map((f) => f.listener || f); }
    eventNames() { return Object.keys(this._ev); }
    setMaxListeners() { return this; }
  }
  EventEmitter.EventEmitter = EventEmitter; EventEmitter.default = EventEmitter;
  EventEmitter.once = (em, n) => new Promise((res, rej) => { em.once(n, (...a) => res(a)); if (n !== 'error') em.once('error', rej); });

  const hex = (u8) => Array.from(u8).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
  const b64enc = (u8) => { let t = ''; for (let i = 0; i < u8.length; i += 0x8000) t += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(t); };
  const b64dec = (str) => { const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '')); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };
  class Buffer extends Uint8Array {
    static from(v, enc) {
      if (typeof v === 'string') {
        if (enc === 'base64' || enc === 'base64url') return Buffer.from(b64dec(v));
        if (enc === 'hex') { const o = new Buffer(v.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(v.substr(i * 2, 2), 16); return o; }
        if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') { const o = new Buffer(v.length); for (let i = 0; i < v.length; i++) o[i] = v.charCodeAt(i) & 255; return o; }
        return Buffer.from(te.encode(v));
      }
      if (v instanceof ArrayBuffer) v = new Uint8Array(v);
      else if (ArrayBuffer.isView(v)) v = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const o = new Buffer(v.length); o.set(v); return o;
    }
    static alloc(n, fill) { const o = new Buffer(n); if (fill) o.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill); return o; }
    static allocUnsafe(n) { return new Buffer(n); }
    static isBuffer(v) { return v instanceof Buffer; }
    static byteLength(v, enc) { return typeof v === 'string' ? Buffer.from(v, enc).length : v.byteLength; }
    static concat(list, total) { if (total == null) total = list.reduce((n, b) => n + b.length, 0); const o = new Buffer(total); let at = 0; list.forEach((b) => { o.set(b.subarray(0, Math.max(0, total - at)), at); at += b.length; }); return o; }
    static isEncoding(e) { return /^(utf-?8|hex|base64(url)?|latin1|binary|ascii)$/i.test(String(e)); }
    toString(enc, a, b) {
      const v = a != null || b != null ? this.subarray(a || 0, b == null ? this.length : b) : this;
      if (enc === 'hex') return hex(v);
      if (enc === 'base64') return b64enc(v);
      if (enc === 'base64url') return b64enc(v).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') { let t = ''; for (let i = 0; i < v.length; i++) t += String.fromCharCode(v[i]); return t; }
      return td.decode(v);
    }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
    equals(o) { if (o.length !== this.length) return false; for (let i = 0; i < o.length; i++) if (o[i] !== this[i]) return false; return true; }
    slice(a, b) { return this.subarray(a, b); }
    write(str, off) { const d = te.encode(str); this.set(d.subarray(0, this.length - (off || 0)), off || 0); return d.length; }
    readUInt8(o) { return this[o]; }
    readUInt16BE(o) { return (this[o] << 8) | this[o + 1]; }
    readUInt16LE(o) { return this[o] | (this[o + 1] << 8); }
    readUInt32BE(o) { return ((this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]) >>> 0; }
    readUInt32LE(o) { return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24)) >>> 0; }
    readInt32LE(o) { return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24); }
    readInt32BE(o) { return (this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]; }
    writeUInt8(v, o) { this[o] = v; return o + 1; }
    writeUInt16BE(v, o) { this[o] = v >>> 8; this[o + 1] = v; return o + 2; }
    writeUInt16LE(v, o) { this[o] = v; this[o + 1] = v >>> 8; return o + 2; }
    writeUInt32BE(v, o) { this[o] = v >>> 24; this[o + 1] = v >>> 16; this[o + 2] = v >>> 8; this[o + 3] = v; return o + 4; }
    writeUInt32LE(v, o) { this[o] = v; this[o + 1] = v >>> 8; this[o + 2] = v >>> 16; this[o + 3] = v >>> 24; return o + 4; }
  }
  // fs returns Buffers, as in Node
  const rawRead = fsMod.readFileSync; fsMod.readFileSync = (p, enc) => { const d = rawRead(p, enc && (enc.encoding || enc)); return typeof d === 'string' ? d : Buffer.from(d); };
  fsMod.promises.readFile = async (p, enc) => fsMod.readFileSync(p, enc);
  fsMod.rmSync = (p, o) => { const q = abs(p); if (q in files) delete files[q]; else if (isDir(q) && o && o.recursive) Object.keys(files).forEach((k) => { if (k.startsWith(q + '/')) delete files[k]; }); else if (!(o && o.force)) throw enoent(p); };
  fsMod.renameSync = (a, b) => { const q = abs(a); if (!(q in files)) throw enoent(a); files[abs(b)] = files[q]; delete files[q]; };
  fsMod.copyFileSync = (a, b) => { const q = abs(a); if (!(q in files)) throw enoent(a); files[abs(b)] = files[q]; };
  fsMod.lstatSync = fsMod.statSync; fsMod.accessSync = (p) => { if (!fsMod.existsSync(p)) throw enoent(p); };
  Object.assign(fsMod.promises, { appendFile: async (p, d) => fsMod.appendFileSync(p, d), unlink: async (p) => fsMod.unlinkSync(p), readdir: async (p) => fsMod.readdirSync(p), stat: async (p) => fsMod.statSync(p), mkdir: async () => {}, rm: async (p, o) => fsMod.rmSync(p, o), access: async (p) => fsMod.accessSync(p), rename: async (a, b) => fsMod.renameSync(a, b) });
  ['readFile', 'writeFile', 'appendFile', 'unlink', 'readdir', 'stat', 'mkdir'].forEach((n) => { fsMod[n] = (...a) => { const cb = a.pop(); fsMod.promises[n](...a).then((v) => cb(null, v), (err) => cb(err)); }; });
  pathMod.isAbsolute = (p) => p[0] === '/'; pathMod.relative = (a, b) => { const x = abs(a).split('/').filter(Boolean), y = abs(b).split('/').filter(Boolean); let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return x.slice(i).map(() => '..').concat(y.slice(i)).join('/'); };
  pathMod.parse = (p) => { const base = p.split('/').pop(), ext = pathMod.extname(p); return { root: p[0] === '/' ? '/' : '', dir: dirOf(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; };
  pathMod.posix = pathMod; pathMod.delimiter = ':';

  // hashes: synchronous, like Node's createHash (WebCrypto is async only)
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  function md5(u8) {
    const K = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const n = u8.length, len = (((n + 8) >> 6) + 1) << 6, d = new Uint8Array(len); d.set(u8); d[n] = 0x80;
    const dv = new DataView(d.buffer); dv.setUint32(len - 8, (n * 8) >>> 0, true); dv.setUint32(len - 4, Math.floor(n / 536870912), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < len; o += 64) {
      let A = a0, B = b0, C2 = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g; const r = i >> 4;
        if (r === 0) { F = (B & C2) | (~B & D); g = i; } else if (r === 1) { F = (D & B) | (~D & C2); g = (5 * i + 1) % 16; } else if (r === 2) { F = B ^ C2 ^ D; g = (3 * i + 5) % 16; } else { F = C2 ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + dv.getUint32(o + g * 4, true)) | 0; A = D; D = C2; C2 = B; B = (B + rotl(F, S[r * 4 + (i % 4)])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C2) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16), ov = new DataView(out.buffer); [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v >>> 0, true)); return out;
  }
  const padBE = (u8) => { const n = u8.length, len = (((n + 8) >> 6) + 1) << 6, d = new Uint8Array(len); d.set(u8); d[n] = 0x80; const dv = new DataView(d.buffer); dv.setUint32(len - 8, Math.floor(n / 536870912)); dv.setUint32(len - 4, (n * 8) >>> 0); return dv; };
  function sha1(u8) {
    const dv = padBE(u8), w = new Uint32Array(80); let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    for (let o = 0; o < dv.byteLength; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let [a, b, c, d, e2] = h;
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d, k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const t = (rotl(a, 5) + f + e2 + k + w[i]) | 0; e2 = d; d = c; c = rotl(b, 30); b = a; a = t;
      }
      h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0, (h[4] + e2) | 0];
    }
    const out = new Uint8Array(20), ov = new DataView(out.buffer); h.forEach((v, i) => ov.setUint32(i * 4, v >>> 0)); return out;
  }
  const K256 = (() => { const k = [], isP = (n) => { for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; }; for (let n = 2; k.length < 64; n++) if (isP(n)) k.push(n); return k; })();
  const frac = (x) => ((x - Math.floor(x)) * 4294967296) >>> 0;
  function sha256(u8) {
    const dv = padBE(u8), w = new Uint32Array(64), K = K256.map((p) => frac(Math.cbrt(p))); let h = K256.slice(0, 8).map((p) => frac(Math.sqrt(p)));
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < dv.byteLength; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
      let [a, b, c, d, e2, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rr(e2, 6) ^ rr(e2, 11) ^ rr(e2, 25)) + ((e2 & f) ^ (~e2 & g)) + K[i] + w[i]) | 0, t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e2; e2 = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = [a, b, c, d, e2, f, g, hh].map((v, i) => (h[i] + v) | 0);
    }
    const out = new Uint8Array(32), ov = new DataView(out.buffer); h.forEach((v, i) => ov.setUint32(i * 4, v >>> 0)); return out;
  }
  const HASHES = { md5, sha1, sha256 };
  const toBytes = (d, enc) => (typeof d === 'string' ? Buffer.from(d, enc) : d instanceof Uint8Array ? d : new Uint8Array(d));
  const hashAlg = (alg) => { const fn = HASHES[String(alg).toLowerCase().replace('-', '')]; if (!fn) throw new Error('Digest method not supported in this runtime: ' + alg + ' (available: md5, sha1, sha256)'); return fn; };
  const digestOut = (u8, enc) => (enc ? Buffer.from(u8).toString(enc) : Buffer.from(u8));
  const cryptoMod = {
    randomBytes: (n) => { const o = new Buffer(n); for (let i = 0; i < n; i += 65536) self.crypto.getRandomValues(o.subarray(i, Math.min(n, i + 65536))); return o; },
    randomUUID: () => (self.crypto.randomUUID ? self.crypto.randomUUID() : hex(cryptoMod.randomBytes(16)).replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/, '$1-$2-4$3-a$4-$5')),
    randomInt: (a, b) => { if (b == null) { b = a; a = 0; } return a + (cryptoMod.randomBytes(4).readUInt32BE(0) % (b - a)); },
    getRandomValues: (a) => self.crypto.getRandomValues(a),
    randomFillSync: (buf, off, size) => { const v = new Uint8Array(buf.buffer, buf.byteOffset + (off || 0), size == null ? buf.byteLength - (off || 0) : size); for (let i = 0; i < v.length; i += 65536) self.crypto.getRandomValues(v.subarray(i, Math.min(v.length, i + 65536))); return buf; },
    createHash: (alg) => { const fn = hashAlg(alg), parts = []; const h = { update: (d, enc) => { parts.push(toBytes(d, enc)); return h; }, digest: (enc) => digestOut(fn(Buffer.concat(parts)), enc) }; return h; },
    createHmac: (alg, key) => {
      const fn = hashAlg(alg); let k = toBytes(key); if (k.length > 64) k = fn(k);
      const kp = new Uint8Array(64); kp.set(k); const ip = kp.map((b) => b ^ 0x36), op = kp.map((b) => b ^ 0x5c), parts = [];
      const h = { update: (d, enc) => { parts.push(toBytes(d, enc)); return h; }, digest: (enc) => digestOut(fn(Buffer.concat([op, fn(Buffer.concat([ip].concat(parts)))])), enc) }; return h;
    },
    timingSafeEqual: (a, b) => { if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length'); let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; },
    getHashes: () => Object.keys(HASHES), webcrypto: self.crypto, subtle: self.crypto && self.crypto.subtle,
  };
  const qsMod = {
    escape: encodeURIComponent, unescape: decodeURIComponent,
    parse: (str) => { const o = {}; String(str || '').replace(/^\?/, '').split('&').forEach((p) => { if (!p) return; const i = p.indexOf('='), dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch (err) { return x; } }, k = dec(i < 0 ? p : p.slice(0, i)), v = i < 0 ? '' : dec(p.slice(i + 1)); if (k in o) o[k] = [].concat(o[k], v); else o[k] = v; }); return o; },
    stringify: (o) => Object.keys(o || {}).map((k) => [].concat(o[k]).map((v) => encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : v)).join('&')).join('&'),
  };
  qsMod.decode = qsMod.parse; qsMod.encode = qsMod.stringify;
  const urlMod = {
    URL: self.URL, URLSearchParams: self.URLSearchParams,
    parse: (u, parseQs) => { let x; try { x = new URL(u); } catch (err) { x = new URL(u, 'http://localhost'); } return { href: x.href, protocol: x.protocol, host: x.host, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, query: parseQs ? qsMod.parse(x.search) : x.search.slice(1), hash: x.hash, path: x.pathname + x.search, auth: x.username ? x.username + (x.password ? ':' + x.password : '') : null }; },
    format: (o) => (typeof o === 'string' ? o : o.href || (o.protocol || 'http:') + '//' + (o.host || o.hostname + (o.port ? ':' + o.port : '')) + (o.pathname || '/') + (o.search || (o.query ? '?' + (typeof o.query === 'string' ? o.query : qsMod.stringify(o.query)) : '')) + (o.hash || '')),
    resolve: (a, b) => new URL(b, a).href, fileURLToPath: (u) => String(u).replace(/^file:\/\//, ''), pathToFileURL: (p) => new URL('file://' + (p[0] === '/' ? '' : '/') + p),
  };
  const utilMod = {
    inspect: fmt, format: (...a) => { let i = 1; const first = a[0]; if (typeof first !== 'string') return a.map(fmt).join(' '); const t = first.replace(/%[sdifjoO%]/g, (m) => (m === '%%' ? '%' : i < a.length ? (m === '%d' || m === '%i' ? String(parseInt(a[i++], 10)) : m === '%f' ? String(parseFloat(a[i++])) : m === '%s' ? String(a[i++]) : fmt(a[i++])) : m)); return [t].concat(a.slice(i).map(fmt)).join(' '); },
    promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (err, v) => (err ? rej(err) : res(v)))),
    callbackify: (fn) => (...a) => { const cb = a.pop(); fn(...a).then((v) => cb(null, v), cb); },
    inherits: (c, sup) => { Object.setPrototypeOf(c.prototype, sup.prototype); Object.setPrototypeOf(c, sup); },
    deprecate: (fn) => fn, isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b), TextEncoder: self.TextEncoder, TextDecoder: self.TextDecoder,
    types: { isPromise: (v) => v instanceof Promise, isDate: (v) => v instanceof Date, isRegExp: (v) => v instanceof RegExp }, isArray: Array.isArray,
  };
  let live = 0; // requests still running: the run is not finished while one is open
  const trackedFetch = (...a) => { live++; return self.fetch(...a).finally(() => { live--; }); };
  const CORS_NOTE = 'In this runtime network calls go through the browser engine, so the server must allow cross-origin requests (CORS). For other servers use the curl command or the http_request tool.';
  function httpRequest(defProto) {
    const request = (u, o, cb) => {
      if (typeof u === 'object' && !(u instanceof URL)) { cb = o; o = u; u = (o.protocol || defProto) + '//' + (o.hostname || o.host || 'localhost') + (o.port ? ':' + o.port : '') + (o.path || '/'); }
      if (typeof o === 'function') { cb = o; o = {}; }
      o = o || {}; const req = new EventEmitter(), chunks = [];
      req.write = (d) => { chunks.push(toBytes(d)); return true; }; req.setHeader = (k, v) => { o.headers = Object.assign({}, o.headers, { [k]: v }); }; req.setTimeout = () => req; req.destroy = req.abort = () => {};
      req.end = (d) => {
        if (d) req.write(d);
        const method = (o.method || 'GET').toUpperCase();
        trackedFetch(String(u), { method, headers: o.headers, body: chunks.length && method !== 'GET' && method !== 'HEAD' ? Buffer.concat(chunks) : undefined }).then(async (r) => {
          const res = new EventEmitter(); res.statusCode = r.status; res.statusMessage = r.statusText; res.headers = {}; r.headers.forEach((v, k) => { res.headers[k] = v; }); res.setEncoding = (enc) => { res._enc = enc; }; res.resume = () => {};
          if (cb) cb(res); req.emit('response', res);
          const body = Buffer.from(await r.arrayBuffer());
          if (body.length) res.emit('data', res._enc ? body.toString(res._enc) : body);
          res.emit('end'); res.emit('close');
        }).catch((err) => { const e2 = new Error('request to ' + u + ' failed: ' + (err && err.message ? err.message : err) + '. ' + CORS_NOTE); e2.code = 'ECONNREFUSED'; if (req.listenerCount('error')) req.emit('error', e2); else { write('Uncaught', e2); exitCode = 1; } });
      };
      return req;
    };
    const noServer = () => { throw new Error('A server cannot listen on a port in this runtime (no sockets). Export the request handler and test it by calling it directly.'); };
    return { request, get: (u, o, cb) => { const r = request(u, o, cb); r.end(); return r; }, createServer: noServer, Server: noServer, Agent: class {}, globalAgent: {}, STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' }, METHODS: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] };
  }
  const noProc = (n) => () => { throw new Error('child_process.' + n + ' is not available: this runtime cannot start other programs. Run the command yourself with run_terminal_command instead.'); };
  const builtins = {
    fs: fsMod, 'fs/promises': fsMod.promises, path: pathMod, assert: assertMod, 'assert/strict': assertMod, util: utilMod,
    os: { EOL: '\n', platform: () => 'android', type: () => 'Linux', arch: () => 'wasm', homedir: () => '/', tmpdir: () => '/tmp', hostname: () => 'cybnate', cpus: () => [{ model: 'worker' }], totalmem: () => 0, freemem: () => 0, release: () => '', userInfo: () => ({ username: 'user' }), endianness: () => 'LE' },
    events: EventEmitter, buffer: { Buffer, kMaxLength: 2147483647 }, url: urlMod, querystring: qsMod, crypto: cryptoMod,
    child_process: { exec: noProc('exec'), execSync: noProc('execSync'), spawn: noProc('spawn'), spawnSync: noProc('spawnSync'), fork: noProc('fork'), execFile: noProc('execFile'), execFileSync: noProc('execFileSync') },
    http: httpRequest('http:'), https: httpRequest('https:'),
    timers: { setTimeout: (...a) => setT(...a), clearTimeout: (id) => clearT(id), setImmediate: (fn, ...a) => setT(fn, 0, ...a) }, 'timers/promises': { setTimeout: (ms, v) => new Promise((r) => setT(() => r(v), ms)) },
    string_decoder: { StringDecoder: class { constructor(enc) { this.d = new TextDecoder(enc || 'utf-8'); } write(b) { return this.d.decode(b, { stream: true }); } end(b) { return b ? this.d.decode(b) : this.d.decode(); } } },
    perf_hooks: { performance: self.performance }, module: { builtinModules: [], createRequire: () => (n) => rootRequire(n) }, constants: {}, tty: { isatty: () => false },
  };
  let rootRequire = () => { throw new Error('require is not ready'); };
  const MISSING_CORE = ['net', 'tls', 'dns', 'zlib', 'stream', 'readline', 'worker_threads', 'cluster', 'vm', 'http2', 'dgram', 'v8', 'async_hooks', 'inspector', 'repl'];

  class Exit extends Error {}
  const proc = { argv: ['node'].concat(m.argv), env: m.env || {}, platform: 'android', version: 'v18.0.0-cybnate', versions: { node: '18.0.0' }, pid: 1, arch: 'wasm', title: 'node', browser: false, execPath: '/node',
    nextTick: (fn, ...a) => Promise.resolve().then(() => fn(...a)), hrtime: Object.assign((prev) => { const t = self.performance.now(), s = Math.floor(t / 1000), n = Math.floor((t % 1000) * 1e6); return prev ? [s - prev[0], n - prev[1]] : [s, n]; }, { bigint: () => BigInt(Math.floor(self.performance.now() * 1e6)) }),
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }), uptime: () => self.performance.now() / 1000, on: () => proc, once: () => proc, off: () => proc, emit: () => false, emitWarning: (w) => write('Warning:', w), listeners: () => [], removeListener: () => proc, removeAllListeners: () => proc, binding: () => { throw new Error('process.binding is not available'); },
    cwd: () => '/' + cwd, exit: (c) => { exitCode = c | 0; exited = true; throw new Exit(); }, stdout: { write: (s) => { if (out.length < 200000) out += s; } }, stderr: { write: (s) => { if (out.length < 200000) out += s; } } };

  // keep the worker alive until timers have fired
  let pending = 0; const realSet = self.setTimeout.bind(self), realClear = self.clearTimeout.bind(self);
  const timers = new Set();
  const setT = (fn, ms, ...a) => { pending++; const id = realSet(() => { timers.delete(id); try { fn(...a); } catch (err) { if (!(err instanceof Exit)) { write('Uncaught', err); exitCode = 1; } } finally { pending--; } }, ms); timers.add(id); return id; };
  const clearT = (id) => { if (timers.has(id)) { timers.delete(id); pending--; realClear(id); } if (intervals.has(id)) { self.clearInterval(id); intervals.delete(id); } };
  const intervals = new Set();
  const setI = (fn, ms, ...a) => { const id = self.setInterval(() => { try { fn(...a); } catch (err) { if (!(err instanceof Exit)) { write('Uncaught', err); exitCode = 1; } self.clearInterval(id); intervals.delete(id); } }, Math.max(1, ms | 0)); intervals.add(id); return id; };
  const setImm = (fn, ...a) => setT(fn, 0, ...a);

  const cache = {}; let mainModule = null;
  const resolveFile = (from, req) => {
    const base = norm((req.startsWith('/') ? '' : dirOf(from) + '/') + req);
    for (const c of [base, base + '.js', base + '.json', base + '.cjs']) if (c in files) return c;
    if ((base + '/package.json') in files) { // a folder that is a package: its "main"
      try { const main = JSON.parse(td.decode(files[base + '/package.json'])).main; if (main) { const b2 = norm(base + '/' + main); for (const c of [b2, b2 + '.js', b2 + '/index.js']) if (c in files) return c; } } catch (err) { /* broken package.json: fall through to index.js */ }
    }
    for (const c of [base + '/index.js', base + '/index.json']) if (c in files) return c;
    return null;
  };
  /** require('name') or require('name/sub/path'): look in node_modules of the requiring folder and of every folder above it. */
  const resolveModule = (from, name) => {
    let dir = dirOf(from);
    for (;;) {
      const hit = resolveFile('x', '/' + (dir ? dir + '/' : '') + 'node_modules/' + name);
      if (hit) return hit;
      if (!dir) return null;
      dir = dirOf(dir);
    }
  };
  const load = (file) => {
    if (cache[file]) return cache[file].exports;
    const mod = (cache[file] = { exports: {} });
    const src = td.decode(files[file]);
    if (/\.json$/.test(file)) { mod.exports = JSON.parse(src); return mod.exports; }
    const req = (name) => {
      name = name.replace(/^node:/, '');
      if (builtins[name]) return builtins[name];
      if (/^[./]/.test(name)) { const f = resolveFile(file, name); if (!f) throw Object.assign(new Error("Cannot find module '" + name + "' (required from " + file + ')'), { code: 'MODULE_NOT_FOUND' }); return load(f); }
      const pkg = resolveModule(file, name);
      if (pkg) return load(pkg);
      if (MISSING_CORE.indexOf(name) >= 0) throw Object.assign(new Error("The Node.js module '" + name + "' is not available in this runtime (no sockets, streams or native code). Available: " + Object.keys(builtins).filter((k) => k.indexOf('/') < 0).join(', ') + '.'), { code: 'MODULE_NOT_FOUND' });
      throw Object.assign(new Error("Cannot find module '" + name + "' (required from " + file + "). Install it first: npm install " + name.split('/').slice(0, name[0] === '@' ? 2 : 1).join('/')), { code: 'MODULE_NOT_FOUND' });
    };
    req.resolve = (name) => { if (builtins[name.replace(/^node:/, '')]) return name; const f = /^[./]/.test(name) ? resolveFile(file, name) : resolveModule(file, name); if (!f) throw Object.assign(new Error("Cannot find module '" + name + "'"), { code: 'MODULE_NOT_FOUND' }); return '/' + f; };
    req.cache = cache; req.main = mainModule; mod.require = req; mod.id = mod.filename = '/' + file; mod.paths = []; mod.loaded = false;
    if (!mainModule) { mainModule = mod; rootRequire = req; }
    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', 'console', 'process', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Buffer', 'global', 'fetch', src + '\n//# sourceURL=' + file);
    fn.call(mod.exports, mod.exports, req, mod, '/' + file, '/' + dirOf(file), con, proc, setT, clearT, setI, clearT, setImm, clearT, Buffer, self, trackedFetch);
    mod.loaded = true;
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
  for (let i = 0; i < 3000 && !exited; i++) { await new Promise((r) => realSet(r, 10)); if (pending <= 0 && live <= 0 && intervals.size === 0 && i > 2) break; }
  intervals.forEach((id) => self.clearInterval(id));

  const changed = [], deleted = [];
  for (const p in files) { const a = files[p], b = original[p]; if (!b || a !== b) changed.push({ path: p, data: a }); }
  for (const p in original) if (!(p in files)) deleted.push(p);
  self.postMessage({ id: m.id, code: exitCode, out, changed, deleted });
};
