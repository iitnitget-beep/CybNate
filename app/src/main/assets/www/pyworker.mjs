// Runs Python (CPython on WebAssembly via Pyodide) against a copy of the workspace.
// Lives in a worker so a runaway script can be terminated by the app.
import { loadPyodide } from './vendor/pyodide/pyodide.mjs';

const VERSION = '314.0.8';
let pyReady = null;
let out = '';
const emit = (s) => { if (out.length < 200000) out += s + '\n'; };

function init() {
  if (!pyReady) {
    pyReady = loadPyodide({
      indexURL: new URL('./vendor/pyodide/', import.meta.url).href,
      // extra packages (numpy, pandas, micropip…) are downloaded on demand
      packageBaseUrl: 'https://cdn.jsdelivr.net/pyodide/v' + VERSION + '/full/',
      stdout: emit, stderr: emit,
    });
  }
  return pyReady;
}

const DRIVER = `
import sys, os, runpy, traceback, importlib
def __cyb_run(mode, argv, src, cwd):
    os.chdir(cwd)
    sys.argv = list(argv)
    if cwd not in sys.path: sys.path.insert(0, cwd)
    code = 0
    try:
        if mode == 'file':
            runpy.run_path(argv[0], run_name='__main__')
        elif mode == 'module':
            runpy.run_module(argv[0], run_name='__main__', alter_sys=True)
        else:
            exec(compile(src, '<string>', 'exec'), {'__name__': '__main__'})
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        if e.code is not None and not isinstance(e.code, int): print(e.code, file=sys.stderr)
    except BaseException:
        traceback.print_exc()
        code = 1
    finally:
        try:
            sys.stdout.flush(); sys.stderr.flush()
        except Exception: pass
        # forget workspace modules so the next run sees edited files
        for name, mod in list(sys.modules.items()):
            f = getattr(mod, '__file__', None) or ''
            if f.startswith('/work/'): del sys.modules[name]
        importlib.invalidate_caches()
    return code
`;

function rmrf(FS, p) {
  for (const n of FS.readdir(p)) {
    if (n === '.' || n === '..') continue;
    const q = p + '/' + n;
    if (FS.isDir(FS.stat(q).mode)) { rmrf(FS, q); FS.rmdir(q); } else FS.unlink(q);
  }
}
function walk(FS, p, rel, acc) {
  for (const n of FS.readdir(p)) {
    if (n === '.' || n === '..' || n === '__pycache__') continue;
    const q = p + '/' + n, r = rel ? rel + '/' + n : n;
    if (FS.isDir(FS.stat(q).mode)) walk(FS, q, r, acc); else acc[r] = FS.readFile(q);
  }
  return acc;
}
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

self.onmessage = async (e) => {
  const m = e.data;
  out = '';
  try {
    const py = await init();
    const FS = py.FS;
    FS.chdir('/'); // a previous run may have left the working directory inside /work
    FS.mkdirTree('/work'); rmrf(FS, '/work');
    const before = {};
    for (const f of m.files) {
      const full = '/work/' + f.path, dir = full.slice(0, full.lastIndexOf('/'));
      FS.mkdirTree(dir); FS.writeFile(full, f.data); before[f.path] = f.data;
    }
    let cwd = '/work' + (m.cwd ? '/' + m.cwd : '');
    try { FS.stat(cwd); } catch (err) { cwd = '/work'; }

    if (m.env && Object.keys(m.env).length) py.runPython('import os, json; os.environ.update(json.loads(' + JSON.stringify(JSON.stringify(m.env)) + '))');
    let code = 0;
    if (m.mode === 'pip') {
      await py.loadPackage('micropip', { messageCallback: () => {}, errorCallback: emit });
      const micropip = py.pyimport('micropip');
      for (const pkg of m.argv) {
        try { await micropip.install(pkg); emit('Successfully installed ' + pkg); }
        catch (err) { emit('ERROR: could not install ' + pkg + ': ' + String(err.message || err).split('\n').slice(-2).join(' ')); code = 1; }
      }
    } else {
      const src = m.mode === 'code' ? m.src : m.mode === 'file' ? (() => { try { return FS.readFile((m.argv[0].startsWith('/') ? '' : cwd + '/') + m.argv[0], { encoding: 'utf8' }); } catch (err) { return ''; } })() : '';
      if (src) { try { await py.loadPackagesFromImports(src, { messageCallback: () => {}, errorCallback: () => {} }); } catch (err) { /* offline or unknown package: the import error will explain */ } }
      py.runPython(DRIVER);
      const run = py.globals.get('__cyb_run');
      code = run(m.mode, py.toPy(m.argv), m.src || '', cwd);
      run.destroy();
    }
    const after = walk(FS, '/work', '', {});
    const changed = [], deleted = [];
    for (const p in after) if (!before[p] || !same(before[p], after[p])) changed.push({ path: p, data: after[p] });
    for (const p in before) if (!(p in after)) deleted.push(p);
    self.postMessage({ id: m.id, code, out, changed, deleted });
  } catch (err) {
    self.postMessage({ id: m.id, code: 1, out: out + 'Python runtime error: ' + (err && (err.message || err.name) ? (err.message || err.name) + (err.errno ? ' (errno ' + err.errno + ')' : '') : String(err)), changed: [], deleted: [] });
  }
};
