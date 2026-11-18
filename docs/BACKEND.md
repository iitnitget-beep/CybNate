# CybNate server

The app can work in two ways.

- **On the phone (default).** Nothing to set up. Python and JavaScript run in bundled runtimes, other commands in the Android shell, keys stay on the phone.
- **With a server.** Settings → Server → address + access key. From then on the phone is the screen and the server does the work:

| | where it happens with a server connected |
|---|---|
| Terminal commands, `execute_python`, `sqlite_query`, pip, npm | server (real bash, Python 3, Node, whatever is installed) |
| `curl` / `http_request` | sent by the server, which fills in `$SECRET` values |
| Language-server checks (`lsp <file>`) | server |
| Secrets | server, encrypted; the phone keeps only the names |
| ChatGPT (Codex) sign-in, Google sign-in, token renewal | server; the phone never receives a token |
| Workspace files | on the phone **and** copied to the server before each command; changes come back |
| Chats, model-provider API keys, chat requests to those providers | phone (not moved yet) |
| Built-in `git` + GitHub push, `test_webapp`, the Run preview | phone |

If the server cannot be reached a command fails with a plain message. It is never run on the phone instead.

## Run it

Needs Node 22.13 or newer. No npm packages.

```
docker build -t cybnate-server server/
docker run -d --init --name cybnate -p 8787:8787 -v cybnate-data:/data \
  -e CYB_ACCESS_KEY="$(openssl rand -hex 24)" \
  -e CYB_PUBLIC_URL=https://cyb.example.com \
  cybnate-server
```

