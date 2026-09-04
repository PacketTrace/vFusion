import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost, apiPut, Connection } from "../lib/api";

/**
 * Security posture, measured rather than asserted.
 *
 * Every row here is read from the running install. A checklist that
 * reads identically on a healthy install and a compromised one is
 * decoration -- the value is in saying "your signing key is the
 * published default", which no static row can do.
 */

// Same shell as the Stats cards. Local rather than shared because that
// one is local too -- extracting it is a separate change from this one.
function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      {title && (
        <h2 className="text-xs uppercase tracking-wider text-slate-400 mb-3">
          {title}
        </h2>
      )}
      {children}
    </div>
  );
}

interface KeyStatus {
  name: string;
  source: string;
  ok: boolean;
  detail: string;
  created_at: string | null;
  path: string | null;
}

interface PublicPath {
  path: string;
  label: string;
  auth: string;
  why: string;
  concern: string | null;
}

interface KeywatchAlert {
  ip: string;
  first_seen: string | null;
  last_seen: string | null;
  count: number;
  urls: string[];
  raised_at: string;
}

interface KeywatchState {
  expected_ips: string[];
  self_ip: string | null;
  observed: Record<string, { first: string; last: string; count: number; urls: string[] }>;
  alerts: KeywatchAlert[];
  denied_count: number;
  denied_last: string | null;
  last_check: string | null;
  last_success: string | null;
  last_error: string | null;
  events_seen: number;
  scanned_rows?: number;
  requests_used: number;
  truncated?: boolean;
}

