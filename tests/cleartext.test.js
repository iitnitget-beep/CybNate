// Cleartext URL policy and redirect safeguards. Run with: node tests/cleartext.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../app/src/main/assets/www/core.js');

const allowed = Core.isAllowedHttpUrl;
assert.strictEqual(allowed('http://example.com/api'), false, 'public HTTP is blocked');
assert.strictEqual(allowed('http://10.2.3.4:11434/v1'), true, '10/8 LAN HTTP is allowed');
assert.strictEqual(allowed('http://172.20.1.2'), true, '172.16/12 LAN HTTP is allowed');
assert.strictEqual(allowed('http://192.168.1.8'), true, '192.168/16 LAN HTTP is allowed');
assert.strictEqual(allowed('http://169.254.3.4'), true, 'link-local HTTP is allowed');
assert.strictEqual(allowed('http://127.200.1.2'), true, '127/8 loopback HTTP is allowed');
assert.strictEqual(allowed('http://[::1]:8080'), true, 'IPv6 loopback HTTP is allowed');
assert.strictEqual(allowed('http://ollama.local:11434'), true, '.local HTTP is allowed');
assert.strictEqual(allowed('https://example.com/api'), true, 'HTTPS is allowed');
assert.strictEqual(allowed('http://172.32.0.1'), false, 'HTTP outside the private range is blocked');
assert.strictEqual(allowed('file:///etc/passwd'), false, 'non-HTTP(S) URLs are blocked');

// A redirect is safe only if its destination satisfies the same URL policy.
const redirectFrom = 'https://provider.example/v1';
const redirectTo = new URL('http://public.example/collect', redirectFrom).href;
assert.strictEqual(allowed(redirectFrom), true);
assert.strictEqual(allowed(redirectTo), false, 'HTTPS-to-public-HTTP redirect target is blocked');

const app = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/app.js'), 'utf8');
assert.match(app, /redirect:\s*'error'/, 'browser fetch must fail closed on redirects it cannot inspect');
assert.match(app, /function requireAllowedHttpUrl[\s\S]*C\.isAllowedHttpUrl/);
const worker = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/jsworker.js'), 'utf8');
assert.match(worker, /importScripts\('url-policy\.js'\)/);
assert.match(worker, /self\.UrlPolicy\.isAllowedHttpUrl/);
const java = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/cybnate/app/MainActivity.java'), 'utf8');
assert.match(java, /setInstanceFollowRedirects\(false\)/, 'native redirect handling must stay manual');
assert.match(java, /if \(!isAllowedHttpUrl\(next\)\)[\s\S]*Blocked redirect by cleartext policy/);
console.log('PASS public HTTP blocked');
console.log('PASS LAN and local HTTP allowed');
console.log('PASS HTTPS allowed');
console.log('PASS HTTPS-to-public-HTTP redirect blocked in JS and native paths');