Put it behind HTTPS (Caddy, nginx, or the host's own TLS). Without Docker: `cd server && CYB_ACCESS_KEY=... node index.js`.

| variable | meaning |
|---|---|
| `CYB_ACCESS_KEY` | **required**, 16+ characters. Typed once in the app to register a phone. |
| `CYB_PUBLIC_URL` | the https address phones use. Needed for Google / GitHub sign-in (redirect address `<url>/v1/oauth/callback`). |
| `CYB_DATA_DIR` | where everything is stored (default `./data`, `/data` in the image). Back this folder up. |
| `CYB_MASTER_KEY` | **required in production**: 64 hex characters (32 bytes) used to encrypt secrets and tokens. Keep it in a secret manager, outside the data volume. Development mode may create `<data>/master.key`; production refuses to start without this variable. Losing it makes stored secrets unreadable. |
| `CYB_CORS_ORIGINS` | comma-separated exact browser origins allowed to call the API (default: `https://appassets.androidplatform.net`). Add the exact web app origin if using the browser UI; do not use `*`. Requests without an `Origin` header (native clients) remain supported. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | a **Web application** OAuth client from Google Cloud (not the Android one). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | optional, a GitHub OAuth app. |
| `PORT` | default 8787. |
| `CYB_MAX_PARALLEL` / `CYB_MAX_TIMEOUT` | commands at once (4) / longest command in seconds (900). |
| `CYB_LSP_SERVERS` | JSON to add or replace language servers. |
| `CYB_ALLOW_SHARED=1` | accept several users although the server is not root (they can then read each other's files). |
| `CYB_ALLOW_PRIVATE=1` | let `http_request` reach addresses inside the server's own network. |
| `CYB_TRUST_PROXY=1` | read the caller's address from `X-Forwarded-For`. |

## What protects what

- Browser API access uses an exact origin allowlist (`CYB_CORS_ORIGINS`); wildcard CORS is not used. Native clients without an `Origin` header remain supported.
- A phone registers with the access key and gets its own token; the database stores only a hash of it.
- Secrets and sign-in tokens are encrypted (AES-256-GCM). There is no call that returns a secret value. A command gets a secret only when the request names it, and the value is replaced by `***` in the output.
- Each user has an own folder. When the server runs as root (the Docker image) each user's commands also run under an own Unix user id, so one user cannot read another's files, the database or the key. Not as root: one user only.
- Paths that leave the workspace are refused, and a batch with one bad path writes nothing.
- A user's command can do anything that Unix user can do inside the container, including using the network. The container is the outer wall: no `--privileged`, no Docker socket, nothing else valuable on that machine.

## Concurrency and data safety

- One SQLite database in WAL mode holds users, secrets, sign-ins, saved state, replay records and the cache.
- One user's commands run one after another (they share a folder); different users run side by side up to the limit; beyond a short queue the server answers 429 instead of piling up.
- Requests may carry `Idempotency-Key`. A repeat gets the first answer and the work runs once, also when the repeat arrives while the first is still running or after a restart. The app sends one with every command and file transfer.
- Saved state (`/v1/state/<key>`) is versioned: a write based on an old version is refused with the current value, so two writers cannot silently overwrite each other.
- Token renewal is done once even when several requests need it at the same moment.
- Long commands send a space every 15 s so phones and proxies do not drop the connection.

## Why this is not "serverless"

Function platforms (Vercel functions, Supabase Edge Functions, Lambda and similar) start a short-lived process per request with no lasting disk. This backend needs the opposite: a shell that runs for minutes, language servers that stay alive between requests, and a disk for workspaces and the database. So it is one small always-on container with a volume. Any host that runs a Docker image with a persistent disk works.

## Compatibility of the existing code

| part | result |
|---|---|
| Android dependencies (`androidx.webkit` 1.11.0, `play-services-auth` 21.2.0) | unchanged. Play services sign-in is used only without a server. |
| Native HTTP bridge | works with the API as is: it sends PUT/DELETE and bodies, and the manifest already allows plain http for a server on a home network. Its 180 s read limit is why long commands send keep-alive spaces. |
| `wire.js` (Codex) | request bodies and the stream parser are unchanged; with a server the request goes to `/v1/llm/codex/responses` and the server adds the token. |
| OpenAI-compatible providers, Anthropic, `github.js` | unchanged, still called from the phone. |
| `cli.js` curl | unchanged parser; its request function is switched to the server. |
| Pyodide / JS worker runtimes | still bundled, used only without a server. |
| Server | Node ≥ 22.13 for the built-in `node:sqlite` (Node 22 prints an "experimental" notice for it). No third-party packages. |

## API

All calls except `health`, `register` and the OAuth callback need `Authorization: Bearer <token>`.

```
GET    /v1/health
POST   /v1/auth/register {accessKey,name}        -> {userId, token}
POST   /v1/auth/logout
GET    /v1/files                                  -> [{path,size,sha1}]
POST   /v1/files/sync {write:[{path,b64|text}], remove:[path]}
POST   /v1/files/read {paths}
POST   /v1/exec {command,timeoutSec,secrets,id}   -> {code,out,timedOut,stopped,changed,deleted}
POST   /v1/exec/:id/cancel
GET    /v1/secrets        PUT/DELETE /v1/secrets/:name {value}
POST   /v1/http {url,method,headers,body,secrets} -> {status,headers,text}
GET    /v1/oauth          POST /v1/oauth/:provider/start {scopes} -> {url}     DELETE /v1/oauth/:provider
POST   /v1/oauth/codex/device   GET /v1/oauth/codex/status   DELETE /v1/oauth/codex/device
GET    /v1/llm/codex/models     POST /v1/llm/codex/responses (streamed)
POST   /v1/lsp/diagnostics {path}   POST /v1/lsp/:lang/request {method,params,path}   DELETE /v1/lsp/:lang
GET    /v1/state   GET/PUT/DELETE /v1/state/:key {value, baseVersion}
```

## Tests

```
node server/test/server.test.js            # real server, real bash/python/git, fake OpenAI + Google, fake language server
sudo node server/test/isolation.test.js    # users kept apart (needs root)
NODE_PATH=<jsdom> node tests/backend.test.js   # the app against the real server
```
