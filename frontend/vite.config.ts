import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite's dev server enforces a host allowlist as a DNS-rebinding
// defense (CVE-2025-30208). By default it allows localhost +
// 127.0.0.1 + the host listed in ``server.host`` — anything else
// (typically a public hostname pointed at the dev server via a
// reverse proxy / Cloudflare tunnel) is rejected with a
// ``Blocked request. This host is not allowed`` page.
//
// vFusion is meant to be reached through whatever name the operator
// configured (homelab.example.com, a tailscale magic DNS name,
// dashboard.bouncer.network, etc.), so we expose the allowlist as
// the ``VITE_ALLOWED_HOSTS`` env var:
//
//   - ``VITE_ALLOWED_HOSTS=`` (unset / empty) → allow ANY host. Safe
//     default for a dashboard that's supposed to be LAN/VPN-only
//     anyway (the dashboard's own bcrypt password is the real
//     access control); avoids the "just got a tunnel set up, why
//     does the page say Blocked request" footgun.
//   - ``VITE_ALLOWED_HOSTS=dash.example.com,homelab.local`` → only
//     those hostnames pass. Use this when you do want the rebinding
//     protection.
//
// Parsed at vite-startup time, so a change requires a frontend
// container restart (``docker compose restart frontend``).
const rawAllowed = (process.env.VITE_ALLOWED_HOSTS ?? "").trim();
const allowedHosts: true | string[] = rawAllowed
  ? rawAllowed.split(",").map((s) => s.trim()).filter(Boolean)
  : true;

// index.html loads /config.js unconditionally, because the published
// image writes per-deployment settings there at container start. In dev
// there is no such file, and a 404 in the console on every page load is
// the kind of noise that trains people to ignore the console. Serve an
// empty one instead: absent values fall through to Vite's env vars,
// which is exactly the dev behaviour.
const devRuntimeConfig = {
  name: "vfusion-dev-config",
  configureServer(server: { middlewares: { use: (p: string, h: unknown) => void } }) {
    server.middlewares.use("/config.js", (_req: unknown, res: any) => {
      res.setHeader("Content-Type", "application/javascript");
      res.end("/* dev: see release/entrypoint.sh */\n");
    });
  },
};

export default defineConfig({
  plugins: [react(), devRuntimeConfig],
  server: {
    host: "0.0.0.0",
    port: 5173,
    watch: { usePolling: true },
    allowedHosts,
  },
});
