'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'app', 'google-services.json');
assert.ok(fs.existsSync(configPath), 'app/google-services.json must exist');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert.equal(config.project_info.project_id, 'cybnate-ced02');
assert.equal(String(config.project_info.project_number), '817862544');
assert.equal(config.client.length, 1, 'expected the registered CybNate Android app');
assert.equal(config.client[0].client_info.android_client_info.package_name, 'com.cybnate.app');
assert.equal(config.client[0].client_info.mobilesdk_app_id, '1:817862544:android:87d8da99c6e63f55f74515');

const rootGradle = fs.readFileSync(path.join(root, 'build.gradle'), 'utf8');
const appGradle = fs.readFileSync(path.join(root, 'app', 'build.gradle'), 'utf8');
assert.match(rootGradle, /com\.google\.gms\.google-services['"]\s+version\s+['"]4\.6\.0/);
assert.match(appGradle, /id ['"]com\.google\.gms\.google-services['"]/);
assert.match(appGradle, /firebase-bom:35\.2\.0/);
for (const module of ['firebase-auth', 'firebase-firestore', 'firebase-storage', 'firebase-messaging']) {
  assert.ok(appGradle.includes(`com.google.firebase:${module}`), `missing ${module} dependency`);
}
assert.match(appGradle, /namespace ['"]com\.cybnate\.app['"]/);
assert.match(appGradle, /applicationId ['"]com\.cybnate\.app['"]/);
console.log('Firebase config OK: project, Android app ID, package name and Gradle SDK wiring match.');
