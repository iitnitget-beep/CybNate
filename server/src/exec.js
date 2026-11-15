'use strict';
/*
 * Runs shell commands in a user's workspace. One command at a time per user (so two runs never fight over the same
 * files), a server-wide limit on how many run at once, a time limit that kills the whole process group, and a cap on output.
 */
const { spawn } = require('node:child_process');

const MAX_OUT = 400000;

function create(workspace, opts) {
  opts = opts || {};
  const maxParallel = opts.maxParallel || 4, maxQueue = opts.maxQueue || 8, shell = opts.shell || 'bash';
  let running = 0; const waiting = []; const perUser = new Map(); const live = new Map();
  const slot = () => new Promise((res) => { if (running < maxParallel) { running++; res(); } else waiting.push(res); });
  const free = () => { const next = waiting.shift(); if (next) next(); else running--; };

  /** Environment for a command: nothing from the server's own environment except PATH and locale. */
  function envFor(user, extra) {
    const d = workspace.ensure(user);
    return Object.assign({ PATH: d.home + '/.local/bin:' + d.home + '/.npm-global/bin:' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'), PIP_BREAK_SYSTEM_PACKAGES: '1', NPM_CONFIG_PREFIX: d.home + '/.npm-global', HOME: d.home, USER: 'cyb', LOGNAME: 'cyb', LANG: process.env.LANG || 'C.UTF-8', TERM: 'dumb', CI: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', NPM_CONFIG_UPDATE_NOTIFIER: 'false' }, extra || {});
  }
  function redact(text, values) { (values || []).forEach((v) => { if (v && String(v).length >= 4) text = text.split(String(v)).join('***'); }); return text; }

  function runNow(user, o) {
    return new Promise((resolve) => {
      const d = workspace.ensure(user); const started = Date.now();
      let child;
      try { child = spawn(shell, ['-c', 'ulimit -c 0; ' + o.command], Object.assign({ cwd: d.ws, env: envFor(user, o.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }, workspace.ids(user))); }
      catch (e) { return resolve({ code: 126, out: 'Could not start the command: ' + e.message, timedOut: false, ms: 0 }); }
      let head = '', tail = '', dropped = 0, timedOut = false, stopped = false, done = false;
      const take = (buf) => { const s = buf.toString('utf8'); if (head.length < MAX_OUT / 2) { head += s; if (head.length > MAX_OUT / 2) { tail = head.slice(MAX_OUT / 2); head = head.slice(0, MAX_OUT / 2); } } else { tail += s; if (tail.length > MAX_OUT / 2) { dropped += tail.length - MAX_OUT / 2; tail = tail.slice(-MAX_OUT / 2); } } };
      child.stdout.on('data', take); child.stderr.on('data', take);
      const kill = (sig) => { try { process.kill(-child.pid, sig); } catch (e) { try { child.kill(sig); } catch (er) { /* already gone */ } } };
      const stop = () => { kill('SIGTERM'); setTimeout(() => { if (!done) kill('SIGKILL'); }, 2000).unref(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, o.timeoutSec || 60) * 1000);
      if (o.id) live.set(user.id + ':' + o.id, () => { stopped = true; stop(); });
      if (o.signal) { if (o.signal.aborted) { stopped = true; stop(); } else o.signal.addEventListener('abort', () => { stopped = true; stop(); }, { once: true }); }
      const finish = (code, sig) => {
        if (done) return; done = true; clearTimeout(timer); if (o.id) live.delete(user.id + ':' + o.id);
        kill('SIGKILL'); // background children of the command do not outlive it
        let out = head + (dropped ? '\n[... ' + dropped + ' characters left out ...]\n' : '') + tail;
        out = redact(out, Object.values(o.env || {}));
        if (timedOut) out += (out && !out.endsWith('\n') ? '\n' : '') + 'Timed out after ' + (o.timeoutSec || 60) + ' s and was stopped.';
        resolve({ code: timedOut ? 124 : stopped ? 130 : code == null ? (sig ? 128 : 1) : code, out, timedOut, stopped, ms: Date.now() - started });
      };
      child.on('error', (e) => { head += 'Could not start the command: ' + e.message; finish(127); });
      child.on('close', finish);
    });
  }
  /** Queue a command for a user. Rejects with status 429 when the user already has too many waiting. */
  function run(user, o) {
    const q = perUser.get(user.id) || { tail: Promise.resolve(), n: 0 };
    if (q.n >= maxQueue) return Promise.reject(Object.assign(new Error('Too many commands are waiting. Try again when one has finished.'), { status: 429 }));
    q.n++; perUser.set(user.id, q);
    const job = q.tail.then(async () => { await slot(); try { return await o.around(() => runNow(user, o)); } finally { free(); } });
    q.tail = job.catch(() => {}).then(() => { q.n--; if (!q.n) perUser.delete(user.id); });
    return job;
  }
  const cancel = (user, id) => { const k = live.get(user.id + ':' + id); if (k) k(); return !!k; };
  return { run, cancel, envFor, redact, stats: () => ({ running, waiting: waiting.length }) };
}

module.exports = { create };
