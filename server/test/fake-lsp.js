// A tiny language server for tests: reports every line that contains "BUG" as an error, answers hover with the line text.
let buf = Buffer.alloc(0); const docs = new Map();
const send = (m) => { const b = Buffer.from(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m))); process.stdout.write('Content-Length: ' + b.length + '\r\n\r\n'); process.stdout.write(b); };
const publish = (uri) => send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: docs.get(uri).split('\n').map((l, i) => (l.includes('BUG') ? { range: { start: { line: i, character: l.indexOf('BUG') }, end: { line: i, character: l.indexOf('BUG') + 3 } }, severity: 1, source: 'fake', message: 'BUG found' } : null)).filter(Boolean) } });
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n'); if (sep < 0) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString())[1]); if (buf.length < sep + 4 + len) return;
    const m = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString()); buf = buf.subarray(sep + 4 + len);
    if (m.method === 'initialize') { send({ id: 900, method: 'workspace/configuration', params: { items: [{}] } }); send({ id: m.id, result: { capabilities: { hoverProvider: true } } }); }
    else if (m.method === 'textDocument/didOpen') { docs.set(m.params.textDocument.uri, m.params.textDocument.text); publish(m.params.textDocument.uri); }
    else if (m.method === 'textDocument/didChange') { docs.set(m.params.textDocument.uri, m.params.contentChanges[0].text); publish(m.params.textDocument.uri); }
    else if (m.method === 'textDocument/hover') send({ id: m.id, result: { contents: (docs.get(m.params.textDocument.uri) || '').split('\n')[m.params.position.line] } });
    else if (m.method === 'exit') process.exit(0);
    else if (m.id != null && m.method) send({ id: m.id, error: { code: -32601, message: 'no such method' } });
  }
});
