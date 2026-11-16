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
  const SERIAL_EXT = /\.(?:js|jsx|ts|tsx|css|json)$/i;
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
  function resolveEntry(files, requested, html) {
    const keys = Object.keys(files).map(cleanPath);
    const exists = (p) => keys.indexOf(cleanPath(p)) >= 0;
    const src = String(html || '');
    const ref = /<script\b[^>]*\bsrc=["']([^"']+\.(?:jsx?|tsx?))["'][^>]*>/i.exec(src);
    if (ref) {
      const fromHtml = cleanPath(ref[1].replace(/^(?:\.\/|\/)+/, ''));
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
    all.delete('react'); all.delete('react-dom'); all.delete('react-dom/client'); all.delete('react/jsx-runtime'); all.delete('react-native');
    return Array.from(all).sort();
  }
  function importMap(files) {
    const imports = {
      react: 'https://esm.sh/react@18.3.1',
      'react/jsx-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
      'react/jsx-dev-runtime': 'https://esm.sh/react@18.3.1/jsx-dev-runtime',
      'react-dom': 'https://esm.sh/react-dom@18.3.1?external=react',
      'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client?external=react',
      'react-native': 'https://esm.sh/react-native-web?external=react,react-dom',
      'react-native-web': 'https://esm.sh/react-native-web?external=react,react-dom',
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
  function projectHtml(requested, sourceFiles, babelSource) {
    const files = {};
    const input = values(sourceFiles);
    Object.keys(input).forEach((p) => {
      const clean = cleanPath(p), v = input[p];
      if (clean.split('/').some((part) => part === 'node_modules' || part === '.git') || /(?:package-lock|npm-shrinkwrap)\.json$/i.test(clean)) return;
      if (SERIAL_EXT.test(clean) && typeof v === 'string') files[clean] = v;
    });
    const htmlPath = (requested && /\.html?$/i.test(requested) && files[cleanPath(requested)]) ? cleanPath(requested) : (files['index.html'] ? 'index.html' : '');
    const template = htmlPath ? files[htmlPath] : '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CybNate Preview</title></head><body></body></html>';
    const entry = resolveEntry(files, requested, template);
    const apiPath = serverEntry(files);
    const project = { entry, files, apiPath, importMap: importMap(files), tailwind: tailwindNeeded(files), cssImports: cssImports(files) };
    let html = template.replace(/<script\b[^>]*\bsrc=["'][^"']+\.(?:jsx?|tsx?)(?:[?#][^"']*)?["'][^>]*>\s*<\/script\s*>/gi, '');
    if (!/<(?:div|main|section)\b[^>]*\bid=["'](?:root|app)["']/i.test(html)) html = inject(html, '<div id="root"></div>', 'body');
    const safeMap = safeJson(project.importMap).replace(/<\/script/gi, '<\\/script');
    html = inject(html, '<script type="importmap">' + safeMap + '</script>', 'head');
    const overlay = '<script>window.__cybPreviewError=function(e){var d=document.getElementById("__cyb-preview-error");if(!d){d=document.createElement("pre");d.id="__cyb-preview-error";d.style.cssText="position:fixed;z-index:2147483647;inset:8px;overflow:auto;margin:0;padding:14px;background:#190b10;color:#ffd7df;border:1px solid #a33;border-radius:8px;white-space:pre-wrap;font:13px/1.5 monospace";(document.body||document.documentElement).appendChild(d)}d.textContent="Preview error\\n"+String(e&&e.stack||e||"Unknown error")};window.addEventListener("error",function(e){if(e.message||e.error)window.__cybPreviewError(e.error||e.message)});window.addEventListener("unhandledrejection",function(e){window.__cybPreviewError(e.reason)});</script>';
    html = inject(html, overlay, 'head');
    if (babelSource) html = inject(html, '<script>' + String(babelSource).replace(/<\/script/gi, '<\\/script') + '</script>', 'head');
    else html = inject(html, '<script src="https://unpkg.com/@babel/standalone@8.1.2/babel.min.js" onerror="window.__cybPreviewError(\'Could not load Babel compiler; connect to the internet or rebuild with the bundled vendor asset.\')"></script>', 'head');
    if (project.tailwind && !/cdn\.tailwindcss\.com/i.test(html)) html = inject(html, '<script src="https://cdn.tailwindcss.com"></script>', 'head');
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
async function moduleUrl(path,stack){path=norm(path);if(compiled[path])return compiled[path];if(pending[path])throw new Error("Circular local imports are not supported in preview: "+stack.concat(path).join(" -> "));if(!Object.prototype.hasOwnProperty.call(F,path))throw new Error("Preview source file is missing: "+path);if(/\.css$/i.test(path)){setCss(path);return null}if(/\.json$/i.test(path)){var j="export default "+JSON.stringify(JSON.parse(F[path]))+";";var ju=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));made.push(ju);compiled[path]=ju;return ju}pending[path]=true;var src=String(F[path]),ext=(path.split(".").pop()||"").toLowerCase(),presets=[["react",{runtime:"automatic"}]];if(ext==="ts"||ext==="tsx")presets.push(["typescript",{allExtensions:true,isTSX:ext==="tsx"}]);var out=Babel.transform(src,{filename:path,sourceType:"module",presets:presets,sourceMaps:false}).code;var refs=importMatches(out);for(var i=refs.length-1;i>=0;i--){var r=refs[i],s=r.spec;if(s.charAt(0)==="."||s.charAt(0)==="/"){var target=resolve(path,s);if(/\.css(?:[?#].*)?$/i.test(s)){setCss(target);out=out.slice(0,r.at)+out.slice(r.at+r.full.length)}else{var url=await moduleUrl(target,stack.concat(path));var replaced=r.full.replace(r.q+s+r.q,JSON.stringify(url));out=out.slice(0,r.at)+replaced+out.slice(r.at+r.full.length)}}}delete pending[path];var u=URL.createObjectURL(new Blob([out],{type:"text/javascript"}));made.push(u);compiled[path]=u;return u}
function routePattern(pattern,path){var names=[],special=".*+?^$()|[]{}\\",parts=String(pattern||"/").split("/").map(function(s){if(s.charAt(0)===":"){names.push(s.slice(1));return "([^/]+)"}return s.split("").map(function(c){return special.indexOf(c)>=0?"\\"+c:c}).join("")});var m=new RegExp("^"+parts.join("/")+"/?$").exec(path);if(!m)return null;var o={};names.forEach(function(n,i){try{o[n]=decodeURIComponent(m[i+1])}catch(e){o[n]=m[i+1]}});return o}
function expressFactory(){var app={_routes:[],_middlewares:[],use:function(fn){if(typeof fn==="function")this._middlewares.push(fn);return this},get:function(p,h){return add(this,"GET",p,h)},post:function(p,h){return add(this,"POST",p,h)},put:function(p,h){return add(this,"PUT",p,h)},delete:function(p,h){return add(this,"DELETE",p,h)},patch:function(p,h){return add(this,"PATCH",p,h)},listen:function(){window.__cybPreviewApiRoutes=this._routes.map(function(r){return r.method+" "+r.path});return {close:function(cb){if(cb)cb()}}}};function add(a,m,p,h){if(typeof p==="function"){h=p;p="/"}if(typeof h!=="function")throw new Error("Express route "+m+" "+p+" has no handler");a._routes.push({method:m,path:String(p),handler:h});return a}window.__cybPreviewApps.push(app);return app}
expressFactory.json=function(){return function(req,res,next){if(next)next()}};
function runApi(){if(!P.apiPath)return;var src=F[P.apiPath];if(!src)return;var code=Babel.transform(String(src),{filename:P.apiPath,sourceType:"unambiguous",presets:[["env",{modules:"commonjs"}]]}).code;var mod={exports:{}};function req(n){if(n==="express")return expressFactory;if(n==="cors"||n==="body-parser")return function(){return function(q,s,next){if(next)next()}};throw new Error("Virtual API supports express (and json/cors middleware) only; unsupported require: "+n)}var proc={env:{NODE_ENV:"development",PORT:"3000"},platform:"browser"};new Function("require","module","exports","process","console",code+"\n//# sourceURL="+P.apiPath)(req,mod,mod.exports,proc,console);var app=mod.exports&&mod.exports._routes?mod.exports:(window.__cybPreviewApiRoutes?null:null);if(!window.__cybPreviewApiRoutes){var all=window.__cybPreviewApps||[];window.__cybPreviewApiRoutes=all.reduce(function(a,x){return a.concat(x._routes.map(function(r){return r.method+" "+r.path}))},[])}window.__cybPreviewApiReady=true;console.info("Virtual Express ready; routes: "+(window.__cybPreviewApiRoutes.length?window.__cybPreviewApiRoutes.join(", "):"none registered"))}
window.__cybPreviewApps=[];var RealFetch=window.fetch.bind(window);
window.fetch=function(input,init){init=init||{};var raw=typeof input==="string"?input:(input&&input.url)||String(input),u;try{u=new URL(raw,location.href)}catch(e){return Promise.reject(e)}var apiPath=u.pathname,local=/^https?:$/.test(u.protocol)&&/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);if(!P.apiPath||(!local&&!/^\/api(?:\/|$)/.test(apiPath)))return RealFetch(input,init);return virtualFetch(u,init,input)};
async function virtualFetch(u,init,input){if(!window.__cybPreviewApiReady)runApi();var method=String(init.method||(input&&input.method)||"GET").toUpperCase(),path=u.pathname,route=null,params=null;for(var i=0;i<window.__cybPreviewApps.length&&!route;i++){var app=window.__cybPreviewApps[i];for(var j=0;j<app._routes.length;j++){var r=app._routes[j],m=routePattern(r.path,path);if(r.method===method&&m){route=r;params=m;break}}}if(!route)return new Response(JSON.stringify({error:"Not found",path:path}),{status:404,headers:{"Content-Type":"application/json"}});var query={};u.searchParams.forEach(function(v,k){query[k]=v});var headers=new Headers(init.headers||(input&&input.headers)||{}),rawBody=init.body,body=null;if(rawBody==null&&input&&typeof input.clone==="function"){try{rawBody=await input.clone().text()}catch(e){}}if(rawBody!=null){if(headers.get("content-type")&&headers.get("content-type").indexOf("application/json")>=0){try{body=typeof rawBody==="string"?JSON.parse(rawBody):rawBody}catch(e){return new Response(JSON.stringify({error:"Invalid JSON body"}),{status:400,headers:{"Content-Type":"application/json"}})}}else body=rawBody}var req={method:method,url:u.pathname+u.search,path:path,originalUrl:u.pathname+u.search,params:params,query:query,body:body,headers:Object.fromEntries(headers.entries())};return new Promise(function(resolve){var status=200,done=false,res={status:function(s){status=Number(s)||200;return res},set:function(k,v){headers.set(k,v);return res},header:function(k,v){return res.set(k,v)},json:function(v){if(done)return;done=true;headers.set("Content-Type","application/json");resolve(new Response(JSON.stringify(v),{status:status,headers:headers}));return res},send:function(v){if(done)return;done=true;if(typeof v==="object"&&v!==null){headers.set("Content-Type","application/json");v=JSON.stringify(v)}resolve(new Response(v==null?"":String(v),{status:status,headers:headers}));return res},end:function(v){if(done)return;done=true;resolve(new Response(v==null?null:String(v),{status:status,headers:headers}))}};try{var x=route.handler(req,res,function(e){if(e)throw e});if(x&&typeof x.then==="function")x.catch(function(e){if(!done){done=true;resolve(new Response(JSON.stringify({error:String(e&&e.message||e)}),{status:500,headers:{"Content-Type":"application/json"}}))}});else if(!done)resolve(new Response(null,{status:204}))}catch(e){console.error(e);if(!done)resolve(new Response(JSON.stringify({error:String(e&&e.message||e)}),{status:500,headers:{"Content-Type":"application/json"}}))}})}
function mount(mod){var root=document.getElementById("root")||document.getElementById("app");if(!root)throw new Error("Preview HTML has no #root mount");if(root.childNodes.length)return;var App=mod&&(mod.default||mod.App);if(!App)return;import("react-dom/client").then(function(R){R.createRoot(root).render(typeof App==="function"?R.createElement(App):App)})}
window.__cybPreviewStart=(async function(){if(!window.Babel)throw new Error("Babel compiler is unavailable");if(P.apiPath)runApi();if(!P.entry)throw new Error("No React/JavaScript entry file found. Expected src/main.jsx, src/index.jsx, App.jsx, or an equivalent project entry.");var u=await moduleUrl(P.entry,[]),mod=await import(u),root=document.getElementById("root")||document.getElementById("app");if(root&&!root.childNodes.length)mount(mod);try{var rn=await import("react-native"),keys=rn.AppRegistry&&rn.AppRegistry.getAppKeys?rn.AppRegistry.getAppKeys():[];if(keys.length&&root&&!root.childNodes.length)rn.AppRegistry.runApplication(keys[0],{rootTag:root})}catch(e){if(/Failed to resolve module specifier|imported module/.test(String(e)))throw e}return true})().catch(err);window.addEventListener("beforeunload",function(){made.forEach(function(u){try{URL.revokeObjectURL(u)}catch(e){}})});`;

  return { isProject, resolveEntry, bareSpecifiers, importMap, projectHtml, safeJson, tailwindNeeded, SERVER_ORDER, BOOTSTRAP };
});
