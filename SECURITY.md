# Security policy

Thanks for taking the time to look at vFusion's security surface.

vFusion is a personal, beta-stage project — not a Verkada product, no SLA, no warranty. That said, it handles credentials with broad permissions on real physical-security infrastructure (Verkada API keys, webhook signing secrets, door-unlock capability), and bugs that compromise that handling are worth taking seriously.

## How to report a vulnerability

**Please do not open a public issue for security reports.**

Use GitHub's built-in Private Vulnerability Reporting:

1. Go to **<https://github.com/PacketTrace/vFusion/security/advisories/new>**.
2. Fill out the advisory form. Only repository maintainers see the contents.

If GitHub's reporting flow doesn't work for you for any reason, open a **public** GitHub issue with a single line — *"requesting a private security contact, please reach out"* — and the maintainer will follow up via a private channel. Do **not** include vulnerability details in the public issue.

## What we'd love in a report

The more of this you can include, the faster a fix lands:

- A short description of the vulnerability — what it lets an attacker do.
- The affected code path (file + line, or commit SHA).
- Reproduction steps, ideally against a fresh `docker compose up` of `main`. A minimal proof-of-concept beats prose.
- Your assessment of severity (best guess is fine — we'll calibrate).
- Whether you've notified anyone else, and whether you have a disclosure timeline in mind.

## Scope

In scope:

- The backend API (`backend/app/api/*`) — auth, session handling, secret read/write paths, webhook signature verification, IDOR / authz bugs on Connection / Flow / Run / WebhookEvent resources.
- The Verkada connector — anything that could leak API keys, bypass signature checks, or trigger door-unlock actions without a valid trigger.
- The frontend's secret-handling surface — anywhere an API key, signing secret, or Fernet-encrypted blob could leak into the DOM, network log, or browser storage.
- The Cloudflare tunnel / Caddy path-filter configuration in `caddy/` — anything that lets `POST /hooks/verkada` get bypassed or that exposes admin routes through the public tunnel.
- Encryption at rest — Fernet key derivation, persistence, or any way to decrypt without the key.

Out of scope (or already documented):

- **Anyone running the dashboard exposed to the public internet.** The README is explicit that the admin UI and backend should be LAN/VPN-only. Operator misconfiguration isn't a vulnerability we'll patch around — but if you spot something that makes "LAN-only" *unsafe even on a LAN*, that **is** in scope.
- Missing rate-limit on the single-user admin login — known and documented in the README's *What isn't protected (yet)* section. Treat the admin password like a shared API key.
- Free-tier Gemini's data-handling terms (Google may train on your camera footage if billing isn't enabled). Documented; not a vFusion bug.
- Third-party CVEs in dependencies that don't have a viable exploit path through vFusion's code — file an issue with details, but they won't go through the security-advisory flow.
- Social-engineering or physical access to a deployed host.

## Response expectations

Single maintainer, side project. Best-effort:

- Acknowledgment within a few business days.
- For confirmed vulnerabilities: a patch on a private branch, coordinated disclosure with credit (unless you'd rather stay anonymous), and a GitHub Security Advisory published when the fix ships to `main`.
- For not-vulnerabilities or out-of-scope reports: a short reply explaining why and a thank-you for the look.

## Safe-harbor

Good-faith security research on vFusion — meaning: research that doesn't exfiltrate someone else's data, doesn't target an operator's deployed instance without their permission, and gives a reasonable disclosure window — is welcome. No legal action will be pursued against researchers acting in good faith. If you're unsure whether something qualifies, ask first via the private advisory channel.

## Hall of fame

Reporters who help fix something material are credited (with permission) in the Security Advisory and in the project release notes for that fix.
