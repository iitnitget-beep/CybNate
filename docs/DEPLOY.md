# Deploying the CybNate server (production)

The server (`server/`) is one small always-on Docker container with a volume.
It needs a real disk and long-lived processes (shell, language servers), so
serverless function platforms do not work. See `docs/BACKEND.md` for the API
and every environment variable.

## Route A — home PC/laptop + Cloudflare Tunnel (free, recommended to start)

1. Install Docker on the PC.
2. Clone this repo, then:
   ```
   cd server
   cp .env.example .env
   # edit .env: set CYB_ACCESS_KEY (openssl rand -hex 24) and CYB_MASTER_KEY (openssl rand -hex 32)
   docker compose up -d --build
   curl http://127.0.0.1:8787/v1/health
   ```
3. Install `cloudflared` and create a tunnel to `http://localhost:8787`
   (Cloudflare Zero Trust → Networks → Tunnels; free plan is enough).
   You get an `https://…` address.
4. Set `CYB_PUBLIC_URL` in `.env` to that address and restart:
   `docker compose up -d`.
5. In the app: Settings → Server → paste the https address + access key.
   Plugins that need sign-in (GitHub, Google Workspace) light up.

## Route B — small VPS

Any host that runs Docker with a persistent disk. Same steps as Route A,
then put HTTPS in front with Caddy (`caddy reverse-proxy --from your.domain
--to localhost:8787`) or the host's TLS. Set `CYB_TRUST_PROXY=1` behind a
proxy.

## Route C — LAN only (testing)

Skip the tunnel: phone and PC on the same Wi-Fi, use
`http://<pc-lan-ip>:8787` in the app. Sign-in redirects need the public
https address, so Google/GitHub sign-in will not work on LAN-only.

## Sign-in providers (optional)

- Google: create a **Web application** OAuth client in Google Cloud,
  redirect URI `<CYB_PUBLIC_URL>/v1/oauth/callback`, put the id/secret in
  `.env`.
- GitHub: create an OAuth app with the same callback, id/secret in `.env`.
- Codex (ChatGPT) sign-in works without extra keys (device flow).

## Production checklist

- [ ] `CYB_ACCESS_KEY` set (16+ chars, random) and shared only with your phones
- [ ] `CYB_MASTER_KEY` set and backed up (losing it = stored secrets unreadable)
- [ ] HTTPS in front; `CYB_PUBLIC_URL` matches the public address
- [ ] Volume `cybnate-data` backed up regularly (database + workspaces)
- [ ] Container not privileged, no Docker socket mounted, nothing else
      valuable on the host (user commands can use the network)
- [ ] `curl <public-url>/v1/health` returns `{"ok":true,...}`
- [ ] App connects: Settings → Server shows connected; Plugins Connect works

## Updating

```
git pull
cd server && docker compose up -d --build
```

Data stays in the volume. Check `/v1/health` after every update.
