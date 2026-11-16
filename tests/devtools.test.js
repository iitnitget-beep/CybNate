// Fuzzy search/replace, unified diffs, recovery of edits written without tool tags, repo map, diagnostics.
const assert = require('assert');
const D = require('../app/src/main/assets/www/devtools.js');

// ---- 4-stage matcher
const file = 'def add(a, b):\n    total = a + b   \n    return total\n\nclass Calc:\n    def mul(self, a, b):\n        result = a * b\n        return result\n';
let r = D.fuzzyReplace(file, 'return total', 'return total + 0'); assert.strictEqual(r.stage, 1);
r = D.fuzzyReplace(file, '    total = a + b\n    return total', '    return a + b'); assert.strictEqual(r.stage, 2, 'trailing whitespace');
assert.ok(/def add\(a, b\):\n    return a \+ b\n\nclass/.test(r.text), r.text);
r = D.fuzzyReplace(file, 'def mul(self, a, b):\n    result = a * b\n    return result', 'def mul(self, a, b):\n    return a * b'); assert.strictEqual(r.stage, 3, 'indentation shift');
assert.ok(/class Calc:\n    def mul\(self, a, b\):\n        return a \* b\n$/.test(r.text), JSON.stringify(r.text));
r = D.fuzzyReplace(file, 'class Calc:\n    def mul(self, a, b):\n        res = a * b\n        return result', 'class Calc:\n    def mul(self, a, b):\n        return a * b'); assert.strictEqual(r.stage, 4, 'fuzzy');
assert.ok(/def mul\(self, a, b\):\n        return a \* b\n$/.test(r.text));
assert.strictEqual(D.fuzzyReplace(file, 'def nothing_like_this():\n    pass\n    x = 1', 'x'), null);
assert.strictEqual(D.fuzzyReplace(file, 'totl = a + b', 'x'), null, 'a single different line is never fuzzy-matched');
const near = D.nearby(file, '    totl = a + b\n    return total');
assert.ok(/ 2\|     total = a \+ b/.test(near) && / 3\|     return total/.test(near), near);
assert.strictEqual(D.numbered('a\nb', 9), '  9| a\n 10| b');

// ---- search/replace blocks
const sr = D.parseSearchReplace('x\n<<<<<<< SEARCH\nold\n=======\nnew\nline\n>>>>>>> REPLACE\ny');
assert.strictEqual(sr.length, 1); assert.strictEqual(sr[0].search, 'old'); assert.strictEqual(sr[0].replace, 'new\nline');
assert.strictEqual(D.parseSearchReplace('<<<<<<< SEARCH\n=======\nwhole new\n>>>>>>> REPLACE')[0].search, '');

// ---- unified diff
const diff = '--- a/calc.py\n+++ b/calc.py\n@@ -1,3 +1,3 @@\n def add(a, b):\n-    total = a + b\n-    return total\n+    return a + b\n@@ -6,3 +5,4 @@ class Calc:\n     def mul(self, a, b):\n         result = a * b\n+        print(result)\n         return result\n';
const pd = D.parseUnifiedDiff(diff);
assert.strictEqual(pd.length, 1); assert.strictEqual(pd[0].path, 'calc.py'); assert.strictEqual(pd[0].hunks.length, 2);
let ap = D.applyHunks(file, pd[0].hunks);
assert.strictEqual(ap.applied, 2); assert.strictEqual(ap.failed.length, 0);
assert.ok(/def add\(a, b\):\n    return a \+ b\n/.test(ap.text) && /result = a \* b\n        print\(result\)\n        return result/.test(ap.text), ap.text);
// wrong line numbers do not matter; a hunk whose context is gone is reported with nearby lines
ap = D.applyHunks(file, D.parseUnifiedDiff('--- a/calc.py\n+++ b/calc.py\n@@ -90,2 +90,2 @@\n-    return total\n+    return total * 1\n@@ -1,2 +1,2 @@\n-    retrun totl\n+    x\n')[0].hunks);
assert.strictEqual(ap.applied, 1); assert.strictEqual(ap.failed.length, 1); assert.ok(/return total \* 1/.test(ap.text));
const nf = D.parseUnifiedDiff('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n');
assert.ok(nf[0].isNew); assert.strictEqual(D.applyHunks('', nf[0].hunks).text, 'hello\nworld');
assert.ok(D.parseUnifiedDiff('--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n')[0].isDelete);