interface Overview {
  keys: KeyStatus[];
  sessions: {
    epoch: number;
    lifetime_days: number;
    cookie: { httponly: boolean; samesite: string; secure: boolean };
    request_scheme: string;
    throttle: {
      recent_failures: number;
      total_failures_since_boot: number;
      locked: boolean;
      retry_after_sec: number;
      last_failure_ago_sec: number;
      free_attempts: number;
    };
  };
  exposure: {
    public_paths: PublicPath[];
    cors_origins: string[];
    docs_enabled: boolean;
  };
  data: {
    storage: { label: string; bytes: number; files: number }[];
    retention: { key: string; label: string; unit: string; value: string; is_default: boolean }[];
    redactions: { what: string; detail: string }[];
  };
  keywatch: {
    enabled: boolean;
    connection_id: string | null;
    interval_hours: number;
    state: KeywatchState;
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** A finding, not a tick. Green states say what is true, not "OK". */
function Row({
  ok,
  title,
  children,
}: {
  ok: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 py-2.5 border-t border-white/10 first:border-t-0">
      <span
        className={`mt-1.5 h-2 w-2 rounded-full flex-none ${
          ok ? "bg-emerald-400" : "bg-amber-400"
        }`}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="text-sm text-slate-200">{title}</div>
        <div className="text-xs text-slate-400 mt-0.5">{children}</div>
      </div>
    </div>
  );
}

export default function Security() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["security-overview"],
    queryFn: () => apiGet<Overview>("/api/security/overview"),
    refetchInterval: 60_000,
  });
  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [ipDraft, setIpDraft] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["security-overview"] });

  const changePw = useMutation({
    mutationFn: () =>
      apiPost<{ changed: boolean }>("/api/security/password", {
        current_password: current,
        new_password: next,
      }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setPwErr(null);
      setPwMsg("Password changed. Every other session was signed out.");
      invalidate();
    },
    onError: (e: Error) => {
      setPwMsg(null);
      setPwErr(e.message);
    },
  });

  const signOutAll = useMutation({
    mutationFn: () => apiPost("/api/security/sign-out-everywhere", {}),
    onSuccess: () => window.location.reload(),
  });

  const saveWatch = useMutation({
    mutationFn: (cfg: { enabled: boolean; connection_id: string | null; interval_hours: number }) =>
      apiPut("/api/security/keywatch", cfg),
    onSuccess: () => {
      setWatchErr(null);
      invalidate();
    },
    onError: (e: Error) => setWatchErr(e.message),
  });

  const [watchErr, setWatchErr] = useState<string | null>(null);
  const checkNow = useMutation({
    mutationFn: () => apiPost<KeywatchState>("/api/security/keywatch/check", {}),
    onSuccess: (st) => {
      setWatchErr(st.last_error);
      invalidate();
    },
    onError: (e: Error) => setWatchErr(e.message),
  });

  const resolveAlert = useMutation({
    mutationFn: (v: { ip: string; adopt: boolean }) =>
      apiPost("/api/security/keywatch/alerts/resolve", v),
    onSuccess: invalidate,
  });

  const setIps = useMutation({
    mutationFn: (ips: string[]) => apiPost("/api/security/keywatch/expected-ips", { ips }),
    onSuccess: () => {
      setIpDraft("");
      invalidate();
    },
    onError: (e: Error) => setWatchErr(e.message),
  });

  if (q.isLoading) {
    return <div className="text-sm text-slate-400">Reading the install…</div>;
  }
  if (q.error || !q.data) {
    return (
      <div className="text-sm text-rose-300">
        Could not read security status: {(q.error as Error)?.message}
      </div>
    );
  }
  const s = q.data;
  const kw = s.keywatch;
  const st = kw.state;
  const verkadaConns = (conns.data ?? []).filter((c) => c.type === "verkada");
  const storageTotal = s.data.storage.reduce((a, b) => a + b.bytes, 0);

  return (
    <div className="space-y-6">
      {/* ---- Keys ---- */}
      <Card title="Keys this install stands on">
        {s.keys.map((k) => (
          <Row key={k.name} ok={k.ok} title={`${k.name} — ${k.source}`}>
            {k.detail}
            {k.created_at && (
              <span className="text-slate-500"> Created {ago(k.created_at)}.</span>
            )}
          </Row>
        ))}
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  "Re-encrypt every stored credential under a new key? The old key is kept as fernet.key.prev so this is reversible.",
                )
              ) {
                apiPost("/api/security/fernet/rotate", {}).then(invalidate);
              }
            }}
            className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 text-slate-200"
          >
            Rotate credential key
          </button>
          <span className="text-[11px] text-slate-500">
            Neither key is ever shown here — back up the{" "}
            <code className="text-slate-400">vfusion_secrets</code> volume instead.
          </span>
        </div>
      </Card>

      {/* ---- Sign-in ---- */}
      <Card title="Sign-in and sessions">
        <Row ok={!s.sessions.throttle.locked} title="Password guessing">
          {s.sessions.throttle.free_attempts} attempts are free, then each wrong
          answer doubles a cooldown.{" "}
          {s.sessions.throttle.total_failures_since_boot > 0
            ? `${s.sessions.throttle.total_failures_since_boot} failed attempt(s) since the last restart, most recent ${
                s.sessions.throttle.last_failure_ago_sec >= 0
                  ? `${Math.round(s.sessions.throttle.last_failure_ago_sec / 60)}m ago`
                  : "unknown"
              }.`
            : "No failed attempts since the last restart."}
          {s.sessions.throttle.locked &&
            ` Currently locked for ${s.sessions.throttle.retry_after_sec}s.`}
        </Row>
        <Row ok={s.sessions.cookie.secure || s.sessions.request_scheme !== "https"} title="Session cookie">
          HttpOnly, SameSite={s.sessions.cookie.samesite}, {s.sessions.lifetime_days}-day
          expiry.{" "}
          {s.sessions.cookie.secure
            ? "Secure flag set."
            : s.sessions.request_scheme === "https"
              ? "Secure is off but you are on HTTPS — the cookie could be hardened."
              : "Secure is off so the cookie works over plain http on a LAN."}
        </Row>
        <Row ok title="Revocation">
          Signing out everywhere invalidates every cookie ever issued, including
          this browser's. Changing the password does the same automatically.
        </Row>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <div className="text-xs text-slate-300 mb-1">Current password</div>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            />
          </label>
          <label className="block">
            <div className="text-xs text-slate-300 mb-1">New password</div>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            />
          </label>
          <label className="block">
            <div className="text-xs text-slate-300 mb-1">Confirm</div>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            disabled={
              !current || !next || next !== confirm || changePw.isPending
            }
            onClick={() => changePw.mutate()}
            className="text-sm px-4 py-2 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {changePw.isPending ? "Changing…" : "Change password"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Sign out every session, including this one?")) {
                signOutAll.mutate();
              }
            }}
            className="text-sm px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 text-slate-200"
          >
            Sign out everywhere
          </button>
          {next && confirm && next !== confirm && (
            <span className="text-xs text-amber-300">Passwords don't match.</span>
          )}
          {pwMsg && <span className="text-xs text-emerald-300">{pwMsg}</span>}
          {pwErr && <span className="text-xs text-rose-300">{pwErr}</span>}
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          There is no reset path. Forgetting this password means editing the
          database directly — that is deliberate, and it is why changing it
          requires the current one.
        </p>
      </Card>

      {/* ---- Key leak monitor ---- */}
      <Card title="API key use from unexpected IPs">
        <p className="text-xs text-slate-400 mb-3">
          Every call made with a Verkada key is logged with the IP it came from.
          If this key is issued to vFusion and nothing else, a second address
          means a second holder. Checks run every {kw.interval_hours}h and only
          ever alert — nothing is disabled automatically.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <div className="text-xs text-slate-300 mb-1">Watch this connection</div>
            <select
              value={kw.connection_id ?? ""}
              onChange={(e) =>
                saveWatch.mutate({
                  enabled: kw.enabled,
                  connection_id: e.target.value || null,
                  interval_hours: kw.interval_hours,
                })
              }
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            >
              <option value="">— not watching —</option>
              {verkadaConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-xs text-slate-300 mb-1">Check every</div>
            <select
              value={kw.interval_hours}
              onChange={(e) =>
                saveWatch.mutate({
                  enabled: kw.enabled,
                  connection_id: kw.connection_id,
                  interval_hours: Number(e.target.value),
                })
              }
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            >
              <option value={1}>Hour</option>
              <option value={6}>6 hours</option>
              <option value={24}>Day</option>
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() =>
                saveWatch.mutate({
                  enabled: !kw.enabled,
                  connection_id: kw.connection_id,
                  interval_hours: kw.interval_hours,
                })
              }
              disabled={!kw.connection_id && !kw.enabled}
              className={`text-sm px-4 py-2 rounded-md w-full disabled:opacity-40 ${
                kw.enabled
                  ? "bg-emerald-700 hover:bg-emerald-600 text-white"
                  : "bg-white/10 hover:bg-white/15 text-slate-200"
              }`}
            >
              {kw.enabled ? "Monitoring on" : "Monitoring off"}
            </button>
          </div>
        </div>

        {/* Cost, measured from this org rather than assumed. */}
        <div className="mt-3 text-[11px] text-slate-500">
          {st.scanned_rows != null && st.scanned_rows > 0 ? (
            <>
              Last check read {st.scanned_rows.toLocaleString()} audit events in{" "}
              {st.requests_used} API request
              {st.requests_used === 1 ? "" : "s"} — about{" "}
              {Math.max(1, Math.round((st.requests_used * 24) / kw.interval_hours))}{" "}
              requests/day at this interval. No Gemini, no tokens: this is an
              HTTP poll and a set comparison.
            </>
          ) : (
            <>
              Cost is one API request per 200 audit events, plus one heartbeat per
              check. The estimate here fills in from your own volume after the
              first check.
            </>
          )}
        </div>

        {st.last_error && (
          <div className="mt-3 rounded border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-200">
            Last check failed: {st.last_error}
          </div>
        )}

        {kw.enabled && !st.last_error && (
          <div
            className={`mt-3 rounded border p-2 text-xs ${
              !st.last_success ||
              Date.now() - new Date(st.last_success).getTime() >
                kw.interval_hours * 3600_000 * 2
                ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
                : "border-white/10 text-slate-400"
            }`}
          >
            Last successful check {ago(st.last_success)}
            {st.last_check && st.last_check !== st.last_success
              ? `, last attempted ${ago(st.last_check)}`
              : ""}
            .
            {!st.last_success ||
            Date.now() - new Date(st.last_success).getTime() >
              kw.interval_hours * 3600_000 * 2
              ? " Nothing has completed yet — press Check now, and if it reports nothing, the error will appear here."
              : ""}
          </div>
        )}

        {st.alerts.length > 0 && (
          <div className="mt-3 space-y-2">
            {st.alerts.map((a) => (
              <div
                key={a.ip}
                className="rounded border border-rose-500/40 bg-rose-500/10 p-3"
              >
                <div className="text-sm text-rose-200">
                  <b>{a.ip}</b> used this key {a.count.toLocaleString()} time
                  {a.count === 1 ? "" : "s"}
                </div>
                <div className="text-xs text-slate-300 mt-1">
                  {a.first_seen} → {a.last_seen}
                </div>
                {a.urls.length > 0 && (
                  <div className="text-[11px] text-slate-400 mt-1 font-mono">
                    {a.urls.join(", ")}
                  </div>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => resolveAlert.mutate({ ip: a.ip, adopt: true })}
                    className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 text-slate-200"
                  >
                    That's me — expect this IP
                  </button>
                  <button
                    type="button"
                    onClick={() => resolveAlert.mutate({ ip: a.ip, adopt: false })}
                    className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 text-slate-200"
                  >
                    Dismiss
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 mt-2">
                  vFusion cannot rotate a Verkada key — there is no API for it.
                  Revoke and reissue it in Command, then update the connection.
                </p>
              </div>
            ))}
          </div>
        )}

        {kw.enabled && st.alerts.length === 0 && st.last_check && !st.last_error && (
          <div className="mt-3 text-xs text-emerald-300">
            Only expected addresses have used this key.{" "}
            <span className="text-slate-500">
              This detects use, not possession — a leaked key sitting unused
              looks the same as a safe one.
            </span>
          </div>
        )}

        {/* Expected IPs */}
        <div className="mt-4">
          <div className="text-xs text-slate-300 mb-1">
            Expected addresses{" "}
            {st.self_ip && (
              <span className="text-slate-500">
                (vFusion's own egress is {st.self_ip})
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {st.expected_ips.map((ip) => (
              <span
                key={ip}
                className="text-xs px-2 py-1 rounded bg-white/5 border border-white/15 text-slate-200 font-mono"
              >
                {ip}
                <button
                  type="button"
                  onClick={() =>
                    setIps.mutate(st.expected_ips.filter((x) => x !== ip))
                  }
                  className="ml-2 text-slate-500 hover:text-rose-300"
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
            <input
              value={ipDraft}
              onChange={(e) => setIpDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ipDraft.trim()) {
                  setIps.mutate([...st.expected_ips, ipDraft.trim()]);
                }
              }}
              placeholder="add an IP + Enter"
              className="text-xs px-2 py-1 rounded bg-white/5 border border-white/15 w-40"
            />
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            A list, because the backend and worker could run on different hosts.
            Only works if nothing else uses this key — if a second address shows
            up in the first hour, the key is shared rather than leaked.
          </p>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => checkNow.mutate()}
            disabled={!kw.connection_id || checkNow.isPending}
            className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 text-slate-200 disabled:opacity-40"
          >
            {checkNow.isPending ? "Checking…" : "Check now"}
          </button>
          {watchErr && (
            <span className="text-xs text-rose-300">Check failed: {watchErr}</span>
          )}
          {checkNow.isSuccess && !watchErr && (
            <span className="text-xs text-emerald-300">
              Read {(st.scanned_rows ?? 0).toLocaleString()} audit events in{" "}
              {st.requests_used} request{st.requests_used === 1 ? "" : "s"};{" "}
              {st.events_seen.toLocaleString()} were on this key.
            </span>
          )}
          {st.denied_count > 0 && (
            <span className="text-xs text-amber-300">
              {st.denied_count} denied (401/403) response
              {st.denied_count === 1 ? "" : "s"} on this key — often how a
              stolen key looks while somebody maps what it can reach.
            </span>
          )}
        </div>
      </Card>

      {/* ---- Exposure ---- */}
      <Card title="What answers without a session">
        {s.exposure.public_paths.map((p) => (
          <Row key={p.path} ok={!p.concern} title={`${p.path} — ${p.label}`}>
            Authenticated by: {p.auth}. {p.why}
            {p.concern && <span className="text-amber-300"> {p.concern}</span>}
          </Row>
        ))}
        <Row ok={s.exposure.cors_origins.length > 0} title="CORS origins">
          {s.exposure.cors_origins.length > 0
            ? s.exposure.cors_origins.join(", ")
            : "None configured."}
        </Row>
        {!s.exposure.docs_enabled && (
          <Row ok title="Interactive docs">
            Disabled — /docs, /redoc and /openapi.json return 404.
          </Row>
        )}
      </Card>

      {/* ---- Data ---- */}
      <Card title="Sensitive data at rest">
        <p className="text-xs text-slate-400 mb-3">
          Stored webhook payloads carry names, plates and badge data; clips and
          stills are footage of people. {fmtBytes(storageTotal)} on disk across{" "}
          {s.data.storage.reduce((a, b) => a + b.files, 0).toLocaleString()} files.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 mb-3">
          {s.data.storage.map((b) => (
            <span key={b.label} className="text-xs text-slate-400">
              <span className="text-slate-300">{b.label}</span> {fmtBytes(b.bytes)} ·{" "}
              {b.files.toLocaleString()} files
            </span>
          ))}
        </div>
        {s.data.redactions.map((r) => (
          <Row key={r.what} ok title={r.what}>
            {r.detail}
          </Row>
        ))}
        <div className="mt-3 text-xs text-slate-400">
          Retention:{" "}
          {s.data.retention
            .map((r) => `${r.label} ${r.value === "0" ? "forever" : `${r.value}${r.unit === "days" ? "d" : ""}`}`)
            .join(" · ")}
          .{" "}
          <a href="/settings?tab=retention" className="text-sky-400 hover:text-sky-300">
            Change on the Retention tab
          </a>
          .
        </div>
      </Card>
    </div>
  );
}
