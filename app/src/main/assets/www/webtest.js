/*
 * test_webapp: load a workspace page off-screen, watch it, optionally drive it with a test script, and report.
 * This file only builds the instrumented page and formats the report; where the page runs is up to the caller
 * (a bridge-free WebView in the Android app, a sandboxed iframe in a browser).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebTest = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Runs inside the page under test. Kept free of template literals and arrow functions on purpose (old WebViews). */
  function harness(CFG) {
    var logs = [], errors = [], t0 = Date.now(), started = false;
    function str(v) { try { if (v instanceof Error) return v.message || String(v); if (typeof v === 'object' && v !== null) return JSON.stringify(v); return String(v); } catch (e) { return String(v); } }
    function add(level, args) { if (logs.length < 80) logs.push({ l: level, t: Array.prototype.map.call(args, str).join(' ').slice(0, 500) }); }
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (k) { var o = console[k]; console[k] = function () { add(k, arguments); try { if (o) o.apply(console, arguments); } catch (e) { /* console not usable */ } }; });
    window.addEventListener('error', function (e) {
      var t = e.target;
      if (t && t !== window && t.tagName && (t.src || t.href)) errors.push('Failed to load <' + t.tagName.toLowerCase() + '>: ' + String(t.src || t.href).slice(0, 200));
      else {
        var ln = e.lineno; if (ln > CFG.off && CFG.off) ln -= CFG.off; /* browsers count lines of the whole document, harness included */
        errors.push((e.message || 'Script error') + (ln ? ' (line ' + ln + (e.colno ? ':' + e.colno : '') + ')' : ''));
      }
    }, true);
    window.addEventListener('unhandledrejection', function (e) { errors.push('Unhandled promise rejection: ' + str(e.reason)); });
    function describe(el) { return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''); }
    function report(test) {
      var d = document, body = d.body, issues = [], vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      // Android zooms an overflowing page out, which makes innerWidth grow. The screen width is the real limit.
      var sw = (window.screen && window.screen.width) || 0; if (sw && vw > sw + 1) { vh = Math.round(vh * sw / vw); vw = sw; }
      var all = body ? body.getElementsByTagName('*') : [], q = function (s) { return d.querySelectorAll(s).length; };
      var text = body ? String(body.innerText != null ? body.innerText : body.textContent || '') : '';
      text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      try {
        var de = d.documentElement;
        if (vw && de.scrollWidth > vw + 1) {
          var wide = [];
          for (var i = 0; i < all.length && i < 2000 && wide.length < 4; i++) { var r = all[i].getBoundingClientRect(); if (r.width > 0 && r.right > vw + 1 && !all[i].querySelector('*')) wide.push(describe(all[i]) + ' (right edge at ' + Math.round(r.right) + ' px)'); }
          issues.push('Horizontal overflow: the page is ' + de.scrollWidth + ' px wide in a ' + vw + ' px viewport' + (wide.length ? '. Widest elements: ' + wide.join(', ') : ''));
        }
        var broken = []; Array.prototype.forEach.call(d.images || [], function (im) { if (im.complete && im.naturalWidth === 0 && im.getAttribute('src')) broken.push(String(im.getAttribute('src')).slice(0, 80)); });
        if (broken.length) issues.push(broken.length + ' image(s) did not load: ' + broken.slice(0, 4).join(', '));
        if (!text && !q('canvas,img,svg,video,iframe,input,button')) issues.push('The page shows nothing: the body has no visible text or media');
        if (!d.querySelector('meta[name="viewport"]')) issues.push('No <meta name="viewport">: the page will look zoomed out on phones');
        var small = [];
        Array.prototype.forEach.call(d.querySelectorAll('button,a[href],input[type=checkbox],input[type=radio],select'), function (el) { var r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24) && small.length < 20) small.push(describe(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); });
        if (small.length) issues.push(small.length + ' tap target(s) smaller than 24 px: ' + small.slice(0, 3).join(', '));
      } catch (e) { issues.push('layout check failed: ' + str(e)); }
      return JSON.stringify({ title: d.title || '', ms: Date.now() - t0, viewport: vw + 'x' + vh, text: text.slice(0, 1500), textMore: Math.max(0, text.length - 1500),
        counts: { elements: all.length, buttons: q('button,input[type=button],input[type=submit]'), inputs: q('input:not([type=button]):not([type=submit]),textarea,select'), links: q('a[href]'), images: q('img'), forms: q('form'), canvases: q('canvas') },
        errors: errors.slice(0, 30), logs: logs, issues: issues, test: test });
    }
    window.__cybPartial = function () { return report({ ran: !!CFG.script, ok: false, error: 'timed out: the page or the test script did not finish in time' }); };
    function finish(test) { var r = report(test); window.__cybResult = r; try { if (window.parent && window.parent !== window) window.parent.postMessage({ cybTest: CFG.id, report: r }, '*'); } catch (e) { /* no parent */ } }
    function runTest() {
      if (!CFG.script) return Promise.resolve(undefined);
      var $ = function (s) { var el = document.querySelector(s); if (!el) throw new Error('No element matches ' + s); return el; };
      var api = {
        assert: function (c, m) { if (!c) throw new Error('Assertion failed' + (m ? ': ' + m : '')); },
        $: $, $$: function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); },
        click: function (s) { var el = typeof s === 'string' ? $(s) : s; el.click(); return el; },
        type: function (s, v) { var el = typeof s === 'string' ? $(s) : s; el.focus && el.focus(); el.value = v; ['input', 'change'].forEach(function (n) { el.dispatchEvent(new Event(n, { bubbles: true })); }); return el; },
        press: function (s, key) { var el = typeof s === 'string' ? $(s) : s; ['keydown', 'keypress', 'keyup'].forEach(function (n) { el.dispatchEvent(new KeyboardEvent(n, { key: key, bubbles: true })); }); return el; },
        submit: function (s) { var f = typeof s === 'string' ? $(s) : s; if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); },
        text: function (s) { var el = s ? $(s) : document.body; return String(el.innerText != null ? el.innerText : el.textContent || '').trim(); },
        wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
        waitFor: function (s, ms) { var end = Date.now() + (ms || 2000); return new Promise(function (res, rej) { (function tick() { var el = typeof s === 'function' ? s() : document.querySelector(s); if (el) return res(el); if (Date.now() > end) return rej(new Error('Timed out waiting for ' + s)); setTimeout(tick, 50); })(); }); },
      };
      var names = Object.keys(api), fn;
      try { fn = new Function(names.join(','), 'return (async function () {\n' + CFG.script + '\n})()'); } catch (e) { return Promise.reject(new Error('The test script has a syntax error: ' + str(e))); }
      try { return Promise.resolve(fn.apply(null, names.map(function (n) { return api[n]; }))); } catch (e) { return Promise.reject(e); }
    }
    function start() {
      if (started) return; started = true;
      setTimeout(function () {
        runTest().then(function (v) { finish({ ran: !!CFG.script, ok: true, value: v === undefined ? null : str(v) }); }, function (e) { finish({ ran: true, ok: false, error: str(e) }); });
      }, CFG.wait);
    }
    if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
    setTimeout(start, 4000); // a resource that never finishes loading must not hang the test
  }

  /** The page with the harness as its first script. `script` is the optional test; `waitMs` the settle time after load. */
  function instrument(html, script, waitMs, id) {
    const cfg = JSON.stringify({ script: script || '', wait: waitMs == null ? 600 : waitMs, id: id || '', off: harness.toString().split('\n').length - 1 }).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
    const tag = '<script>(' + harness.toString() + ')(' + cfg + ');</' + 'script>';
    html = String(html == null ? '' : html);
    const m = /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
    return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html;
  }

  /** Text for the agent and an exit code: 0 = loaded without errors and the test (if any) passed. */
  function format(rep, path) {
    if (typeof rep === 'string') { try { rep = JSON.parse(rep); } catch (e) { rep = null; } }
    if (!rep || rep.error) return { code: 1, out: 'test_webapp ' + path + ': no report came back from the page' + (rep && rep.error ? ' (' + rep.error + ')' : '. The page may have navigated away or stopped the script engine.') };
    const c = rep.counts || {}, t = rep.test || {};
    const L = ['Page: ' + path + '  (viewport ' + rep.viewport + ', ' + (rep.ms / 1000).toFixed(1) + ' s)', 'Title: ' + (rep.title || '(none)'),
      'Elements: ' + c.elements + ' (' + c.buttons + ' buttons, ' + c.inputs + ' inputs, ' + c.links + ' links, ' + c.images + ' images' + (c.canvases ? ', ' + c.canvases + ' canvas' : '') + ')'];
    L.push(rep.errors.length ? 'Runtime errors (' + rep.errors.length + '):\n' + rep.errors.map((e) => '  ✗ ' + e).join('\n') : 'Runtime errors: none');
    L.push(rep.logs.length ? 'Console (' + rep.logs.length + '):\n' + rep.logs.slice(0, 40).map((l) => '  [' + l.l + '] ' + l.t).join('\n') : 'Console: empty');
    L.push(rep.issues.length ? 'Layout issues (' + rep.issues.length + '):\n' + rep.issues.map((i) => '  ! ' + i).join('\n') : 'Layout issues: none found');
    L.push('Visible text:\n' + (rep.text ? rep.text.split('\n').map((l) => '  ' + l).join('\n') + (rep.textMore ? '\n  … ' + rep.textMore + ' more characters' : '') : '  (none)'));
    L.push(!t.ran ? 'Test script: none given (only loading was checked)' : t.ok ? 'Test script: PASSED' + (t.value != null ? ' (returned ' + t.value + ')' : '') : 'Test script: FAILED: ' + t.error);
    const bad = rep.errors.length > 0 || (t.ran && !t.ok) || (!t.ran && t.ok === false);
    return { code: bad ? 1 : 0, out: L.join('\n') };
  }

  return { instrument, format, harness };
});
