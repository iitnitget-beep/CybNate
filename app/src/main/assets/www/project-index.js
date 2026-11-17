/* Read-only project inventory. Never executes project files or follows filesystem links. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectIndex = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = { maxFiles: 5000, maxFileBytes: 256 * 1024, maxTotalBytes: 2 * 1024 * 1024 };
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'build', 'dist', '.gradle', '.idea', '.next', 'target', 'coverage']);
  const LANGUAGES = [
    [/\.(?:js|jsx|mjs|cjs)$/i, 'javascript'], [/\.(?:ts|tsx)$/i, 'typescript'],
    [/\.kt$/i, 'kotlin'], [/\.java$/i, 'java'], [/\.py$/i, 'python'],
    [/\.go$/i, 'go'], [/\.rs$/i, 'rust'], [/\.(?:c|h)$/i, 'c'],
    [/\.(?:cc|cpp|cxx|hpp)$/i, 'cpp'], [/\.swift$/i, 'swift'],
    [/\.dart$/i, 'dart'], [/\.rb$/i, 'ruby'], [/\.php$/i, 'php'],
    [/\.sql$/i, 'sql'], [/\.html?$/i, 'html'], [/\.css$/i, 'css'],
    [/\.(?:json|jsonc)$/i, 'json'], [/\.ya?ml$/i, 'yaml'], [/\.xml$/i, 'xml'],
    [/\.md$/i, 'markdown'], [/\.(?:sh|bash)$/i, 'shell']
  ];

  function safePath(input) {
    if (typeof input !== 'string' || !input || input.indexOf('\0') >= 0) return null;
    const path = input.replace(/\\/g, '/');
    if (path.startsWith('/') || /^[a-z]:\//i.test(path)) return null;
    const parts = path.split('/');
    if (parts.some((p) => p === '..' || p === '')) return null;
    if (parts.some((p) => SKIP_DIRS.has(p.toLowerCase()))) return null;
    return parts.join('/');
  }

  function languageOf(path) {
    for (const [pattern, language] of LANGUAGES) if (pattern.test(path)) return language;
    return 'other';
  }

  function buildInventory(entries, options) {
    const limits = Object.assign({}, DEFAULTS, options || {});
    const result = { files: [], languages: {}, manifests: [], entryPoints: [], testCommands: [], warnings: [], truncated: false, totals: { files: 0, bytes: 0 } };
    if (!Array.isArray(entries)) throw new TypeError('entries must be an array');

    for (const entry of entries) {
      if (result.totals.files >= limits.maxFiles) { result.truncated = true; break; }
      if (!entry || typeof entry !== 'object') { result.warnings.push('Skipped an invalid entry'); continue; }
      const path = safePath(entry.path);
      if (!path) { result.warnings.push('Skipped an unsafe or excluded path'); continue; }
      const content = typeof entry.content === 'string' ? entry.content : '';
      const bytes = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0
        ? entry.size : (typeof Buffer !== 'undefined' ? Buffer.byteLength(content, 'utf8') : new TextEncoder().encode(content).length);
      if (bytes > limits.maxFileBytes) { result.warnings.push('Skipped oversized file: ' + path); continue; }
      if (result.totals.bytes + bytes > limits.maxTotalBytes) { result.truncated = true; break; }

      const language = languageOf(path);
      const record = { path, language, size: bytes };
      result.files.push(record);
      result.totals.files++;
      result.totals.bytes += bytes;
      result.languages[language] = (result.languages[language] || 0) + 1;

      if (/^(package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pom\.xml)$/i.test(path)) {
        result.manifests.push(path);
      }
      if (/^(?:src\/)?(?:main|index|app)\.(?:js|jsx|ts|tsx|py|kt|java)$/i.test(path) || /^(?:src\/)?main\.py$/i.test(path)) {
        result.entryPoints.push(path);
      }
      if (path === 'package.json' && content) {
        try {
          const pkg = JSON.parse(content);
          const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
          Object.keys(scripts).filter((key) => /^(test|check|lint|typecheck|verify)(:.*)?$/i.test(key))
            .sort().forEach((key) => result.testCommands.push({ source: path, name: key, command: String(scripts[key]).slice(0, 240) }));
        } catch (_) { result.warnings.push('Could not parse package.json'); }
      }
    }
    result.files.sort((a, b) => a.path.localeCompare(b.path));
    result.manifests.sort();
    result.entryPoints = Array.from(new Set(result.entryPoints)).sort();
    return result;
  }

  return { buildInventory, safePath, languageOf, DEFAULTS };
});