// ---- replies without tool tags
let c = D.looseCalls('I will fix it.\n\ncalc.py\n```python\n<<<<<<< SEARCH\n    return total\n=======\n    return total + 1\n>>>>>>> REPLACE\n```\n\nutil/io.py\n<<<<<<< SEARCH\n=======\nprint("new file")\n>>>>>>> REPLACE\n');
assert.strictEqual(c.length, 2);
assert.strictEqual(c[0].name, 'edit_file'); assert.strictEqual(c[0].attrs.path, 'calc.py'); assert.strictEqual(c[0].edits[0].replace, '    return total + 1');
assert.strictEqual(c[1].name, 'write_file'); assert.strictEqual(c[1].attrs.path, 'util/io.py'); assert.strictEqual(c[1].body, 'print("new file")');
// two blocks for the same file become one edit_file call
c = D.looseCalls('`app.js`\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n');
assert.strictEqual(c.length, 1); assert.strictEqual(c[0].edits.length, 2);
// unified diff, fenced and bare
c = D.looseCalls('Here is the patch:\n```diff\n' + diff + '```\n'); assert.strictEqual(c.length, 1); assert.strictEqual(c[0].name, 'edit_file'); assert.strictEqual(c[0].diff.hunks.length, 2);
c = D.looseCalls(diff); assert.strictEqual(c.length, 1); assert.strictEqual(c[0].attrs.path, 'calc.py');
// named fences
c = D.looseCalls('```python main.py\nprint(1)\n```\n\n```js\n// filename: src/app.js\nconsole.log(2)\n```\n\n**server/api.py**\n```python\nx = 3\n```\n\n### File: `README.md`\n```markdown\n# Title\n```\n');
assert.deepStrictEqual(c.map((x) => x.name + ' ' + x.attrs.path), ['write_file main.py', 'write_file src/app.js', 'write_file server/api.py', 'write_file README.md']);
assert.strictEqual(c[1].body, 'console.log(2)', 'the filename comment is not part of the file');
// not file writes: plain examples, command output, elided code, prose that merely ends with a word
c = D.looseCalls('Run it like this:\n```bash\npython main.py\n```\nOutput:\n```\n42\n```\nExample:\n```python\nprint("hi")\n```\n');
assert.strictEqual(c.length, 0, JSON.stringify(c));
c = D.looseCalls('main.py\n```python\ndef a():\n    pass\n# ... rest of the code unchanged\n```\n'); assert.strictEqual(c.length, 0, 'elided block is not a whole-file write');
c = D.looseCalls('The fix is simple.\n```python\nx = 1\n```\n'); assert.strictEqual(c.length, 0);
c = D.looseCalls('Use version 2.0\n```python\nx = 1\n```\n'); assert.strictEqual(c.length, 0, 'a sentence is not a path');

// ---- definitions and repo map
const py = 'import os\n\nclass User:\n    def save(self, db):\n        pass\n\nasync def main(argv):\n    pass\n\n@app.route("/users")\ndef users():\n    pass\n';
assert.deepStrictEqual(D.definitions('m.py', py).map((d) => d.line + ' ' + d.kind + ' ' + d.name), ['3 class User', '4 method save(self, db)', '7 def main(argv)', '10 route /users', '11 def users()']);
const js = 'export class Store {\n  constructor(x) {\n  }\n  async load(id) {\n  }\n}\nexport const VERSION = 1;\nconst add = (a, b) => a + b;\nfunction run(opts) {}\napp.get("/api/items", handler);\nmodule.exports.helper = 1;\ninterface Item { id: number }\n';
assert.deepStrictEqual(D.definitions('s.ts', js).map((d) => d.kind + ' ' + d.name), ['class Store', 'method constructor()', 'method load()', 'export VERSION', 'function add', 'function run(opts)', 'route GET /api/items', 'export helper', 'type Item']);
assert.deepStrictEqual(D.definitions('A.java', 'public class A {\n    private int n;\n    public static void main(String[] args) {\n    }\n    int size() {\n    }\n}\ninterface B {}\n').map((d) => d.kind + ' ' + d.name), ['class A', 'method main()', 'interface B']);
assert.deepStrictEqual(D.definitions('m.go', 'type Server struct {\n}\nfunc (s *Server) Start() error {\n}\nfunc main() {\n}\n').map((d) => d.kind + ' ' + d.name), ['struct Server', 'method (*Server) Start()', 'func main()']);
assert.deepStrictEqual(D.definitions('m.rs', 'pub struct P { x: i32 }\nimpl P {\n    pub fn new() -> Self { P { x: 0 } }\n}\nfn main() {}\n').map((d) => d.kind + ' ' + d.name), ['struct P', 'impl P', 'fn new()', 'fn main()']);
assert.deepStrictEqual(D.definitions('m.c', '#include <stdio.h>\nstruct node {\n};\nstatic int add(int a, int b) {\n  return a + b;\n}\nint main(void)\n{\n}\n').map((d) => d.kind + ' ' + d.name), ['struct node', 'function add()', 'function main()']);
assert.deepStrictEqual(D.definitions('i.html', '<title>Demo</title>\n<div id="app"></div>\n<script src="app.js"></script>\n').map((d) => d.kind + ' ' + d.name), ['title Demo', '#app <div>', 'script app.js']);
assert.deepStrictEqual(D.definitions('s.css', '.card {\n  color: red;\n}\n@media (max-width: 600px) {\n').map((d) => d.name), ['.card', '@media (max-width: 600px)']);
assert.deepStrictEqual(D.definitions('x.bin', 'whatever'), []);
const map = D.repoMap([{ path: 'm.py', text: py }, { path: 'src/s.ts', text: js }, { path: 'vendor/lib.js', text: 'function hidden() {}' }, { path: 'a.min.js', text: 'function z(){}' }, { path: 'bin.dat', text: new Uint8Array(2) }]);
assert.ok(/^m\.py: User:3, save\(self, db\):4, main\(argv\):7/.test(map), map); assert.ok(/src\/s\.ts: Store:1/.test(map)); assert.ok(!/hidden|a\.min/.test(map));
assert.ok(D.repoMap([{ path: 'm.py', text: py }, { path: 'n.py', text: py }], 80).split('\n').pop().indexOf('more files') > 0, 'budget respected');

