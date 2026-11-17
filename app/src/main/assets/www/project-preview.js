/*
 * Browser-side builder for isolated React / React Native Web project previews.
 * This does not create a Node server: Express-style routes are handled in-memory inside the preview WebView.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectPreview = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CODE_EXT = /\.(?:js|jsx|ts|tsx)$/i;
  const SERIAL_EXT = /\.(?:html?|js|jsx|ts|tsx|css|json)$/i;
  const ENTRY_ORDER = ['src/main.jsx', 'src/main.tsx', 'src/index.jsx', 'src/index.tsx', 'src/main.js', 'src/main.ts', 'src/index.js', 'src/index.ts', 'src/App.jsx', 'src/App.tsx', 'App.jsx', 'App.tsx', 'App.js', 'App.ts'];
  const SERVER_ORDER = ['server.js', 'backend/server.js', 'api/server.js'];
  const IMPORT_RE = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s*)?(['"])([^'"\n]+)\1\s*;?/g;
  const BARE_RE = /^(?:@[^/]+\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

  function cleanPath(p) {
    const a = [];
    String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').forEach((s) => { if (!s || s === '.') return; if (s === '..') a.pop(); else a.push(s); });
    return a.join('/');
  }
  function values(files) { return files instanceof Map ? Object.fromEntries(files.entries()) : (files || {}); }
  function hasImport(text) { IMPORT_RE.lastIndex = 0; return IMPORT_RE.test(String(text || '')); }
  function isProject(files) {
    files = values(files);
    if (Object.keys(files).some((p) => /\.(?:jsx|tsx)$/i.test(p) || (CODE_EXT.test(p) && hasImport(typeof files[p] === 'string' ? files[p] : '')))) return true;
    return Object.keys(files).some((p) => /(^|\/)package\.json$/i.test(p) && typeof files[p] === 'string' && /\"(?:react|react-dom|react-native|react-native-web)\"\s*:/.test(files[p]));
  }
  function isReactProject(files) {
    files = values(files);
    return Object.keys(files).some((p) => /\.(?:jsx|tsx)$/i.test(p) || (CODE_EXT.test(p) && /(?:from\s*|import\s*)['\"](?:react|react-dom|react-native|react-native-web)(?:\/|['\"])/.test(String(files[p] || '')))) || Object.keys(files).some((p) => /(^|\/)package\.json$/i.test(p) && typeof files[p] === 'string' && /\"(?:react|react-dom|react-native|react-native-web)\"\s*:/.test(files[p]));
  }
  function resolveEntry(files, requested, html) {
    const keys = Object.keys(files).map(cleanPath);
    const exists = (p) => keys.indexOf(cleanPath(p)) >= 0;
    const src = String(html || '');
    const ref = /<script\b[^>]*\bsrc=["']([^"']+\.(?:jsx?|tsx?))["'][^>]*>/i.exec(src);
    if (ref) {
      const raw = ref[1];
      const htmlDir = requested && /\.html?$/i.test(requested) ? cleanPath(requested).split('/').slice(0, -1).join('/') : '';
      const fromHtml = cleanPath(raw.startsWith('/') ? raw : (htmlDir ? htmlDir + '/' : '') + raw);
      if (exists(fromHtml)) return fromHtml;
    }
    if (requested && CODE_EXT.test(requested) && exists(requested)) return cleanPath(requested);
    const found = ENTRY_ORDER.find(exists);
    if (found) return found;
    return keys.filter((p) => CODE_EXT.test(p)).sort()[0] || '';
  }
  function bareSpecifiers(files) {
    files = values(files);
    const all = new Set();
    Object.keys(files).forEach((p) => {
      if (!CODE_EXT.test(p) || typeof files[p] !== 'string') return;
      IMPORT_RE.lastIndex = 0; let m;
      while ((m = IMPORT_RE.exec(files[p]))) {
        const s = m[2];
        if (BARE_RE.test(s) && !s.startsWith('.') && !s.startsWith('/')) all.add(s);
      }
    });
    Object.keys(files).forEach((p) => {
      if (!/(^|\/)package\.json$/i.test(p) || typeof files[p] !== 'string') return;
      try {
        const pkg = JSON.parse(files[p]);
        ['dependencies', 'devDependencies', 'peerDependencies'].forEach((k) => Object.keys(pkg[k] || {}).forEach((n) => { if (BARE_RE.test(n)) all.add(n); }));
      } catch (e) { /* malformed package.json is reported in the preview runtime */ }
    });
    all.delete('express');
    all.delete('react'); all.delete('react-dom'); all.delete('react-dom/client'); all.delete('react/jsx-runtime'); all.delete('react/jsx-dev-runtime'); all.delete('react-native'); all.delete('react-native-web');
    return Array.from(all).sort();
  }
  const RN_SHIM_SOURCE = String.raw`import React from 'react';
const h = React.createElement;
function flattenStyle(value, out) { out = out || {}; if (Array.isArray(value)) value.forEach(function (v) { flattenStyle(v, out); }); else if (value && typeof value === 'object') Object.keys(value).forEach(function (k) { out[k] = value[k]; }); return out; }
function styleOf(value, defaults) { var s = flattenStyle(value); if (defaults) s = Object.assign({}, defaults, s); if (s.marginHorizontal != null) { s.marginLeft = s.marginRight = s.marginHorizontal; delete s.marginHorizontal; } if (s.paddingHorizontal != null) { s.paddingLeft = s.paddingRight = s.paddingHorizontal; delete s.paddingHorizontal; } if (s.marginVertical != null) { s.marginTop = s.marginBottom = s.marginVertical; delete s.marginVertical; } if (s.paddingVertical != null) { s.paddingTop = s.paddingBottom = s.paddingVertical; delete s.paddingVertical; } delete s.elevation; delete s.shadowColor; delete s.shadowOffset; delete s.shadowOpacity; delete s.shadowRadius; return s; }
function propsOf(p, defaults) { var q = Object.assign({}, p); delete q.style; delete q.onPress; delete q.onPressIn; delete q.onPressOut; delete q.testID; delete q.accessibilityLabel; delete q.accessibilityRole; delete q.nativeID; delete q.hitSlop; q.style = styleOf(p.style, defaults); if (p.testID) q['data-testid'] = p.testID; if (p.nativeID) q.id = p.nativeID; if (p.accessibilityLabel) q['aria-label'] = p.accessibilityLabel; if (p.onPress) q.onClick = p.onPress; if (p.onPressIn) q.onMouseDown = p.onPressIn; if (p.onPressOut) q.onMouseUp = p.onPressOut; return q; }
function View(p) { return h('div', propsOf(p, { display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }), p.children); }
function Text(p) { return h('span', propsOf(p, { whiteSpace: 'pre-wrap' }), p.children); }
function Pressable(p) { var q = propsOf(p, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }); q.type = 'button'; return h(p.as || 'button', q, p.children); }
function TextInput(p) { var q = propsOf(p, { boxSizing: 'border-box' }); q.type = p.secureTextEntry ? 'password' : (p.keyboardType === 'email-address' ? 'email' : p.keyboardType === 'numeric' || p.keyboardType === 'number-pad' ? 'number' : 'text'); q.onChange = function (e) { if (p.onChangeText) p.onChangeText(e.target.value); if (p.onChange) p.onChange(e); }; if (p.multiline) { delete q.type; return h('textarea', q); } return h('input', q); }
function ScrollView(p) { var q = propsOf(p, { display: 'flex', flexDirection: 'column', overflowY: 'auto', flexGrow: 1 }); return h('div', q, p.children); }
function FlatList(p) { var data = p.data || []; return h(View, propsOf(p, { flexGrow: 1 }), data.map(function (item, index) { var child = p.renderItem ? p.renderItem({ item: item, index: index, separators: {} }) : h(Text, null, String(item)); var key = p.keyExtractor ? p.keyExtractor(item, index) : (item && (item.key || item.id)) || index; return h(React.Fragment, { key: String(key) }, child); })); }
function SafeAreaView(p) { return h(View, Object.assign({}, p, { style: [ { paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }, p.style ] })); }
function Image(p) { var q = propsOf(p); q.src = p.source && (p.source.uri || p.source) || p.src; q.alt = p.accessibilityLabel || ''; return h('img', q); }
function ActivityIndicator(p) { return h('span', propsOf(p), p.hidesWhenStopped === false || p.animating !== false ? '◌' : null); }
function Button(p) { return h('button', propsOf({ disabled: p.disabled, onPress: p.onPress, accessibilityLabel: p.accessibilityLabel }, { cursor: p.disabled ? 'default' : 'pointer' }), p.title || p.children || ''); }
function StatusBar() { return null; }
const StyleSheet = { create: function (s) { return s; }, flatten: flattenStyle, compose: function (a, b) { return a && b ? [a, b] : a || b; }, absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, hairlineWidth: 1 };
const registry = Object.create(null);
const AppRegistry = { registerComponent: function (name, provider) { registry[name] = provider; return name; }, getAppKeys: function () { return Object.keys(registry); }, runApplication: function (name, options) { var get = registry[name]; if (!get) throw new Error('React Native app is not registered: ' + name); var Component = typeof get === 'function' ? get() : get; var target = options && options.rootTag || document.getElementById('root') || document.getElementById('app'); if (!target || !globalThis.ReactDOM || !globalThis.ReactDOM.createRoot) throw new Error('React Native preview root or ReactDOM runtime is unavailable'); globalThis.ReactDOM.createRoot(target).render(h(Component)); } };
const Dimensions = { get: function () { return { width: window.innerWidth || 360, height: window.innerHeight || 640, scale: window.devicePixelRatio || 1, fontScale: 1 }; }, addEventListener: function () { return { remove: function () {} }; } };
const Platform = { OS: 'web', Version: 1, select: function (choices) { return choices.web != null ? choices.web : choices.default; }, isTV: false, isTesting: false };
export { View, Text, Pressable, TouchableOpacity, TouchableHighlight, TextInput, ScrollView, FlatList, SafeAreaView, Image, ActivityIndicator, Button, StatusBar, StyleSheet, AppRegistry, Dimensions, Platform };
export default { View, Text, Pressable, TouchableOpacity, TouchableHighlight, TextInput, ScrollView, FlatList, SafeAreaView, Image, ActivityIndicator, Button, StatusBar, StyleSheet, AppRegistry, Dimensions, Platform };
function TouchableOpacity(p) { return h(Pressable, p); }
function TouchableHighlight(p) { return h(Pressable, p); }
`;
  const REACT_EXPORTS = ['Children','Component','Fragment','Profiler','PureComponent','StrictMode','Suspense','act','cloneElement','createContext','createElement','createFactory','createRef','forwardRef','isValidElement','lazy','memo','startTransition','useCallback','useContext','useDebugValue','useDeferredValue','useEffect','useId','useImperativeHandle','useInsertionEffect','useLayoutEffect','useMemo','useReducer','useRef','useState','useSyncExternalStore','useTransition'];
  function dataModule(source) { return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source); }
  function localReactImports() {
    const exports = REACT_EXPORTS.map((name) => 'export const ' + name + '=R.' + name + ';').join('');
    const jsx = 'const R=globalThis.React;export default R;' + exports;
    const jsxRuntime = 'const R=globalThis.React;export const Fragment=R.Fragment;export function jsx(t,p,k){return R.createElement(t,k==null?p:Object.assign({},p,{key:k}))}export const jsxs=jsx;export const jsxDEV=jsx;';
    const dom = 'const D=globalThis.ReactDOM;export default D;export const createPortal=(...a)=>D.createPortal(...a);export const flushSync=(...a)=>D.flushSync(...a);export const unstable_batchedUpdates=(...a)=>D.unstable_batchedUpdates(...a);export const version=D.version;';
    const client = 'const D=globalThis.ReactDOM;export const createRoot=D.createRoot.bind(D);export const hydrateRoot=D.hydrateRoot.bind(D);';
    return { react: dataModule(jsx), jsx: dataModule(jsxRuntime), dom: dataModule(dom), client: dataModule(client), rn: dataModule(RN_SHIM_SOURCE) };
  }
  function importMap(files) {
    const shims = localReactImports();
    const imports = {
      react: shims.react,
      'react/jsx-runtime': shims.jsx,
      'react/jsx-dev-runtime': shims.jsx,
      'react-dom': shims.dom,
      'react-dom/client': shims.client,
      'react-native': shims.rn,
      'react-native-web': shims.rn,
    };
    bareSpecifiers(files).forEach((s) => {
      // Keep package names as URL path segments; reject traversal and URL/query characters.
      if (s.split('/').some((part) => part === '..' || part === '.' || !/^(?:@[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)$/.test(part))) return;
      imports[s] = 'https://esm.sh/' + s + '?external=react,react-dom';
    });
    return { imports };
  }
  function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }
  function inject(html, tag, close) {
    const re = new RegExp('</' + close + '\\s*>', 'i');
    return re.test(html) ? html.replace(re, tag + '</' + close + '>') : html + tag;
  }
  function tailwindNeeded(files) {
    files = values(files);
    let manifest = '';
    try { manifest = Object.keys(files).filter((p) => /(^|\/)package\.json$/i.test(p)).map((p) => files[p]).join('\n'); } catch (e) { /* no-op */ }
    if (/"tailwindcss"\s*:/.test(manifest)) return true;
    return Object.keys(files).some((p) => CODE_EXT.test(p) && typeof files[p] === 'string' && /(?:className|class)\s*=\s*["'`][^"'`]*(?:\b(?:flex|grid|block|hidden|items-|justify-|bg-|text-|p-|px-|py-|m-|mt-|mb-|rounded|shadow|w-|h-|gap-|space-)[\w:[\]#/%.-]*)/i.test(files[p]));
  }
  function serverEntry(files) { return SERVER_ORDER.find((p) => typeof files[p] === 'string') || ''; }
  function cssImports(files) {
    const out = [];
    Object.keys(files).forEach((p) => {
      if (!CODE_EXT.test(p) || typeof files[p] !== 'string') return;
      IMPORT_RE.lastIndex = 0; let m;
      while ((m = IMPORT_RE.exec(files[p]))) if (/\.css(?:[?#].*)?$/i.test(m[2]) && (m[2].startsWith('.') || m[2].startsWith('/'))) out.push({ from: p, spec: m[2] });
    });
    return out;
  }
  function projectHtml(requested, sourceFiles, options) {
    options = options || {};
    const files = {};
    const input = values(sourceFiles);
    Object.keys(input).forEach((p) => {
      const clean = cleanPath(p), v = input[p];
      if (clean.split('/').some((part) => part === 'node_modules' || part === '.git') || /(?:package-lock|npm-shrinkwrap)\.json$/i.test(clean)) return;
      if (SERIAL_EXT.test(clean) && typeof v === 'string') files[clean] = v;
    });
    const htmlPath = requested && /\.html?$/i.test(requested) && typeof input[cleanPath(requested)] === 'string'
      ? cleanPath(requested)
      : (typeof input['index.html'] === 'string' ? 'index.html' : '');
    const template = htmlPath ? input[htmlPath] : '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CybNate Preview</title></head><body></body></html>';
    const entry = resolveEntry(files, requested, template);
    const apiPath = serverEntry(files);
    const project = { entry, files, apiPath, react: isReactProject(files), importMap: importMap(files), tailwind: tailwindNeeded(files), cssImports: cssImports(files) };
    let html = template.replace(/<script\b[^>]*\bsrc=["'][^"']+\.(?:jsx?|tsx?)(?:[?#][^"']*)?["'][^>]*>\s*<\/script\s*>/gi, '');
    if (!/<(?:div|main|section)\b[^>]*\bid=["'](?:root|app)["']/i.test(html)) html = inject(html, '<div id="root"></div>', 'body');
    const safeMap = safeJson(project.importMap).replace(/<\/script/gi, '<\\/script');
    html = inject(html, '<script type="importmap">' + safeMap + '</script>', 'head');
    const overlay = '<script>window.__cybPreviewError=function(e){var d=document.getElementById("__cyb-preview-error");if(!d){d=document.createElement("pre");d.id="__cyb-preview-error";d.style.cssText="position:fixed;z-index:2147483647;inset:8px;overflow:auto;margin:0;padding:14px;background:#190b10;color:#ffd7df;border:1px solid #a33;border-radius:8px;white-space:pre-wrap;font:13px/1.5 monospace";(document.body||document.documentElement).appendChild(d)}d.textContent="Preview error\\n"+String(e&&e.stack||e||"Unknown error");try{console.error("Preview error",e)}catch(x){}};window.addEventListener("error",function(e){if(e.target&&e.target.src)window.__cybPreviewError("Failed to load preview asset: "+e.target.src);else if(e.message||e.error)window.__cybPreviewError(e.error||e.message)});window.addEventListener("unhandledrejection",function(e){window.__cybPreviewError(e.reason)});</script>';
    html = inject(html, overlay, 'head');
    // Keep WebView loadDataWithBaseURL payloads small: vendor runtimes are served as local app assets,
    // not copied into the generated HTML or across the Android JavaScript bridge.
    let assetBase = options.assetBase || 'https://appassets.androidplatform.net/assets/www/vendor/';
    if (assetBase !== 'vendor/' && !/^https:\/\/appassets\.androidplatform\.net\/assets\/www\/vendor\/$/.test(assetBase)) assetBase = 'https://appassets.androidplatform.net/assets/www/vendor/';
    html = inject(html, '<script src="' + assetBase + 'react-runtime/react.production.min.js"></script><script src="' + assetBase + 'react-runtime/react-dom.production.min.js"></script><script src="' + assetBase + 'babel/babel.min.js"></script>', 'head');
    if (project.tailwind && options.testMode) html = inject(html, '<script>console.info("Tailwind CDN skipped for deterministic offline test_webapp run")</script>', 'head');
    else if (project.tailwind && !/cdn\.tailwindcss\.com/i.test(html)) html = inject(html, '<script async src="https://cdn.tailwindcss.com"></script>', 'head');
    const data = safeJson(project).replace(/<\/script/gi, '<\\/script');
    const launch = '<script>window.__CYB_PROJECT=' + data + ';</script><script>(function(){\n' + BOOTSTRAP + '\n})();</script>';
    html = inject(html, launch, 'body');
    return html;
  }

  const BOOTSTRAP = String.raw`var P=window.__CYB_PROJECT||{}, F=P.files||{}, made=[], styles={}, compiled={}, pending={};
function err(e){window.__cybPreviewError(e)}
function norm(p){var a=[];String(p||"").replace(/\\/g,"/").split("/").forEach(function(s){if(!s||s===".")return;if(s==="..")a.pop();else a.push(s)});return a.join("/")}
function resolve(from,spec){var base=spec.charAt(0)==="/"?norm(spec):norm(norm(from).split("/").slice(0,-1).concat(spec.split("/")).join("/"));var tries=[base,base+".jsx",base+".tsx",base+".js",base+".ts",base+".json",base+"/index.jsx",base+"/index.tsx",base+"/index.js",base+"/index.ts",base+"/index.json"];for(var i=0;i<tries.length;i++)if(Object.prototype.hasOwnProperty.call(F,tries[i]))return tries[i];throw new Error("Cannot resolve local import "+spec+" from "+from)}
function cssText(path){var s=String(F[path]||"").replace(/@tailwind\s+[^;]+;?/g,""),el=document.createElement("style");el.setAttribute("data-cyb-style",path);el.textContent=s;(document.head||document.documentElement).appendChild(el)}
function setCss(path){if(!styles[path]){styles[path]=true;cssText(path)}}
function importMatches(code){var re=/\b(?:import|export)\s+(?:[\s\S]*?\s+from\s*)?(['"])([^'"\n]+)\1\s*;?/g,a=[],m;while((m=re.exec(code)))a.push({full:m[0],q:m[1],spec:m[2],at:m.index});return a}
async function moduleUrl(path,stack){path=norm(path);if(compiled[path])return compiled[path];if(pending[path])throw new Error("Circular local imports are not supported in preview: "+stack.concat(path).join(" -> "));if(!Object.prototype.hasOwnProperty.call(F,path))throw new Error("Preview source file is missing: "+path);if(/\.css$/i.test(path)){setCss(path);return null}if(/\.json$/i.test(path)){var j="export default "+JSON.stringify(JSON.parse(F[path]))+";";var ju=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));made.push(ju);compiled[path]=ju;return ju}pending[path]=true;var src=String(F[path]),ext=(path.split(".").pop()||"").toLowerCase(),presets=[["react",{runtime:"automatic"}]];if(ext==="ts"||ext==="tsx")presets.push(["typescript",{allExtensions:true,isTSX:ext==="tsx"}]);var out=Babel.transform(src,{filename:path,sourceType:"module",presets:presets,sourceMaps:false}).code;var refs=importMatches(out);for(var i=refs.length-1;i>=0;i--){var r=refs[i],s=r.spec;if(s.charAt(0)==="."||s.charAt(0)==="/"){var target=resolve(path,s);if(/\.css(?:[?#].*)?$/i.test(s)){setCss(target);out=out.slice(0,r.at)+out.slice(r.at+r.full.length)}else{var url=await moduleUrl(target,stack.concat(path));var replaced=r.full.replace(r.q+s+r.q,JSON.stringify(url));out=out.slice(0,r.at)+replaced+out.slice(r.at+r.full.length)}}}delete pending[path];var u=URL.createObjectURL(new Blob([out+"\n//# sourceURL=cyb-preview-module:"+path],{type:"text/javascript"}));made.push(u);compiled[path]=u;return u}
function routePattern(pattern,path){var names=[],special=".*+?^$()|[]{}\\",parts=String(pattern||"/").split("/").map(function(s){if(s.charAt(0)===":"){names.push(s.slice(1));return "([^/]+)"}return s.split("").map(function(c){return special.indexOf(c)>=0?"\\"+c:c}).join("")});var m=new RegExp("^"+parts.join("/")+"/?$").exec(path);if(!m)return null;var o={};names.forEach(function(n,i){try{o[n]=decodeURIComponent(m[i+1])}catch(e){o[n]=m[i+1]}});return o}
function expressFactory(){var app={_routes:[],_middlewares:[],use:function(fn){if(typeof fn==="function")this._middlewares.push(fn);return this},get:function(p,h){return add(this,"GET",p,h)},post:function(p,h){return add(this,"POST",p,h)},put:function(p,h){return add(this,"PUT",p,h)},delete:function(p,h){return add(this,"DELETE",p,h)},patch:function(p,h){return add(this,"PATCH",p,h)},listen:function(){window.__cybPreviewApiRoutes=this._routes.map(function(r){return r.method+" "+r.path});return {close:function(cb){if(cb)cb()}}}};function add(a,m,p,h){if(typeof p==="function"){h=p;p="/"}if(typeof h!=="function")throw new Error("Express route "+m+" "+p+" has no handler");a._routes.push({method:m,path:String(p),handler:h});return a}window.__cybPreviewApps.push(app);return app}
expressFactory.json=function(){return function(req,res,next){if(next)next()}};
function runApi(){if(!P.apiPath)return;var src=F[P.apiPath];if(!src)return;var code=Babel.transform(String(src),{filename:P.apiPath,sourceType:"unambiguous",presets:[["env",{modules:"commonjs"}]]}).code;var mod={exports:{}};function req(n){if(n==="express")return expressFactory;if(n==="cors"||n==="body-parser")return function(){return function(q,s,next){if(next)next()}};throw new Error("Virtual API supports express (and json/cors middleware) only; unsupported require: "+n)}var proc={env:{NODE_ENV:"development",PORT:"3000"},platform:"browser"};new Function("require","module","exports","process","console",code+"\n//# sourceURL="+P.apiPath)(req,mod,mod.exports,proc,console);var app=mod.exports&&mod.exports._routes?mod.exports:(window.__cybPreviewApiRoutes?null:null);if(!window.__cybPreviewApiRoutes){var all=window.__cybPreviewApps||[];window.__cybPreviewApiRoutes=all.reduce(function(a,x){return a.concat(x._routes.map(function(r){return r.method+" "+r.path}))},[])}window.__cybPreviewApiReady=true;console.info("Virtual Express ready; routes: "+(window.__cybPreviewApiRoutes.length?window.__cybPreviewApiRoutes.join(", "):"none registered"))}
window.__cybPreviewApps=[];var RealFetch=window.fetch.bind(window);
window.fetch=function(input,init){init=init||{};var raw=typeof input==="string"?input:(input&&input.url)||String(input),u;try{u=new URL(raw,location.href)}catch(e){return Promise.reject(e)}var apiPath=u.pathname,local=/^https?:$/.test(u.protocol)&&/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);if(!P.apiPath||(!local&&!/^\/api(?:\/|$)/.test(apiPath)))return RealFetch(input,init);return virtualFetch(u,init,input)};
async function virtualFetch(u,init,input){if(!window.__cybPreviewApiReady)runApi();var method=String(init.method||(input&&input.method)||"GET").toUpperCase(),path=u.pathname,route=null,params=null;for(var i=0;i<window.__cybPreviewApps.length&&!route;i++){var app=window.__cybPreviewApps[i];for(var j=0;j<app._routes.length;j++){var r=app._routes[j],m=routePattern(r.path,path);if(r.method===method&&m){route=r;params=m;break}}}if(!route)return new Response(JSON.stringify({error:"Not found",path:path}),{status:404,headers:{"Content-Type":"application/json"}});var query={};u.searchParams.forEach(function(v,k){query[k]=v});var headers=new Headers(init.headers||(input&&input.headers)||{}),rawBody=init.body,body=null;if(rawBody==null&&input&&typeof input.clone==="function"){try{rawBody=await input.clone().text()}catch(e){}}if(rawBody!=null){if(headers.get("content-type")&&headers.get("content-type").indexOf("application/json")>=0){try{body=typeof rawBody==="string"?JSON.parse(rawBody):rawBody}catch(e){return new Response(JSON.stringify({error:"Invalid JSON body"}),{status:400,headers:{"Content-Type":"application/json"}})}}else body=rawBody}var req={method:method,url:u.pathname+u.search,path:path,originalUrl:u.pathname+u.search,params:params,query:query,body:body,headers:Object.fromEntries(headers.entries())};return new Promise(function(resolve){var status=200,done=false,res={status:function(s){status=Number(s)||200;return res},set:function(k,v){headers.set(k,v);return res},header:function(k,v){return res.set(k,v)},json:function(v){if(done)return;done=true;headers.set("Content-Type","application/json");resolve(new Response(JSON.stringify(v),{status:status,headers:headers}));return res},send:function(v){if(done)return;done=true;if(typeof v==="object"&&v!==null){headers.set("Content-Type","application/json");v=JSON.stringify(v)}resolve(new Response(v==null?"":String(v),{status:status,headers:headers}));return res},end:function(v){if(done)return;done=true;resolve(new Response(v==null?null:String(v),{status:status,headers:headers}))}};try{var x=route.handler(req,res,function(e){if(e)throw e});if(x&&typeof x.then==="function")x.catch(function(e){if(!done){done=true;resolve(new Response(JSON.stringify({error:String(e&&e.message||e)}),{status:500,headers:{"Content-Type":"application/json"}}))}});else if(!done)resolve(new Response(null,{status:204}))}catch(e){console.error(e);if(!done)resolve(new Response(JSON.stringify({error:String(e&&e.message||e)}),{status:500,headers:{"Content-Type":"application/json"}}))}})}
function mount(mod){var root=document.getElementById("root")||document.getElementById("app");if(!root)throw new Error("Preview HTML has no #root mount");if(root.childNodes.length)return;var App=mod&&(mod.default||mod.App);if(!App)return;import("react-dom/client").then(function(R){R.createRoot(root).render(typeof App==="function"?R.createElement(App):App)})}
window.__cybPreviewStart=(async function(){if(!window.Babel)throw new Error("Babel compiler is unavailable");if(P.apiPath)runApi();if(!P.entry)throw new Error("No React/JavaScript entry file found. Expected src/main.jsx, src/index.jsx, App.jsx, or an equivalent project entry.");var u=await moduleUrl(P.entry,[]),mod=await import(u),root=document.getElementById("root")||document.getElementById("app");if(root&&!root.childNodes.length)mount(mod);try{var rn=await import("react-native"),keys=rn.AppRegistry&&rn.AppRegistry.getAppKeys?rn.AppRegistry.getAppKeys():[];if(keys.length&&root&&!root.childNodes.length)rn.AppRegistry.runApplication(keys[0],{rootTag:root})}catch(e){if(/Failed to resolve module specifier|imported module/.test(String(e)))throw e}return true})().catch(err);window.addEventListener("beforeunload",function(){made.forEach(function(u){try{URL.revokeObjectURL(u)}catch(e){}})});`;

  return { isProject, isReactProject, resolveEntry, bareSpecifiers, importMap, projectHtml, safeJson, tailwindNeeded, SERVER_ORDER, BOOTSTRAP };
});
