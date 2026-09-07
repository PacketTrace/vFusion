# Deploying

Everything about running vFusion: the one-time bootstrap, the two public-URL modes, the optional profiles, every environment variable, updating, backups and troubleshooting.

## Requirements

- **A host**: Linux, macOS or Windows, always-on for 24/7 capture or spun up for a session. Docker is the only thing installed on it; Postgres, Redis, Python, Node, ffmpeg and yt-dlp all run in containers.
- **Docker Desktop**, or Docker Engine with Compose v2.
- **A Verkada Command org** with admin access, and an **API key** scoped to what your flows need and nothing more.
- Optional: a **Gemini API key** (analysis, composers, help, video), a **Cloudflare account and domain** (lab mode only), **Tailscale or a VPN** for remote admin access, an **OpenWeatherMap key** (weather action).

## Bootstrap

```bash
git clone https://github.com/PacketTrace/vFusion.git
cd vFusion
cp .env.example .env
```

`.env` is a hidden file; `ls -a` shows it. Nothing in it needs editing for a same-machine install. The cookie-signing key and the encryption key generate themselves on first boot and persist in the `vfusion_secrets` volume.

**Browsing from another machine** (the stack on a NUC, you on a laptop): set both of these to the host's LAN address, then open `http://<host-ip>:15173`.

```
VITE_API_BASE=http://<host-ip>:18080
CORS_ORIGINS=http://<host-ip>:15173
```

## Quick mode

A free, random `https://<words>.trycloudflare.com` URL. No Cloudflare account. The URL changes every time the tunnel restarts.

```bash
docker compose --profile quick up --build -d
```

Open `http://localhost:15173`. Set the admin password. The welcome modal shows **Stack is healthy** once every container is up, your public URL, and a **Generate signing secret** button. In Command: **Admin → API & Integrations → Webhooks → Add**, paste the URL and the secret, pick the events, save. The first webhook to arrive unlocks the dashboard and creates the Verkada connection; add the API key under Settings → Connections.

Through the tunnel, only `POST /hooks/verkada` is reachable. A Caddy proxy answers 404 to everything else.

## Lab mode

A stable URL on your own domain through a named Cloudflare tunnel.

1. Start the stack without the tunnel and confirm **Stack is healthy**:
   ```bash
   docker compose up --build -d
   ```
2. In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/): **Networks → Tunnels → Create a tunnel → Cloudflared**, name it, save, and copy the token out of the install command (the long string after `--token`).
3. **Add a public hostname**: subdomain `hooks`, your domain, path blank, service `HTTP` → `backend:8000`.
4. Turn off **Bot Fight Mode** for the domain (Security → Bots), or add a WAF skip rule for `/hooks/*`. It silently blocks Verkada's senders otherwise.
5. Add the token and start the tunnel:
   ```bash
   echo "CF_TUNNEL_TOKEN=<token>" >> .env
   docker compose --profile cloudflared up -d
   docker compose logs cloudflared | grep -i "registered tunnel connection"
   ```
6. In Command, add the webhook at `https://hooks.yourdomain.com/hooks/verkada` with a generated signing secret, as in quick mode.

Set `PUBLIC_WEBHOOK_BASE=https://hooks.yourdomain.com` in `.env` so the dashboard shows the right URL. Never set it to a LAN address; Verkada's cloud has to reach it.

## Optional profiles

| Profile | Adds | For |
|---|---|---|
| `quick` | `caddy-quick`, `cloudflared-quick` | The free TryCloudflare URL |
| `cloudflared` | `cloudflared` | Your own domain |
| `mqtt` | `mqtt-broker`, `mqtt-tls` | Object-position streaming from cameras. Port 443 on the host. [MQTT](mqtt.md) |
| `rtsp` | `rtsp-server` | The virtual camera. Ports 8554 (RTSP) and 8090 (ONVIF). [Virtual camera](virtual-camera.md) |
| `test` | `e2e` | The Playwright suite. `docker compose --profile test run --rm e2e` |

Profiles combine: `docker compose --profile cloudflared --profile mqtt --profile rtsp up -d`.

## Services