// ---- diagnostics
const has = (p) => ['app.js', 'style.css', 'pkg/util.py', 'pkg/__init__.py'].indexOf(p) >= 0;
assert.strictEqual(D.diagLine('a.json', '{"a": 1}'), '[diagnostics: OK]');
assert.ok(/^\[diagnostics: ERROR in a\.json: /.test(D.diagLine('a.json', '{"a": 1,}')));
assert.strictEqual(D.diagLine('a.js', 'const x = 1;\nfunction f() { return x; }\n'), '[diagnostics: OK]');
assert.ok(/ERROR in a\.js: .*line 1: "\{" is never closed/.test(D.diagLine('a.js', 'function f() {\n  return 1;\n')), D.diagLine('a.js', 'function f() {\n  return 1;\n'));
assert.ok(/ERROR/.test(D.diagLine('a.js', 'const = 5;')));
assert.strictEqual(D.diagLine('m.mjs', 'import fs from "fs";\nimport { a, b } from "./x.js";\nexport const y = await a();\nexport default function main() { return import.meta.url; }\nexport { y as z };\n'), '[diagnostics: OK]');
assert.strictEqual(D.diagLine('a.js', '#!/usr/bin/env node\nconst s = `a ${1 + 1} {`;\nconst r = /[{(]/;\n// unbalanced ( in a comment\n'), '[diagnostics: OK]');
assert.strictEqual(D.diagLine('a.py', py), '[diagnostics: OK]');
assert.strictEqual(D.diagLine('a.py', 'x = {\n    "a": [1, 2,\n          3],\n}\ns = """(((\n"""\nif x:  # why (\n    print("unbalanced ) in string")\n'), '[diagnostics: OK]');
assert.ok(/line 1: "\(" is never closed/.test(D.diagLine('a.py', 'print("a"\nx = 1\n')));
assert.ok(/expected an indented block after "def f\(\):"/.test(D.diagLine('a.py', 'def f():\nreturn 1\n')));
assert.ok(/missing ":"/.test(D.diagLine('a.py', 'def f()\n    return 1\n')));
assert.ok(/local module "\.missing" not found/.test(D.diagLine('pkg/a.py', 'from .missing import x\nfrom .util import y\nfrom . import util\n', has)));
assert.strictEqual(D.diagLine('pkg/a.py', 'from .util import y\nimport os\n', has), '[diagnostics: OK]');
assert.strictEqual(D.diagLine('i.html', '<html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script><script src="https://cdn.x/y.js"></script></head><body><a href="#top">x</a><script>let a = 1;</script></body></html>', has), '[diagnostics: OK]');
const he = D.diagLine('i.html', '<html><script src="missing.js"></script><style>body{}<script>let = ;</script></html>', has);
assert.ok(/unclosed <style>/.test(he) && /src="missing\.js"> points to a file that is not in the workspace/.test(he) && /inline <script> near line 1/.test(he), he);
assert.strictEqual(D.diagLine('notes.txt', 'anything {'), '', 'unknown types are not checked');
assert.strictEqual(D.diagLine('a.css', 'a { color: red; }'), '[diagnostics: OK]');
assert.ok(/never closed/.test(D.diagLine('a.css', 'a { color: red;')));
console.log('ALL DEVTOOLS TESTS PASSED');
