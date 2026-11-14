/* CybNate core: providers, agents, tool protocol, workspace, binary analysis.
 * No DOM access in this file so it can be unit-tested under Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- providers
  // Every provider speaks the OpenAI chat-completions protocol.
  const PROVIDERS = {
    pollinations: {
      name: 'Pollinations',
      tag: 'No key needed',
      needsKey: false,
      chatUrl: 'https://text.pollinations.ai/openai',
      modelsUrl: 'https://text.pollinations.ai/models',
      keyUrl: '',
      fallbackModels: ['openai-fast', 'openai'],
    },
    openrouter: {
      name: 'OpenRouter',
      tag: 'Free key · many free models',
      needsKey: true,
      chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
      modelsUrl: 'https://openrouter.ai/api/v1/models',
      keyUrl: 'https://openrouter.ai/keys',
      freeOnly: true,
      fallbackModels: ['openrouter/free', 'qwen/qwen3-coder:free', 'deepseek/deepseek-chat-v3.1:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    },
    groq: {
      name: 'Groq',
      tag: 'Free key · very fast',
      needsKey: true,
      chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
      modelsUrl: 'https://api.groq.com/openai/v1/models',
      keyUrl: 'https://console.groq.com/keys',
      fallbackModels: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct', 'llama-3.1-8b-instant'],
    },
    gemini: {
      name: 'Google Gemini',
      tag: 'Free key · large context',
      needsKey: true,
      chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
      keyUrl: 'https://aistudio.google.com/apikey',
      fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    },
    custom: {
      name: 'Custom',
      tag: 'Any OpenAI-compatible server (e.g. Ollama)',
      needsKey: false,
      custom: true,
      chatUrl: '',
      modelsUrl: '',
      keyUrl: '',
      fallbackModels: [],
    },
  };

  /** Normalise the many shapes a /models endpoint can return into a list of ids. */
  function parseModelList(json, provider) {
    let arr = Array.isArray(json) ? json : (json && (json.data || json.models)) || [];
    let ids = arr.map((m) => (typeof m === 'string' ? m : m.id || m.name || '')).filter(Boolean);
    ids = ids.map((id) => id.replace(/^models\//, ''));
    if (provider && provider.freeOnly) {
      const free = arr.filter((m) => {
        const id = m.id || '';
        const p = m.pricing || {};
        return /:free$/.test(id) || id === 'openrouter/free' || (p.prompt === '0' && p.completion === '0');
      }).map((m) => m.id);
      if (free.length) ids = free;
    }
    ids = ids.filter((id) => !/embed|whisper|tts|guard|imagen|veo|aqa|audio|image/i.test(id));
    return Array.from(new Set(ids));
  }

  // ------------------------------------------------------------------- agents
  const FS_READ = ['list_files', 'read_file', 'search_files', 'find_files'];
  const FS_WRITE = ['write_file', 'edit_file', 'delete_file'];
  const EXEC = ['run_terminal_command'];
  const WEB = ['web_search', 'read_url'];
  const META = ['write_todos', 'suggest_followups'];
  const RE_TOOLS = ['file_info', 'strings', 'hexdump', 'zip_list', 'zip_extract', 'android_manifest'];
  /** Tools that only update the UI; they never need another model turn by themselves. */
  const PASSIVE = ['write_todos', 'suggest_followups'];

  const AGENTS = {
    coder: {
      name: 'Coder', icon: '⌨', blurb: 'Orchestrates the whole job: reads, edits, runs, reviews',
      tools: FS_READ.concat(FS_WRITE, EXEC, WEB, ['spawn_agent'], META),
      prompt: 'You are CybNate, an expert AI coding agent that works like a strong senior engineer. You run on the user\'s Android phone ' +
        'inside a project workspace and you finish tasks end to end instead of describing what could be done.\n\n' +
        '# How you work\n' +
        '1. Understand: gather context before changing anything. List and search the workspace and read every file you will touch. ' +
        'For a large or unfamiliar codebase spawn an explorer agent; for questions about libraries or current facts use web_search/read_url or a researcher agent.\n' +
        '2. Plan: for a task with more than two steps, write a short checklist with write_todos and keep it updated as you go.\n' +
        '3. Implement: use write_file for new files and edit_file for changes to existing ones. Write complete, working code that follows the ' +
        'conventions already in the project. Never paste code for the user to copy when you could write the file. Do not leave TODO placeholders.\n' +
        '4. Verify: run what you wrote with run_terminal_command (run the script, run the tests, or at least a syntax check) and read the output. ' +
        'If it fails, fix the cause and run it again. Do not claim something works unless you ran it or say clearly that it could not be run here.\n' +
        '5. Review: after a non-trivial change spawn a reviewer agent, then fix the real problems it finds.\n' +
        '6. Finish: reply with a very short summary of what changed and how you verified it, then offer next steps with suggest_followups.\n\n' +
        'If the request is a question rather than a change, gather the context and answer directly with the key evidence. ' +
        'If the request is ambiguous in a way that changes what you would build, ask one short question instead of guessing. ' +
        'Keep messages brief: no long preambles, no repeating file contents the tools already wrote.',
    },
    planner: {
      name: 'Planner', icon: '🧭', blurb: 'Researches and writes an implementation plan, no edits',
      tools: FS_READ.concat(WEB, ['suggest_followups']),
      prompt: 'You are CybNate Planner. You are in plan mode: understand the request, inspect the workspace, research if useful, and produce a concrete ' +
        'numbered implementation plan: the files to create or change, the key decisions with a recommendation, and the risks. ' +
        'You do not implement anything and you make no file changes, even if asked; tell the user to switch to the Coder agent to build the plan.',
    },
    reviewer: {
      name: 'Reviewer', icon: '🔍', blurb: 'Finds bugs and security problems in workspace code',
      tools: FS_READ.concat(EXEC),
      prompt: 'You are CybNate Reviewer, a strict senior code reviewer. Read the relevant files (and run the code or tests when that helps) and report ' +
        'real problems in order of severity: bugs, security issues, broken edge cases, then maintainability. For each one give the file, the ' +
        'offending code and the concrete fix. Do not pad the review with praise or generic advice. If the code is fine, say so in one line. You do not edit files.',
    },
    reverse: {
      name: 'Reverse', icon: '🧬', blurb: 'Analyses APKs, binaries and decompiled code',
      tools: FS_READ.concat(FS_WRITE, RE_TOOLS, EXEC, WEB, META),
      prompt: 'You are CybNate Reverse, a reverse-engineering analyst. The user imports files (APK, DEX, ELF, PE, firmware, ' +
        'or decompiled/disassembled text from tools such as Ghidra or JADX) into the workspace. Gather evidence with your tools ' +
        'before concluding: identify the format, list archive contents, decode the Android manifest, pull strings, inspect bytes, and write ' +
        'small Python scripts with run_terminal_command to parse structures or decode data when that is faster. ' +
        'Explain what the code does, name functions and variables meaningfully when given decompiler output, and separate what you ' +
        'verified from what you infer. You cannot decompile native code yourself; say so when a desktop tool like Ghidra is needed ' +
        'and tell the user exactly what to export and import. Support legitimate work only: security research, interoperability, malware ' +
        'analysis, learning and auditing software the user is authorised to examine.',
    },
    chat: {
      name: 'Chat', icon: '💬', blurb: 'Conversation and research',
      tools: WEB.concat(['suggest_followups']),
      prompt: 'You are CybNate, a helpful and direct AI assistant. Answer clearly and concisely. Use Markdown and fenced code blocks for code. ' +
        'Search the web when the question needs current or specific facts, and cite the pages you used.',
    },
    // ---- sub-agents, only reachable through spawn_agent
    explorer: {
      name: 'Explorer', icon: '🗂', sub: true, blurb: 'Reads the codebase and reports what is relevant', tools: FS_READ,
      prompt: 'You are a codebase explorer working for another agent. Find and read the files relevant to the request, then report: ' +
        'which files matter and why, the important functions and data flow, and the exact snippets the caller will need. Be factual and compact. You do not edit files.',
    },
    thinker: {
      name: 'Thinker', icon: '🧠', sub: true, blurb: 'Reasons deeply about a hard problem', tools: FS_READ,
      prompt: 'You are a deep-thinking engineer consulted by another agent on a hard problem. Read what you need, reason carefully about the ' +
        'options and edge cases, and reply with a clear recommendation and the reasoning that supports it. You do not edit files.',
    },
    researcher: {
      name: 'Researcher', icon: '🌐', sub: true, blurb: 'Searches the web and documentation', tools: WEB,
      prompt: 'You are a web researcher working for another agent. Search, open the most relevant pages, and report the specific facts, ' +
        'API details or code examples that answer the request, with the source URL for each. Say plainly if you could not find it.',
    },
  };
  const SUBAGENT_TYPES = ['explorer', 'thinker', 'reviewer', 'researcher'];

  const TOOL_DOCS = {
    list_files: '<list_files/>\n  List every file in the workspace with its size.',
    read_file: '<read_file path="src/app.js"/>\n  Read a text file. Optional: start="1" end="200" to read a line range. Use several tags to read several files at once.',
    search_files: '<search_files query="text or regex"/>\n  Search the content of all text files; returns matching lines. Optional: glob="src/**/*.js".',
    find_files: '<find_files pattern="**/*.test.js"/>\n  Find files whose path matches a glob pattern.',
    write_file: '<write_file path="index.html">\nFULL FILE CONTENT\n</write_file>\n  Create or overwrite a file. Put the raw content between the tags, with no code fence and no escaping.',
    edit_file: '<edit_file path="src/app.js">\n<search>exact existing text</search>\n<replace>new text</replace>\n</edit_file>\n  Replace an exact snippet. Several search/replace pairs are allowed. The search text must match the file exactly, so read the file first.',
    delete_file: '<delete_file path="old.txt"/>\n  Delete a file.',
    run_terminal_command: '<run_terminal_command>\npython main.py\n</run_terminal_command>\n  Run a command in the workspace root and get its output and exit code. Optional attribute timeout="120" (seconds). See Environment for what can run.',
    web_search: '<web_search query="pyodide load package from wheel"/>\n  Search the web; returns titles, URLs and snippets.',
    read_url: '<read_url url="https://example.com/docs"/>\n  Fetch a web page and return its readable text.',
    spawn_agent: '<spawn_agent type="reviewer">\nWhat the agent should do, with all the context it needs.\n</spawn_agent>\n  Delegate to a helper agent with a fresh context and get its report back. Types: ' +
      'explorer (find and summarise relevant code), thinker (reason about a hard design or bug), reviewer (review the changes you made), researcher (look things up on the web).',
    write_todos: '<write_todos>\n- [x] finished step\n- [ ] next step\n</write_todos>\n  Show the user your task checklist. Send the whole list again whenever it changes.',
    suggest_followups: '<suggest_followups>\nAdd dark mode\nWrite tests for the parser\n</suggest_followups>\n  Offer up to three short next steps, one per line, at the very end of your final reply.',
    file_info: '<file_info path="app.apk"/>\n  Detect the file type and show size, SHA-256, entropy and header details (ELF, PE, DEX, ZIP/APK).',
    strings: '<strings path="lib.so" min="6" filter="http|key|token" limit="200"/>\n  Extract printable ASCII and UTF-16 strings. filter is an optional case-insensitive regex.',
    hexdump: '<hexdump path="lib.so" offset="0" length="256"/>\n  Hex dump of a byte range. offset may be decimal or 0x-prefixed.',
    zip_list: '<zip_list path="app.apk"/>\n  List entries of a ZIP, APK, JAR or AAR.',
    zip_extract: '<zip_extract path="app.apk" entry="classes.dex" dest="classes.dex"/>\n  Extract one archive entry into the workspace.',
    android_manifest: '<android_manifest path="app.apk"/>\n  Decode the binary AndroidManifest.xml from an APK (or a raw binary manifest file) to readable XML.',
  };

  function environmentDoc(caps) {
    caps = caps || {};
    return '# Environment\n' +
      'You are on an Android phone. Commands start in the workspace root.\n' +
      '- `python file.py`, `python -c "..."`, `python -m unittest`: real CPython 3.14 (WebAssembly) with the full standard library. ' +
      '`pip install <package>` works for pure-Python packages, and numpy, pandas and similar load automatically on import when the phone is online. No sockets, subprocesses or threads.\n' +
      '- `node file.js`, `node -e "..."`: a JavaScript runtime with require() between workspace files and built-in fs, path, assert, util. npm packages are not available.\n' +
      (caps.shell
        ? '- Anything else runs in the Android system shell (toybox): ls, cat, cp, mv, rm, mkdir, grep, sed, awk, find, wc, sort, uniq, diff, head, tail, tar, gzip, sha256sum, date and so on, with pipes and redirection.\n'
        : '- Other shell commands are not available in this browser preview; they work in the installed Android app.\n') +
      '- Not available: git, npm, gcc, apt, sudo. A python or node command must be the whole command (an optional `cd dir &&` prefix is fine), not part of a pipeline.\n' +
      '- Web projects (HTML/CSS/JS) are previewed by the user with the Run button; you cannot see the rendered page, so keep them self-contained with relative paths.\n' +
      (caps.repo ? '- The workspace is a clone of the GitHub repository ' + caps.repo + '. The user commits and pushes from the GitHub screen; you cannot push.\n' : '');
  }

  function buildSystemPrompt(agentId, fileSummary, extra, caps) {
    const a = AGENTS[agentId] || AGENTS.coder;
    let tools = a.tools;
    if (caps && caps.noSpawn) tools = tools.filter((t) => t !== 'spawn_agent');
    let s = a.prompt + '\n';
    if (tools.length) {
      s += '\n# Tools\nYou act by writing tool tags in your reply. The app runs them and sends back the results in the next message ' +
        'inside <tool_results>. Rules:\n' +
        '- Write the tags exactly as shown, as plain text, never inside a code fence.\n' +
        '- Use several tools in one reply whenever they do not depend on each other; it is much faster. After writing tool tags, stop and wait for the results.\n' +
        '- Never invent tool results. When the task is finished, reply without any tool tag (suggest_followups is allowed).\n\n' +
        tools.map((t) => TOOL_DOCS[t]).join('\n\n') + '\n';
      if (tools.indexOf('run_terminal_command') >= 0) s += '\n' + environmentDoc(caps);
      if (tools.some((t) => FS_READ.indexOf(t) >= 0)) s += '\n# Workspace\n' + (fileSummary || '(empty)') + '\n';
    }
    if (extra && extra.trim()) s += '\n# User instructions\n' + extra.trim() + '\n';
    return s;
  }

  // ------------------------------------------------------------ tool protocol
  const ALL_TOOLS = Object.keys(TOOL_DOCS);
  const BODY_TOOLS = ['write_file', 'edit_file', 'run_terminal_command', 'spawn_agent', 'write_todos', 'suggest_followups'];
  const TOOL_RE = new RegExp('<(' + ALL_TOOLS.join('|') + ')\\b((?:"[^"]*"|\'[^\']*\'|[^>"\'])*?)(?:\\/>|>([\\s\\S]*?)<\\/\\1\\s*>)', 'g');

  function parseAttrs(s) {
    const out = {};
    const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = unescapeXml(m[2] !== undefined ? m[2] : m[3]);
    return out;
  }
  function unescapeXml(s) {
    return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  function trimBody(s) {
    if (s == null) return '';
    s = s.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
    // Models sometimes wrap file content in a code fence despite instructions.
    const f = /^```[\w.+-]*\r?\n([\s\S]*?)\r?\n```$/.exec(s);
    return f ? f[1] : s;
  }
  /** Remove hidden reasoning that some models emit inline. */
  function stripThink(text) {
    return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '').replace(/<think(?:ing)?>[\s\S]*$/, '');
  }

  /** Find every tool call in an assistant reply. `allowed` limits which tools count. */
  function parseToolCalls(text, allowed) {
    text = stripThink(text);
    const calls = [];
    TOOL_RE.lastIndex = 0;
    let m;
    while ((m = TOOL_RE.exec(text))) {
      const name = m[1];
      if (allowed && allowed.indexOf(name) < 0) continue;
      const call = { name, attrs: parseAttrs(m[2] || ''), index: m.index, length: m[0].length };
      if (name === 'write_file') call.body = trimBody(m[3]);
      else if (name === 'edit_file') {
        call.edits = [];
        const er = /<search>([\s\S]*?)<\/search>\s*<replace>([\s\S]*?)<\/replace>/g;
        let e;
        while ((e = er.exec(m[3] || ''))) call.edits.push({ search: stripEdge(e[1]), replace: stripEdge(e[2]) });
      } else if (name === 'run_terminal_command') {
        let b = trimBody(m[3]).trim() || call.attrs.command || '';
        if (/&amp;|&lt;|&gt;/.test(b)) b = unescapeXml(b);
        call.body = b;
      } else if (BODY_TOOLS.indexOf(name) >= 0) call.body = trimBody(m[3]).trim();
      calls.push(call);
    }
    return calls;
  }
  function stripEdge(s) { return s.replace(/^\r?\n/, '').replace(/\r?\n$/, ''); }

  function followupsOf(text) {
    const m = /<suggest_followups\b[^>]*>([\s\S]*?)<\/suggest_followups\s*>/.exec(stripThink(text));
    if (!m) return [];
    return m[1].split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 4);
  }

  /** Replace tool tags with short readable markers for display (also handles a tag that is still streaming). */
  function displayText(text) {
    text = stripThink(text);
    TOOL_RE.lastIndex = 0;
    let out = text.replace(TOOL_RE, (all, name, attrs, body) => {
      const a = parseAttrs(attrs || '');
      if (name === 'suggest_followups') return '';
      if (name === 'write_todos') return '\n\n**Tasks**\n\n' + trimBody(body).trim() + '\n\n';
      if (name === 'run_terminal_command') return '\n\n> 🖥 `' + (trimBody(body).trim() || a.command || '').split('\n')[0].slice(0, 120).replace(/`/g, "'") + '`\n\n';
      if (name === 'spawn_agent') return '\n\n> 🤖 **' + (a.type || 'agent') + '** ' + trimBody(body).trim().split('\n')[0].slice(0, 110) + '\n\n';
      const target = a.path ? ' `' + a.path + '`' : a.query ? ' `' + a.query + '`' : a.pattern ? ' `' + a.pattern + '`' : a.url ? ' ' + a.url : '';
      let extra = '';
      if (name === 'write_file') extra = ' · ' + trimBody(body).split('\n').length + ' lines';
      if (a.entry) extra = ' · `' + a.entry + '`';
      return '\n\n> 🔧 **' + name + '**' + target + extra + '\n\n';
    });
    // a body tool that is still being streamed
    const open = new RegExp('<(' + BODY_TOOLS.join('|') + ')\\b([^>]*)>(?![\\s\\S]*<\\/\\1\\s*>)([\\s\\S]*)$').exec(out);
    if (open) {
      const a = parseAttrs(open[2]);
      const label = open[1] === 'write_todos' ? '**Tasks**\n\n' + open[3].trim()
        : open[1] === 'suggest_followups' ? ''
        : '> ✍️ **' + open[1] + '**' + (a.path ? ' `' + a.path + '`' : a.type ? ' ' + a.type : '') + ' · ' + open[3].split('\n').length + ' lines…';
      out = out.slice(0, open.index) + '\n\n' + label + '\n\n';
    } else {
      out = out.replace(/<\/?[a-z_]*$/, '');
    }
    return out;
  }

  // -------------------------------------------------------------- commands
  /** Split a command line the way a shell would, and note whether it uses shell operators. */
  function tokenize(cmd) {
    const tokens = []; let cur = '', q = null, has = false, ops = false;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (q) {
        if (c === q) q = null;
        else if (c === '\\' && q === '"' && i + 1 < cmd.length && '"\\$`'.indexOf(cmd[i + 1]) >= 0) cur += cmd[++i];
        else cur += c;
      } else if (c === '"' || c === "'") { q = c; has = true; }
      else if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; }
      else if (/\s/.test(c)) { if (has || cur) { tokens.push(cur); cur = ''; has = false; } }
      else { if ('|&;<>`'.indexOf(c) >= 0 || (c === '$' && cmd[i + 1] === '(')) ops = true; cur += c; }
    }
    if (has || cur) tokens.push(cur);
    return { tokens, ops, unterminated: !!q };
  }

  /** Decide which runtime handles a command: python, pip, node or the system shell. */
  function parseCommand(cmd) {
    cmd = String(cmd || '').trim();
    let cwd = '';
    const cd = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(cmd);
    let rest = cmd;
    if (cd) { cwd = Workspace.norm(cd[1].replace(/^["']|["']$/g, '')); rest = cmd.slice(cd[0].length); }
    const t = tokenize(rest);
    const sh = { kind: 'sh', cmd };
    if (!t.tokens.length || t.ops || t.unterminated) return sh;
    const a = t.tokens, prog = a[0];
    if (/^python(3(\.\d+)?)?$|^py$/.test(prog)) {
      let i = 1;
      while (i < a.length && /^-[uBOEsSI]+$/.test(a[i])) i++;
      if (a[i] === '-m' && a[i + 1] === 'pip') return a[i + 2] === 'install' ? { kind: 'pip', argv: a.slice(i + 3).filter((x) => x[0] !== '-'), cwd } : { kind: 'note', text: 'Only `pip install <package>` is supported.' };
      if (a[i] === '-c' && a[i + 1] != null) return { kind: 'python', mode: 'code', src: a[i + 1], argv: ['-c'].concat(a.slice(i + 2)), cwd };
      if (a[i] === '-m' && a[i + 1]) return { kind: 'python', mode: 'module', argv: a.slice(i + 1), cwd };
      if (a[i] === '--version' || a[i] === '-V') return { kind: 'python', mode: 'code', src: 'import sys; print("Python", sys.version.split()[0])', argv: ['-c'], cwd };
      if (a[i] && a[i][0] !== '-') return { kind: 'python', mode: 'file', argv: a.slice(i), cwd };
      return { kind: 'note', text: 'Interactive Python is not available. Run a file (`python main.py`) or code (`python -c "print(1)"`).' };
    }
    if (/^pip3?$/.test(prog)) return a[1] === 'install' ? { kind: 'pip', argv: a.slice(2).filter((x) => x[0] !== '-'), cwd } : { kind: 'note', text: 'Only `pip install <package>` is supported.' };
    if (prog === 'node' || prog === 'nodejs') {
      if ((a[1] === '-e' || a[1] === '--eval' || a[1] === '-p') && a[2] != null) return { kind: 'node', mode: 'code', src: a[1] === '-p' ? 'console.log(' + a[2] + ')' : a[2], argv: a.slice(3), cwd };
      if (a[1] === '--version' || a[1] === '-v') return { kind: 'note', text: 'CybNate JavaScript runtime (no npm packages)' };
      if (a[1] === '--check' && a[2]) return { kind: 'node', mode: 'check', argv: a.slice(2), cwd };
      if (a[1] && a[1][0] !== '-') return { kind: 'node', mode: 'file', argv: a.slice(1), cwd };
      return { kind: 'note', text: 'Interactive node is not available. Run a file: `node app.js`.' };
    }
    if (/^(npm|npx|yarn|pnpm|bun)$/.test(prog)) return { kind: 'note', text: prog + ' is not available on this device. JavaScript files run with `node file.js` (no npm packages); to run tests, write them as a plain script using assert.', code: 127 };
    if (prog === 'git') return { kind: 'note', text: 'git is not available. The user commits and pushes from the GitHub screen in the app.', code: 127 };
    return sh;
  }

  function globToRegex(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*'; }
      else if (c === '?') re += '[^/]';
      else if (c === '{') { const j = glob.indexOf('}', i); if (j > i) { re += '(?:' + glob.slice(i + 1, j).split(',').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j; } else re += '\\{'; }
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$', 'i');
  }
  function matchGlob(glob, path) {
    glob = String(glob || '').replace(/^\.?\//, '');
    if (!glob) return true;
    return globToRegex(glob).test(path) || (glob.indexOf('/') < 0 && globToRegex(glob).test(path.split('/').pop()));
  }

  // ---------------------------------------------------------------- workspace
  /** In-memory file store. Values are strings (text) or Uint8Array (binary). `persist(path, value|null)` is optional. */
  class Workspace {
    constructor(persist) { this.files = new Map(); this.persist = persist || function () {}; }
    static norm(p) {
      p = String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
      const parts = [];
      p.split('/').forEach((seg) => { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); });
      return parts.join('/');
    }
    list() { return Array.from(this.files.keys()).sort(); }
    has(p) { return this.files.has(Workspace.norm(p)); }
    get(p) { return this.files.get(Workspace.norm(p)); }
    isBinary(p) { return this.get(p) instanceof Uint8Array; }
    size(p) { const v = this.get(p); return v == null ? 0 : (v instanceof Uint8Array ? v.length : utf8(v).length); }
    set(p, v) { p = Workspace.norm(p); if (!p) throw new Error('missing path'); this.files.set(p, v); this.persist(p, v); return p; }
    remove(p) { p = Workspace.norm(p); const had = this.files.delete(p); if (had) this.persist(p, null); return had; }
    bytes(p) { const v = this.get(p); if (v == null) return null; return v instanceof Uint8Array ? v : utf8(v); }
    summary(max) {
      const l = this.list();
      if (!l.length) return '(empty — no files yet)';
      const shown = l.slice(0, max || 80).map((p) => '- ' + p + ' (' + fmtSize(this.size(p)) + (this.isBinary(p) ? ', binary' : '') + ')');
      if (l.length > shown.length) shown.push('… and ' + (l.length - shown.length) + ' more');
      return shown.join('\n');
    }
  }

  function utf8(s) { return new TextEncoder().encode(s); }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  /** Decide whether bytes are text; returns the decoded string or null. */
  function decodeIfText(bytes) {
    const n = Math.min(bytes.length, 8192);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return null;
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (e) { return null; }
  }

  // ------------------------------------------------------------------- tools
  const MAX_OUT = 14000;
  function clip(s, max) {
    max = max || MAX_OUT;
    return s.length > max ? s.slice(0, max) + '\n… [truncated, ' + (s.length - max) + ' more characters]' : s;
  }
  function num(v, d) {
    if (v == null || v === '') return d;
    const n = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
    return isNaN(n) ? d : n;
  }

  async function runTool(call, ws, env) {
    const a = call.attrs || {};
    env = env || {};
    const need = (p) => {
      if (!p) throw new Error('missing path attribute');
      if (!ws.has(p)) throw new Error('file not found: ' + p + '. Existing files:\n' + ws.summary(40));
      return Workspace.norm(p);
    };
    switch (call.name) {
      case 'list_files': return ws.summary(300);
      case 'read_file': {
        const p = need(a.path);
        if (ws.isBinary(p)) return p + ' is a binary file (' + fmtSize(ws.size(p)) + '). Use file_info, strings or hexdump.';
        const lines = ws.get(p).split('\n');
        const s = Math.max(1, num(a.start, 1)), e = Math.min(lines.length, num(a.end, lines.length));
        const body = lines.slice(s - 1, e).join('\n');
        return clip((s > 1 || e < lines.length ? '[lines ' + s + '-' + e + ' of ' + lines.length + ']\n' : '') + body);
      }
      case 'search_files': {
        if (!a.query) throw new Error('missing query attribute');
        let re;
        try { re = new RegExp(a.query, 'i'); } catch (e) { re = new RegExp(a.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
        const hits = [];
        for (const p of ws.list()) {
          if (ws.isBinary(p) || (a.glob && !matchGlob(a.glob, p))) continue;
          ws.get(p).split('\n').forEach((line, i) => { if (hits.length < 200 && re.test(line)) hits.push(p + ':' + (i + 1) + ': ' + line.trim().slice(0, 200)); });
        }
        return hits.length ? clip(hits.join('\n')) : 'No matches.';
      }
      case 'find_files': {
        const pat = a.pattern || a.query || a.glob;
        if (!pat) throw new Error('missing pattern attribute');
        const hits = ws.list().filter((p) => matchGlob(pat, p) || p.toLowerCase().indexOf(pat.toLowerCase()) >= 0);
        return hits.length ? clip(hits.map((p) => p + ' (' + fmtSize(ws.size(p)) + ')').join('\n')) : 'No files match ' + pat + '.';
      }
      case 'run_terminal_command': {
        if (!call.body) throw new Error('empty command');
        if (!env.exec) throw new Error('commands cannot run in this context');
        const r = await env.exec(call.body, Math.min(Math.max(num(a.timeout, 60), 1), 600));
        const out = (r.out || '').replace(/\s+$/, '');
        return '$ ' + call.body + '\n' + (out ? clip(tailClip(out, 9000)) + '\n' : '') + '[exit code ' + r.code + (r.timedOut ? ', timed out' : '') + ']' +
          (r.files && r.files.length ? '\n[files changed: ' + r.files.slice(0, 20).join(', ') + ']' : '');
      }
      case 'web_search': {
        if (!a.query) throw new Error('missing query attribute');
        if (!env.search) throw new Error('web search is not available in this context');
        const res = await env.search(a.query);
        return res.length ? clip(res.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')).join('\n')) : 'No results.';
      }
      case 'read_url': {
        if (!a.url) throw new Error('missing url attribute');
        if (!env.readUrl) throw new Error('web access is not available in this context');
        return clip(await env.readUrl(a.url), 12000);
      }
      case 'spawn_agent': {
        const type = (a.type || '').toLowerCase();
        if (SUBAGENT_TYPES.indexOf(type) < 0) throw new Error('unknown agent type "' + a.type + '". Use one of: ' + SUBAGENT_TYPES.join(', '));
        if (!call.body) throw new Error('spawn_agent needs instructions between the tags');
        if (!env.spawn) throw new Error('helper agents cannot spawn further agents');
        return clip(await env.spawn(type, call.body), 9000);
      }
      case 'write_todos': { if (env.todos) env.todos(call.body || ''); return 'Checklist updated.'; }
      case 'suggest_followups': return 'Shown to the user.';
      case 'write_file': {
        if (!a.path) throw new Error('missing path attribute');
        const existed = ws.has(a.path);
        const p = ws.set(a.path, call.body || '');
        return (existed ? 'Updated ' : 'Created ') + p + ' (' + (call.body || '').split('\n').length + ' lines).';
      }
      case 'edit_file': {
        const p = need(a.path);
        if (ws.isBinary(p)) throw new Error(p + ' is binary and cannot be edited as text');
        if (!call.edits || !call.edits.length) throw new Error('edit_file needs at least one <search>…</search><replace>…</replace> pair');
        let text = ws.get(p), done = 0;
        const msgs = [];
        call.edits.forEach((ed, i) => {
          if (!ed.search) { msgs.push('edit ' + (i + 1) + ': empty search text'); return; }
          let idx = text.indexOf(ed.search);
          if (idx < 0) {
            // tolerate differences in trailing whitespace / indentation
            const loose = looseFind(text, ed.search);
            if (loose) { text = text.slice(0, loose.start) + ed.replace + text.slice(loose.end); done++; return; }
            msgs.push('edit ' + (i + 1) + ': search text not found');
            return;
          }
          // A search snippet indented less than the file matches mid-indentation; swallow the
          // rest of that indentation so the replacement's own indentation is not added on top.
          let from = idx;
          const ls = text.lastIndexOf('\n', idx - 1) + 1;
          if (ls < idx && /^\s/.test(ed.search) && /^[ \t]+$/.test(text.slice(ls, idx))) from = ls;
          text = text.slice(0, from) + ed.replace + text.slice(idx + ed.search.length);
          done++;
        });
        if (done) ws.set(p, text);
        if (msgs.length) throw new Error('Applied ' + done + ' of ' + call.edits.length + ' edits to ' + p + '. ' + msgs.join('; ') + '. Read the file again and retry with exact text.');
        return 'Applied ' + done + ' edit' + (done > 1 ? 's' : '') + ' to ' + p + '.';
      }
      case 'delete_file': { const p = need(a.path); ws.remove(p); return 'Deleted ' + p + '.'; }
      case 'file_info': { const p = need(a.path); return await fileInfo(ws.bytes(p), p); }
      case 'strings': {
        const p = need(a.path);
        const list = extractStrings(ws.bytes(p), { min: num(a.min, 6), filter: a.filter, limit: Math.min(num(a.limit, 200), 1000) });
        return list.total ? clip(list.total + ' strings matched' + (list.total > list.items.length ? ' (showing ' + list.items.length + ')' : '') + ':\n' + list.items.join('\n')) : 'No strings matched.';
      }
      case 'hexdump': { const p = need(a.path); return hexdump(ws.bytes(p), num(a.offset, 0), Math.min(num(a.length, 256), 2048)); }
      case 'zip_list': {
        const p = need(a.path);
        const ents = zipEntries(ws.bytes(p));
        return clip(ents.length + ' entries:\n' + ents.map((e) => e.name + '  ' + fmtSize(e.size) + (e.method ? '' : ' (stored)')).join('\n'));
      }
      case 'zip_extract': {
        const p = need(a.path);
        if (!a.entry) throw new Error('missing entry attribute');
        const data = await zipRead(ws.bytes(p), a.entry);
        const dest = a.dest || a.entry.split('/').pop();
        const text = decodeIfText(data);
        const saved = ws.set(dest, text != null ? text : data);
        return 'Extracted ' + a.entry + ' → ' + saved + ' (' + fmtSize(data.length) + (text != null ? ', text' : ', binary') + ').';
      }
      case 'android_manifest': {
        const p = need(a.path);
        let bytes = ws.bytes(p);
        if (bytes[0] === 0x50 && bytes[1] === 0x4b) bytes = await zipRead(bytes, 'AndroidManifest.xml');
        const text = decodeIfText(bytes);
        return clip(text != null && /^\s*</.test(text) ? text : decodeAxml(bytes));
      }
    }
    throw new Error('unknown tool ' + call.name);
  }

  function looseFind(text, search) {
    const tl = text.split('\n'), sl = search.split('\n').map((l) => l.trim());
    while (sl.length && !sl[sl.length - 1]) sl.pop();
    while (sl.length && !sl[0]) sl.shift();
    if (!sl.length) return null;
    for (let i = 0; i + sl.length <= tl.length; i++) {
      let ok = true;
      for (let j = 0; j < sl.length; j++) if (tl[i + j].trim() !== sl[j]) { ok = false; break; }
      if (ok) {
        let start = 0;
        for (let k = 0; k < i; k++) start += tl[k].length + 1;
        let end = start;
        for (let k = 0; k < sl.length; k++) end += tl[i + k].length + 1;
        return { start, end: Math.min(end - 1, text.length) };
      }
    }
    return null;
  }

  function tailClip(s, max) {
    if (s.length <= max) return s;
    const head = Math.floor(max * 0.3);
    return s.slice(0, head) + '\n… [' + (s.length - max) + ' characters omitted] …\n' + s.slice(s.length - (max - head));
  }
  function callLabel(c) {
    const a = c.attrs || {};
    if (c.name === 'run_terminal_command') return '$ ' + (c.body || '').split('\n')[0].slice(0, 70);
    if (c.name === 'spawn_agent') return 'agent ' + (a.type || '');
    return c.name + (a.path ? ' ' + a.path : a.query ? ' ' + a.query : a.pattern ? ' ' + a.pattern : a.url ? ' ' + a.url : '');
  }
  /** Run calls in order. Independent helper agents run in parallel, like Freebuff's spawn_agents. */
  async function runTools(calls, ws, env, onProgress) {
    const parts = new Array(calls.length);
    const one = async (c, i) => {
      let res, ok = true;
      if (onProgress) onProgress(callLabel(c));
      try { res = await runTool(c, ws, env); if (c.name === 'run_terminal_command' && !/\[exit code 0\]/.test(res)) ok = false; }
      catch (e) { if (e && e.name === 'AbortError') throw e; ok = false; res = 'ERROR: ' + (e && e.message ? e.message : e); }
      parts[i] = { label: callLabel(c), ok, text: res };
    };
    let i = 0;
    while (i < calls.length) {
      if (calls[i].name === 'spawn_agent' || calls[i].name === 'web_search' || calls[i].name === 'read_url') {
        const batch = [];
        const kind = calls[i].name === 'spawn_agent';
        while (i < calls.length && ((calls[i].name === 'spawn_agent') === kind) && ['spawn_agent', 'web_search', 'read_url'].indexOf(calls[i].name) >= 0) { batch.push(one(calls[i], i)); i++; }
        await Promise.all(batch);
      } else { await one(calls[i], i); i++; }
    }
    return parts;
  }
  function formatToolResults(parts) {
    return '<tool_results>\n' + parts.map((p) => '[' + p.label + ']\n' + p.text).join('\n\n') + '\n</tool_results>';
  }

  // ---------------------------------------------------------- binary analysis
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function hex(n, w) { return n.toString(16).padStart(w || 2, '0'); }
  function ascii(b, o, n) { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; }

  function entropy(b) {
    if (!b.length) return 0;
    const step = b.length > 4194304 ? Math.floor(b.length / 4194304) : 1;
    const c = new Uint32Array(256); let n = 0;
    for (let i = 0; i < b.length; i += step) { c[b[i]]++; n++; }
    let e = 0;
    for (let i = 0; i < 256; i++) if (c[i]) { const p = c[i] / n; e -= p * Math.log2(p); }
    return e;
  }

  const ELF_MACHINE = { 3: 'x86', 8: 'MIPS', 40: 'ARM', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V' };
  const ELF_TYPE = { 1: 'relocatable', 2: 'executable', 3: 'shared object / PIE', 4: 'core' };
  const PE_MACHINE = { 0x14c: 'x86', 0x8664: 'x86-64', 0x1c0: 'ARM', 0xaa64: 'ARM64', 0x1c4: 'ARMv7 Thumb' };

  function detectType(b) {
    const m4 = ascii(b, 0, 4);
    if (m4 === '\x7fELF') return 'ELF';
    if (m4.slice(0, 2) === 'MZ') return 'PE';
    if (m4 === 'dex\n') return 'DEX';
    if (m4 === 'PK\x03\x04') return 'ZIP';
    const be = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].indexOf(be) >= 0) return be === 0xcafebabe && b[7] > 20 ? 'Java class' : 'Mach-O';
    if (u32(b, 0) === 0x00080003) return 'Android binary XML';
    if (u32(b, 0) === 0x000c0002) return 'Android resources.arsc';
    if (m4 === '\x89PNG') return 'PNG image';
    if (m4 === '%PDF') return 'PDF';
    if (m4.slice(0, 3) === '\x1f\x8b\x08') return 'gzip';
    if (m4 === '\x00asm') return 'WebAssembly';
    if (ascii(b, 0, 6) === 'SQLite') return 'SQLite database';
    return decodeIfText(b.subarray(0, 8192)) != null ? 'text' : 'unknown binary';
  }

  async function sha256(b) {
    const c = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : null;
    if (!c) return '(unavailable)';
    const d = new Uint8Array(await c.subtle.digest('SHA-256', b));
    return Array.from(d).map((x) => hex(x)).join('');
  }

  async function fileInfo(b, name) {
    const type = detectType(b);
    const out = ['File: ' + name, 'Type: ' + type, 'Size: ' + b.length + ' bytes (' + fmtSize(b.length) + ')',
      'SHA-256: ' + await sha256(b), 'Entropy: ' + entropy(b).toFixed(2) + ' / 8.00' + (entropy(b) > 7.5 ? ' (high: likely compressed or encrypted)' : ''),
      'Magic: ' + Array.from(b.subarray(0, 16)).map((x) => hex(x)).join(' ')];
    try {
      if (type === 'ELF') {
        const is64 = b[4] === 2, le = b[5] === 1;
        const r16 = (o) => le ? u16(b, o) : (b[o] << 8) | b[o + 1];
        out.push('ELF: ' + (is64 ? '64-bit' : '32-bit') + ', ' + (le ? 'little-endian' : 'big-endian') +
          ', type ' + (ELF_TYPE[r16(16)] || r16(16)) + ', machine ' + (ELF_MACHINE[r16(18)] || '0x' + hex(r16(18), 4)));
        if (le) out.push('Entry point: 0x' + (is64 ? hex(u32(b, 28), 8) + hex(u32(b, 24), 8) : hex(u32(b, 24), 8)));
        const secs = elfSections(b);
        if (secs.length) out.push('Sections: ' + secs.map((s) => s.name + '@0x' + hex(s.off, 1) + '+' + s.size).join(', '));
      } else if (type === 'PE') {
        const pe = u32(b, 0x3c);
        if (ascii(b, pe, 2) === 'PE') {
          const machine = u16(b, pe + 4), nsec = u16(b, pe + 6), optSize = u16(b, pe + 20), ch = u16(b, pe + 22);
          const magic = u16(b, pe + 24);
          out.push('PE: ' + (magic === 0x20b ? 'PE32+ (64-bit)' : 'PE32 (32-bit)') + ', machine ' + (PE_MACHINE[machine] || '0x' + hex(machine, 4)) +
            ', ' + ((ch & 0x2000) ? 'DLL' : 'EXE') + ', timestamp ' + new Date(u32(b, pe + 8) * 1000).toISOString());
          out.push('Entry point RVA: 0x' + hex(u32(b, pe + 40), 8));
          const st = pe + 24 + optSize, secs = [];
          for (let i = 0; i < nsec && st + i * 40 + 40 <= b.length; i++) {
            const o = st + i * 40;
            secs.push(ascii(b, o, 8).replace(/\0+$/, '') + ' (rva 0x' + hex(u32(b, o + 12), 1) + ', raw ' + u32(b, o + 16) + ')');
          }
          out.push('Sections: ' + secs.join(', '));
        }
      } else if (type === 'DEX') {
        out.push('DEX version: ' + ascii(b, 4, 3) + ', strings ' + u32(b, 56) + ', types ' + u32(b, 64) + ', protos ' + u32(b, 72) +
          ', fields ' + u32(b, 80) + ', methods ' + u32(b, 88) + ', classes ' + u32(b, 96));
      } else if (type === 'ZIP') {
        const ents = zipEntries(b);
        const names = ents.map((e) => e.name);
        const isApk = names.indexOf('AndroidManifest.xml') >= 0;
        out.push((isApk ? 'Android APK' : 'ZIP archive') + ' with ' + ents.length + ' entries');
        if (isApk) {
          out.push('DEX files: ' + (names.filter((n) => /^classes\d*\.dex$/.test(n)).join(', ') || 'none'));
          const abis = Array.from(new Set(names.filter((n) => /^lib\/[^/]+\//.test(n)).map((n) => n.split('/')[1])));
          out.push('Native ABIs: ' + (abis.join(', ') || 'none'));
          out.push('Native libraries: ' + (Array.from(new Set(names.filter((n) => /\.so$/.test(n)).map((n) => n.split('/').pop()))).slice(0, 40).join(', ') || 'none'));
          out.push('Signature files: ' + (names.filter((n) => /^META-INF\/.*\.(RSA|DSA|EC|SF)$/.test(n)).join(', ') || 'none in META-INF (may use APK Signature Scheme v2+)'));
        }
      }
    } catch (e) { out.push('(header parse error: ' + e.message + ')'); }
    return out.join('\n');
  }

  function elfSections(b) {
    try {
      if (b[5] !== 1) return [];
      const is64 = b[4] === 2;
      const shoff = is64 ? u32(b, 40) : u32(b, 32);
      const entsize = u16(b, is64 ? 58 : 46), n = u16(b, is64 ? 60 : 48), strndx = u16(b, is64 ? 62 : 50);
      if (!shoff || !n || shoff + n * entsize > b.length) return [];
      const sec = (i) => {
        const o = shoff + i * entsize;
        return is64 ? { nameOff: u32(b, o), off: u32(b, o + 24), size: u32(b, o + 32) } : { nameOff: u32(b, o), off: u32(b, o + 16), size: u32(b, o + 20) };
      };
      const str = sec(strndx), res = [];
      for (let i = 1; i < n && i < 64; i++) {
        const s = sec(i); let name = '';
        for (let p = str.off + s.nameOff; p < b.length && b[p]; p++) name += String.fromCharCode(b[p]);
        res.push({ name: name || '?', off: s.off, size: s.size });
      }
      return res;
    } catch (e) { return []; }
  }

  function extractStrings(b, opt) {
    opt = opt || {};
    const min = Math.max(3, opt.min || 6), limit = opt.limit || 200;
    let re = null;
    if (opt.filter) { try { re = new RegExp(opt.filter, 'i'); } catch (e) { re = new RegExp(opt.filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }
    const items = []; let total = 0; const seen = new Set();
    const push = (s) => {
      if (s.length < min || seen.has(s)) return;
      if (re && !re.test(s)) return;
      seen.add(s); total++;
      if (items.length < limit) items.push(s.length > 300 ? s.slice(0, 300) + '…' : s);
    };
    const pr = (c) => (c >= 0x20 && c < 0x7f) || c === 0x09;
    let cur = '';
    for (let i = 0; i < b.length; i++) {
      if (pr(b[i])) cur += String.fromCharCode(b[i]);
      else { if (cur.length >= min) push(cur); cur = ''; }
    }
    if (cur.length >= min) push(cur);
    cur = '';
    for (let i = 0; i + 1 < b.length;) { // UTF-16LE at either alignment
      if (pr(b[i]) && b[i + 1] === 0) { cur += String.fromCharCode(b[i]); i += 2; }
      else { if (cur.length >= min) push(cur); cur = ''; i += 1; }
    }
    if (cur.length >= min) push(cur);
    return { items, total };
  }

  function hexdump(b, off, len) {
    off = Math.max(0, Math.min(off || 0, b.length)); len = Math.max(0, Math.min(len || 256, b.length - off));
    const lines = [];
    for (let i = 0; i < len; i += 16) {
      const row = b.subarray(off + i, Math.min(off + i + 16, off + len));
      const hx = Array.from(row).map((x) => hex(x)).join(' ').padEnd(47, ' ');
      const as = Array.from(row).map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
      lines.push(hex(off + i, 8) + '  ' + hx + '  ' + as);
    }
    return lines.join('\n') || '(no bytes in range; file is ' + b.length + ' bytes)';
  }

  // --------------------------------------------------------------------- zip
  function zipEntries(b) {
    let eocd = -1;
    for (let i = b.length - 22; i >= 0 && i > b.length - 65558; i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
    const n = u16(b, eocd + 10); let p = u32(b, eocd + 16); const out = [];
    const td = new TextDecoder();
    for (let i = 0; i < n && p + 46 <= b.length; i++) {
      if (u32(b, p) !== 0x02014b50) break;
      const method = u16(b, p + 10), csize = u32(b, p + 20), size = u32(b, p + 24);
      const nl = u16(b, p + 28), el = u16(b, p + 30), cl = u16(b, p + 32), lho = u32(b, p + 42);
      out.push({ name: td.decode(b.subarray(p + 46, p + 46 + nl)), method, csize, size, lho });
      p += 46 + nl + el + cl;
    }
    return out;
  }

  async function zipRead(b, name) {
    const e = zipEntries(b).find((x) => x.name === name);
    if (!e) throw new Error('entry not found in archive: ' + name);
    const o = e.lho;
    if (u32(b, o) !== 0x04034b50) throw new Error('corrupt local header for ' + name);
    const start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
    const raw = b.subarray(start, start + e.csize);
    if (e.method === 0) return new Uint8Array(raw);
    if (e.method !== 8) throw new Error('unsupported compression method ' + e.method);
    return inflateRaw(raw);
  }

  async function inflateRaw(raw) {
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('deflate-raw');
      const w = ds.writable.getWriter();
      w.write(raw).catch(() => {}); w.close().catch(() => {});
      return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    }
    if (typeof require === 'function') return new Uint8Array(require('zlib').inflateRawSync(raw));
    throw new Error('this WebView is too old to decompress archives (needs Android System WebView 103+)');
  }

  let CRC_T = null;
  function crc32(b) {
    if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Build an uncompressed ZIP from [{name, data:Uint8Array}]. */
  function zipCreate(files) {
    const chunks = [], central = []; let off = 0;
    const w16 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >>> 8) & 255; };
    const w32 = (a, o, v) => { w16(a, o, v & 0xffff); w16(a, o + 2, (v >>> 16) & 0xffff); };
    files.forEach((f) => {
      const name = utf8(f.name), crc = crc32(f.data), h = new Uint8Array(30 + name.length);
      w32(h, 0, 0x04034b50); w16(h, 4, 20); w16(h, 6, 0x0800); w16(h, 8, 0); w32(h, 14, crc); w32(h, 18, f.data.length); w32(h, 22, f.data.length); w16(h, 26, name.length);
      h.set(name, 30);
      const c = new Uint8Array(46 + name.length);
      w32(c, 0, 0x02014b50); w16(c, 4, 20); w16(c, 6, 20); w16(c, 8, 0x0800); w32(c, 16, crc); w32(c, 20, f.data.length); w32(c, 24, f.data.length); w16(c, 28, name.length); w32(c, 42, off);
      c.set(name, 46);
      chunks.push(h, f.data); central.push(c); off += h.length + f.data.length;
    });
    const csize = central.reduce((s, c) => s + c.length, 0), end = new Uint8Array(22);
    w32(end, 0, 0x06054b50); w16(end, 8, files.length); w16(end, 10, files.length); w32(end, 12, csize); w32(end, 16, off);
    const all = chunks.concat(central, [end]), out = new Uint8Array(off + csize + 22);
    let p = 0; all.forEach((c) => { out.set(c, p); p += c.length; });
    return out;
  }

  // ------------------------------------------------------- Android binary XML
  function decodeAxml(b) {
    if (u16(b, 0) !== 0x0003) throw new Error('not an Android binary XML file');
    let p = u16(b, 2); const strings = []; const out = ['<?xml version="1.0" encoding="utf-8"?>'];
    const ns = {}; let depth = 0, pendingNs = [];
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const str = (i) => (i === 0xffffffff || i >= strings.length ? null : strings[i]);
    while (p + 8 <= b.length) {
      const type = u16(b, p), hsize = u16(b, p + 2), size = u32(b, p + 4);
      if (!size) break;
      if (type === 0x0001) { // string pool
        const count = u32(b, p + 8), flags = u32(b, p + 16), sStart = u32(b, p + 20), isUtf8 = (flags & 0x100) !== 0;
        for (let i = 0; i < count; i++) {
          let o = p + sStart + u32(b, p + hsize + i * 4);
          if (isUtf8) {
            if (b[o] & 0x80) o += 2; else o += 1;
            let len = b[o]; if (len & 0x80) { len = ((len & 0x7f) << 8) | b[o + 1]; o += 2; } else o += 1;
            strings.push(new TextDecoder().decode(b.subarray(o, o + len)));
          } else {
            let len = u16(b, o); o += 2;
            if (len & 0x8000) { len = ((len & 0x7fff) << 16) | u16(b, o); o += 2; }
            let s = ''; for (let k = 0; k < len; k++) s += String.fromCharCode(u16(b, o + k * 2));
            strings.push(s);
          }
        }
      } else if (type === 0x0100) { // start namespace
        const prefix = str(u32(b, p + 16)), uri = str(u32(b, p + 20));
        ns[uri] = prefix; pendingNs.push([prefix, uri]);
      } else if (type === 0x0102) { // start element
        const name = str(u32(b, p + 20)), attrStart = u16(b, p + 24), attrSize = u16(b, p + 26), attrCount = u16(b, p + 28);
        let line = '  '.repeat(depth) + '<' + name;
        pendingNs.forEach((n) => { line += ' xmlns:' + n[0] + '="' + esc(n[1]) + '"'; }); pendingNs = [];
        for (let i = 0; i < attrCount; i++) {
          const o = p + 16 + attrStart + i * attrSize;
          const aNs = str(u32(b, o)), aName = str(u32(b, o + 4)), raw = str(u32(b, o + 8));
          const dt = b[o + 15], data = u32(b, o + 16);
          let v;
          if (raw != null) v = raw;
          else if (dt === 0x03) v = str(data);
          else if (dt === 0x12) v = data ? 'true' : 'false';
          else if (dt === 0x10) v = String(data | 0);
          else if (dt === 0x11) v = '0x' + hex(data, 1);
          else if (dt === 0x01) v = '@0x' + hex(data, 8);
          else if (dt === 0x02) v = '?0x' + hex(data, 8);
          else v = '0x' + hex(data, 8);
          line += ' ' + (aNs && ns[aNs] ? ns[aNs] + ':' : '') + (aName || 'attr_' + i) + '="' + esc(v) + '"';
        }
        out.push(line + '>'); depth++;
      } else if (type === 0x0103) { // end element
        depth = Math.max(0, depth - 1);
        out.push('  '.repeat(depth) + '</' + str(u32(b, p + 20)) + '>');
      }
      p += size;
    }
    return out.join('\n');
  }

  // --------------------------------------------------------------------- SSE
  /** Incremental parser for OpenAI-style server-sent events. feed() returns text deltas. */
  function createSseParser() {
    let buf = '';
    return {
      feed(chunk) {
        buf += chunk;
        const out = []; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.error) { out.push({ error: typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error)) }); continue; }
            const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
            if (d && typeof d.content === 'string' && d.content) out.push({ text: d.content });
            else if (d && (d.reasoning_content || d.reasoning)) out.push({ thinking: true });
          } catch (e) { /* partial or non-JSON keep-alive line */ }
        }
        return out;
      },
    };
  }

  /** Keep the conversation within a character budget, always keeping the latest messages. */
  function trimHistory(msgs, budget) {
    let total = 0; const out = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      total += msgs[i].content.length;
      if (total > budget && out.length >= 2) break;
      out.unshift({ role: msgs[i].role, content: msgs[i].content });
    }
    while (out.length > 1 && out[0].role !== 'user') out.shift();
    return out;
  }

  return {
    PROVIDERS, AGENTS, TOOL_DOCS, PASSIVE, SUBAGENT_TYPES, BODY_TOOLS, parseModelList, buildSystemPrompt, parseToolCalls, displayText, Workspace,
    stripThink, followupsOf, tokenize, parseCommand, matchGlob, callLabel,
    runTool, runTools, formatToolResults, fileInfo, detectType, extractStrings, hexdump, zipEntries, zipRead, zipCreate,
    decodeAxml, decodeIfText, createSseParser, trimHistory, fmtSize, crc32, utf8,
  };
});
