const assert = require('assert');
const Index = require('../app/src/main/assets/www/project-index.js');

const report = Index.buildInventory([
  { path: 'src/main.kt', content: 'fun main() {}' },
  { path: 'app.js', content: 'console.log(1)' },
  { path: 'package.json', content: JSON.stringify({ scripts: { test: 'node test.js', build: 'vite build', lint: 'eslint .' } }) },
  { path: 'node_modules/pkg/index.js', content: 'ignored' },
  { path: '../outside.js', content: 'unsafe' },
  { path: '/absolute.js', content: 'unsafe' },
  { path: 'README.md', content: '# Demo' }
]);
assert.strictEqual(report.totals.files, 4);
assert.strictEqual(report.languages.kotlin, 1);
assert.strictEqual(report.languages.javascript, 1);
assert.deepStrictEqual(report.manifests, ['package.json']);
assert.deepStrictEqual(report.entryPoints, ['app.js', 'src/main.kt']);
assert.deepStrictEqual(report.testCommands.map((x) => x.name), ['lint', 'test']);
assert.ok(report.warnings.length >= 2);
assert.strictEqual(Index.safePath('src\\..\\secret.txt'), null);
assert.strictEqual(Index.safePath('src/../secret.txt'), null);
assert.strictEqual(Index.safePath('src/ok.js'), 'src/ok.js');

const malformed = Index.buildInventory([{ path: 'package.json', content: '{bad json' }]);
assert.ok(malformed.warnings.some((x) => /Could not parse/.test(x)));
const oversized = Index.buildInventory([{ path: 'huge.js', content: 'x'.repeat(20) }], { maxFileBytes: 10 });
assert.strictEqual(oversized.totals.files, 0);
assert.ok(oversized.warnings.some((x) => /oversized/.test(x)));
const capped = Index.buildInventory([{ path: 'a.js', content: 'a' }, { path: 'b.js', content: 'b' }], { maxFiles: 1 });
assert.strictEqual(capped.totals.files, 1);
assert.strictEqual(capped.truncated, true);
const byteCapped = Index.buildInventory([{ path: 'a.js', content: '1234' }, { path: 'b.js', content: '5678' }], { maxTotalBytes: 5 });
assert.strictEqual(byteCapped.totals.files, 1);
assert.strictEqual(byteCapped.truncated, true);
console.log('Project inventory tests passed');