| Service | Host port | Notes |
|---|---|---|
| `frontend` | 15173 | Vite, React, Tailwind, React Flow |
| `backend` | 18080, 8090 | FastAPI. Runs migrations on start. 8090 is the ONVIF mapping onto the same container |
| `worker` | — | arq: flow runs, schedules, the audit-log poller, MCP checks, catalog crawl, cleanup |
| `postgres` | — | internal only |
| `redis` | — | internal only |
| `cloudflared` / `cloudflared-quick` | — | tunnels |
| `caddy-quick` | — | path filter in front of the quick tunnel |
| `mqtt-broker` | — | Mosquitto, internal |
| `mqtt-tls` | 443 | nginx terminating TLS and WebSocket for cameras |
| `rtsp-server` | 8554 | MediaMTX |
| `e2e` | — | Playwright, profile `test` only |

Volumes: `postgres_data`, `webhook_assets` (clips, frames, uploads, and every file-backed store), `vfusion_secrets` (the two keys).

## Environment reference

| Variable | Default | What it does |
|---|---|---|
| `SECRET_KEY` | generated | Signs session cookies. Leave blank. |
| `FERNET_KEY` | generated | Encrypts stored credentials. Leave blank unless a secrets manager owns it. |
| `CORS_ORIGINS` | `http://localhost:15173` | Origins the API accepts. |
| `VITE_API_BASE` | `http://localhost:18080` | Where the dashboard sends API calls. |
| `VITE_ALLOWED_HOSTS` | any | Host headers the dev server accepts. |
| `CF_TUNNEL_TOKEN` | — | Lab mode tunnel token. |
| `PUBLIC_WEBHOOK_BASE` | auto | The public URL shown in the UI. Lab mode only. |
| `RTSP_PUBLIC_PORT` | `8554` | Virtual camera RTSP port. |
| `ONVIF_PUBLIC_PORT` | `8090` | Virtual camera ONVIF port. |
| `GEOIP_PROVIDER` | `ip-api` | `off` disables audit-log IP geolocation. |
| `LIVE_MAX_SESSIONS` | `3` | Concurrent live-camera transcodes. |
| `E2E_PASSWORD` | — | The admin password, for the test profile only. |

## Vault-backed secrets

`.env` is plaintext on disk. For anything beyond a demo, render it from a template at deploy time. The bundled `deploy.sh` does this with the 1Password CLI when `/etc/op-token` and a gitignored `.env.tpl` exist, and falls back to a hand-managed `.env` when they do not:

```
SECRET_KEY=op://YourVault/vFusion/SECRET_KEY
FERNET_KEY=op://YourVault/vFusion/FERNET_KEY
```

```bash
./deploy.sh                  # pull, render .env, rebuild everything
./deploy.sh backend worker   # rebuild only these
```

The same pattern works with any secrets manager that can render a file.

## Updating

```bash
git pull
docker compose --profile <your profiles> up --build -d
```

Migrations run on backend boot. The `worker` image must be rebuilt alongside `backend`; a deploy that rebuilds only one leaves them on different code.

## Backups

- `vfusion_secrets` holds the master key. Losing it means losing every stored credential:
  ```bash
  docker run --rm -v vfusion_secrets:/src -v $PWD:/dst alpine tar czf /dst/vfusion-secrets-backup.tar.gz -C /src .
  ```
- `postgres_data` holds everything else. Back it up before any upgrade that adds a migration.

## Recovering a lost admin password

There is no reset email by design. Delete the hash and the setup wizard returns:

```bash
docker compose exec postgres psql -U verkada -d vfusion \
  -c "DELETE FROM app_settings WHERE key='admin_password_hash';"
```

## Troubleshooting

- **A container did not come up:** `docker compose logs --tail=50 -f <service>`.
- **Webhooks never arrive in lab mode:** Bot Fight Mode, almost always.
- **Every Verkada call fails 401/403:** the connection's region does not match the org.
- **Verkada answers 403 for something you have permission for:** it also answers 403 for a path it does not serve. The two are indistinguishable.
- **Did that deploy?** Settings → Stats shows the build id and process start time.
- **Frontend dependency conflicts on pull:** the frontend container reinstalls on every boot, so `git checkout -- frontend/package-lock.json` before `git pull`.
