// Run with: node tests/core.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../app/src/main/assets/www/core.js');

(async () => {
  const ws = new C.Workspace();
  const allowed = C.AGENTS.reverse.tools;

  // --- tool parsing
  const reply = 'Sure.\n<write_file path="index.html">\n<!doctype html>\n<h1>Hi</h1>\n</write_file>\nand\n' +
    '<write_file path="./js/app.js">\n```js\nconst a = 1 > 0;\n```\n</write_file>\n<list_files/>\n<read_file path="index.html" start="1" end="1"></read_file>';
  let calls = C.parseToolCalls(reply, allowed);
  assert.deepStrictEqual(calls.map((c) => c.name), ['write_file', 'write_file', 'list_files', 'read_file']);
  assert.strictEqual(calls[0].body, '<!doctype html>\n<h1>Hi</h1>');
  assert.strictEqual(calls[1].body, 'const a = 1 > 0;');
  let res = await C.runTools(calls, ws);
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  assert.deepStrictEqual(ws.list(), ['index.html', 'js/app.js']);
  assert.ok(res[3].text.includes('<!doctype html>') && !res[3].text.includes('<h1>'));

  // tools not allowed for an agent are ignored
  assert.strictEqual(C.parseToolCalls(reply, C.AGENTS.planner.tools).length, 2);
  assert.strictEqual(C.parseToolCalls(reply, C.AGENTS.chat.tools).length, 0);

  // --- edit_file exact + whitespace tolerant + failure
  ws.set('a.js', 'function f() {\n    return 1;\n}\nconst x = 2;\n');
  calls = C.parseToolCalls('<edit_file path="a.js">\n<search>const x = 2;</search>\n<replace>const x = 3;</replace>\n<search>\n  return 1;\n</search>\n<replace>\n    return 42;\n</replace>\n</edit_file>', allowed);
  res = await C.runTools(calls, ws);
  assert.ok(res[0].ok, res[0].text);
  assert.strictEqual(ws.get('a.js'), 'function f() {\n    return 42;\n}\nconst x = 3;\n');
  res = await C.runTools(C.parseToolCalls('<edit_file path="a.js"><search>nope</search><replace>y</replace></edit_file>', allowed), ws);
  assert.ok(!res[0].ok && /not found/.test(res[0].text));
  res = await C.runTools(C.parseToolCalls('<read_file path="missing.txt"/>', allowed), ws);
  assert.ok(!res[0].ok && /file not found/.test(res[0].text));

  // --- search / delete / path traversal is neutralised
  res = await C.runTools(C.parseToolCalls('<search_files query="return \\d+"/><delete_file path="a.js"/>', allowed), ws);
  assert.ok(/a\.js:2/.test(res[0].text)); assert.ok(!ws.has('a.js'));
  assert.strictEqual(C.Workspace.norm('../../etc/./passwd'), 'etc/passwd');

  // --- display text
  const d = C.displayText('Working\n<write_file path="x.py">\nprint(1)\n</write_file>\n<write_file path="y.py">\nprint(');
  assert.ok(/🔧 \*\*write_file\*\* `x\.py`/.test(d) && /✍️ \*\*write_file\*\* `y\.py`/.test(d) && !/print/.test(d), d);
  assert.strictEqual(C.displayText('hello <rea'), 'hello ');

  // --- zip roundtrip (stored) + deflate read via python-made archive
  const z = C.zipCreate([{ name: 'a/b.txt', data: C.utf8('hello zip') }, { name: 'c.bin', data: new Uint8Array([0, 1, 2, 255]) }]);
  assert.deepStrictEqual(C.zipEntries(z).map((e) => e.name), ['a/b.txt', 'c.bin']);
  assert.strictEqual(Buffer.from(await C.zipRead(z, 'a/b.txt')).toString(), 'hello zip');
  require('child_process').execSync(`python3 -c "import zipfile;z=zipfile.ZipFile('/tmp/t.zip','w',zipfile.ZIP_DEFLATED);z.writestr('big.txt','abc'*5000);z.close()"`);
  const pz = new Uint8Array(fs.readFileSync('/tmp/t.zip'));
  assert.strictEqual((await C.zipRead(pz, 'big.txt')).length, 15000);
  require('child_process').execSync('cd /tmp && rm -rf zt && mkdir zt && cd zt && python3 -c "import zipfile;zipfile.ZipFile(\'/tmp/out.zip\').extractall(\'.\')" 2>/dev/null || true');

  // --- strings / hexdump
  const bin = new Uint8Array(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('https://api.example.com/v1'), Buffer.from([0, 0]), Buffer.from('secret_token', 'utf16le'), Buffer.from([0, 7])]));
  const s = C.extractStrings(bin, { min: 6 });
  assert.ok(s.items.includes('https://api.example.com/v1') && s.items.includes('secret_token'), JSON.stringify(s));
  assert.strictEqual(C.extractStrings(bin, { filter: 'https?://' }).total, 1);
  assert.ok(C.hexdump(bin, 0, 16).startsWith('00000000  00 01 02 68 74 74 70'));

  // --- SSE
  const p = C.createSseParser();
  let got = p.feed('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi');
  got = got.concat(p.feed('ces":[{"delta":{"content":"lo"}}]}\n\n: keepalive\ndata: [DONE]\n'));
  assert.strictEqual(got.map((g) => g.text).join(''), 'Hello');
  assert.ok(p.feed('data: {"error":{"message":"rate limited"}}\n')[0].error === 'rate limited');

  // --- model lists
  assert.deepStrictEqual(C.parseModelList({ data: [{ id: 'a/b:free' }, { id: 'c/d', pricing: { prompt: '1', completion: '1' } }] }, C.PROVIDERS.openrouter), ['a/b:free']);
  assert.deepStrictEqual(C.parseModelList([{ name: 'openai' }, { name: 'openai-audio' }], C.PROVIDERS.pollinations), ['openai']);
  assert.deepStrictEqual(C.parseModelList({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }] }, C.PROVIDERS.gemini), ['gemini-2.5-flash']);

  // --- history trimming
  const h = C.trimHistory([{ role: 'user', content: 'x'.repeat(50) }, { role: 'assistant', content: 'y'.repeat(50) }, { role: 'user', content: 'z' }], 60);
  assert.strictEqual(h[h.length - 1].content, 'z'); assert.strictEqual(h[0].role, 'user');

  // --- real APK analysis (uses the CI-built APK when present)
  const apk = path.join(__dirname, '..', 'release', 'CybNate.apk');
  if (fs.existsSync(apk)) {
    ws.set('app.apk', new Uint8Array(fs.readFileSync(apk)));
    res = await C.runTools(C.parseToolCalls('<file_info path="app.apk"/><android_manifest path="app.apk"/><zip_extract path="app.apk" entry="classes.dex" dest="c.dex"/><file_info path="c.dex"/><strings path="c.dex" filter="cybnate" limit="5"/>', allowed), ws);
    res.forEach((r) => assert.ok(r.ok, r.text));
    assert.ok(/Android APK/.test(res[0].text) && /classes\.dex/.test(res[0].text));
    assert.ok(/package="com\.cybnate\.app"/.test(res[1].text) && /android\.permission\.INTERNET/.test(res[1].text), res[1].text);
    assert.ok(/DEX version: 03\d/.test(res[3].text), res[3].text);
    assert.ok(/MainActivity/.test(res[4].text), res[4].text);
    console.log(res[0].text + '\n' + res[1].text.split('\n').slice(0, 6).join('\n'));
  } else console.log('(APK not present, skipped APK analysis test)');

  assert.ok(C.buildSystemPrompt('coder', ws.summary()).includes('<write_file'));
  assert.ok(!C.buildSystemPrompt('chat', '').includes('# Tools'));
  console.log('ALL CORE TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
