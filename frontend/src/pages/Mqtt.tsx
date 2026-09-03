import { useEffect, useMemo, useRef, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";

import { API_BASE, apiDelete, apiGet, apiPost } from "../lib/api";
import { useCameras } from "../lib/cameras";

interface MqttStatus {
  connected: boolean;
  enabled: boolean;
  host: string;
  topic: string;
  last_error: string | null;
  uptime_sec: number | null;
  total_messages: number;
  cameras: string[];
  track_timeout_sec: number;
  ca_present: boolean;
  credentials_present: boolean;
  broker_username: string | null;
}

interface PreflightCheck {
  id: string;
  label: string;
  state: "ok" | "fail" | "unknown";
  detail: string;
  fix: string | null;
}

interface LiveObject {
  obj_id: string;
  type: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  age: number;
}

interface LiveCamera {
  objects: LiveObject[];
  counts: Record<string, number>;
  total: number;
  age_sec: number | null;
}

const TYPE_COLOR: Record<string, string> = {
  person: "#38bdf8",
  vehicle: "#fbbf24",
  animal: "#a78bfa",
};

export default function Mqtt() {
  const cameras = useCameras();
  const [cameraId, setCameraId] = useState("");
  const [brokerHostPort, setBrokerHostPort] = useState("");

  const status = useQuery({
    queryKey: ["mqtt-status"],
    queryFn: () => apiGet<MqttStatus>("/api/mqtt/status"),
    refetchInterval: 5000,
  });

  const preflight = useQuery({
    queryKey: ["mqtt-preflight", cameraId],
    queryFn: () => apiGet<PreflightCheck[]>(`/api/mqtt/preflight/${cameraId}`),
    enabled: !!cameraId,
  });

  const current = useQuery({
    queryKey: ["mqtt-config", cameraId],
    queryFn: () => apiGet<Record<string, unknown>>(`/api/mqtt/config/${cameraId}`),
    enabled: !!cameraId,
    retry: false,
  });

  const configure = useMutation({
    mutationFn: () =>
      apiPost<{ persisted: boolean; note: string }>(`/api/mqtt/config/${cameraId}`, {
        broker_host_port: brokerHostPort,
      }),
    onSuccess: () => {
      preflight.refetch();
      current.refetch();
    },
  });

  const [setupHost, setSetupHost] = useState("");
  const setup = useMutation({
    mutationFn: () =>
      apiPost<{
        broker_host_port: string;
        username: string;
        san: string;
        expires: string;
        next_steps: string[];
      }>("/api/mqtt/setup", { broker_host: setupHost }),
    onSuccess: (d) => {
      // The address carries into step 2. The password deliberately does
      // not exist here — it is stored server-side and used directly.
      setBrokerHostPort(d.broker_host_port);
      status.refetch();
    },
  });

  // Dry run: build the outbound request and show it without sending.
  const preview = useMutation({
    mutationFn: () =>
      apiPost<{ dry_run: boolean; request: unknown }>(
        `/api/mqtt/config/${cameraId}?dry_run=true`,
        { broker_host_port: brokerHostPort },
      ),
  });

  const reset = useMutation({
    mutationFn: () => apiPost<{ removed: string[]; note: string }>("/api/mqtt/reset", {}),
    onSuccess: () => {
      setBrokerHostPort("");
      status.refetch();
    },
  });

  const clearCamera = useMutation({
    mutationFn: () => apiDelete(`/api/mqtt/config/${cameraId}`),
    onSuccess: () => {
      current.refetch();
      preflight.refetch();
    },
  });

  const live = useLiveTracks(cameraId);

  const online = useMemo(
    () =>
      (cameras.data ?? [])
        .filter((c) => c.status && c.status.toLowerCase() !== "offline")
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [cameras.data],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Object position</h1>
        <p className="text-slate-300 text-sm mt-1 max-w-3xl">
          Point a camera at vFusion's MQTT broker and watch what it reports.
          Cameras publish bounding boxes for people, vehicles and animals about
          eight times a second — this is that stream, unedited.
        </p>
      </div>

      <StatusBar status={status.data} />

      <Card title="0 · Set up the broker">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[16rem]">
            <Labeled label="Address cameras will connect to">
              <input
                value={setupHost}
                onChange={(e) => setSetupHost(e.target.value)}
                placeholder="192.168.1.10"
                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sm font-mono"
                spellCheck={false}
              />
            </Labeled>
          </div>
          <button
            onClick={() => setup.mutate()}
            disabled={!setupHost || setup.isPending}
            className="text-sm px-3 py-1.5 rounded border border-slate-600 text-slate-200 hover:border-sky-500 disabled:opacity-40"
          >
            {setup.isPending ? "Generating…" : "Generate certificate + credentials"}
          </button>
          <button
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
            className="text-sm px-3 py-1.5 rounded border border-slate-700 text-slate-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-40"
            title="Delete the generated certificate, password file and credentials"
          >
            {reset.isPending ? "Clearing…" : "Clear broker setup"}
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mt-2 max-w-2xl">
          Host or IP only — the port is always 443. This address is written into
          the certificate, so changing it later means regenerating and re-pushing
          every camera. Use something that will not move: a static IP, a DHCP
          reservation or a DNS name.
        </p>
        {setup.isError && (
          <p className="text-xs text-rose-300 mt-2">{(setup.error as Error).message}</p>
        )}
        {setup.data && (
          <div className="mt-3 text-xs space-y-2">
            <p className="text-emerald-300">
              Certificate written for {setup.data.san}, valid to {setup.data.expires}.
            </p>
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
              <p className="text-amber-200">
                Shown once — the broker keeps only a hash of it.
              </p>
              {setup.data.next_steps.map((line) => (
                <pre
                  key={line}
                  className="font-mono text-[11px] text-slate-300 whitespace-pre-wrap break-all"
                >
                  {line}
                </pre>
              ))}
            </div>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="1 · Pick a camera">
          <select
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm"
          >
            <option value="">— choose a camera —</option>
            {online.map((c) => (
              <option key={c.camera_id} value={c.camera_id}>
                {c.name ?? "(unnamed)"}
                {c.site ? ` — ${c.site}` : ""}
              </option>
            ))}
          </select>

          {preflight.data && (
            <ul className="mt-3 space-y-2">
              {preflight.data.map((c) => (
                <li key={c.id} className="text-sm flex gap-2">
                  <StateDot state={c.state} />
                  <div className="min-w-0">
                    <div className="text-slate-200">{c.label}</div>
                    <div className="text-[11px] text-slate-500">{c.detail}</div>
                    {c.fix && c.state !== "ok" && (
                      <div className="text-[11px] text-amber-400/80 mt-0.5">{c.fix}</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="2 · Point it at this broker">
          {current.data && (
            <div className="text-[11px] text-slate-500 mb-2">
              Currently:{" "}
              <span className="font-mono text-slate-300">
                {String(current.data.broker_host_port ?? "not configured")}
              </span>
              {current.data.client_username ? (
                <> as <span className="font-mono">{String(current.data.client_username)}</span></>
              ) : null}
            </div>
          )}
          <div className="space-y-2">
            <Labeled label="Broker address (host:port)">
              <input
                value={brokerHostPort}
                onChange={(e) => setBrokerHostPort(e.target.value)}
                placeholder="192.168.1.10:443"
                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sm font-mono"
                spellCheck={false}
              />
            </Labeled>
            <p className="text-[11px] text-slate-500">
              Must be reachable from the camera's network, must be static, and the
              port must be 443, 123 or 53 — Verkada rejects everything else.
            </p>
            <p className="text-[11px] text-slate-500">
              Credentials come from step 0 and are sent straight to the camera —
              nothing to copy.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => configure.mutate()}
                disabled={!cameraId || !brokerHostPort || configure.isPending}
                className="text-sm px-3 py-1.5 rounded bg-sky-600 text-white disabled:opacity-40"
              >
                {configure.isPending ? "Pushing…" : "Push config to camera"}
              </button>
              <button
                onClick={() => preview.mutate()}
                disabled={!cameraId || !brokerHostPort || preview.isPending}
                className="text-sm px-3 py-1.5 rounded border border-slate-700 text-slate-400 hover:border-sky-500 hover:text-sky-300 disabled:opacity-40"
                title="Build the request and show it without sending"
              >
                Show request
              </button>
              <button
                onClick={() => clearCamera.mutate()}
                disabled={!cameraId || clearCamera.isPending}
                className="text-sm px-3 py-1.5 rounded border border-slate-700 text-slate-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-40"
                title="Unpoint this camera. Also the documented way to force a reconnect."
              >
                {clearCamera.isPending ? "Clearing…" : "Clear"}
              </button>
            </div>
            {clearCamera.isError && (
              <p className="text-xs text-rose-300">{(clearCamera.error as Error).message}</p>
            )}
            {preview.data && (
              <pre className="text-[11px] font-mono text-slate-300 bg-slate-950 border border-slate-800 rounded p-2 overflow-x-auto max-h-72">
                {JSON.stringify(preview.data.request, null, 2)}
              </pre>
            )}
            {preview.isError && (
              <p className="text-xs text-rose-300">{(preview.error as Error).message}</p>
            )}
            {configure.isError && (
              <p className="text-xs text-rose-300">{(configure.error as Error).message}</p>
            )}
            {configure.data && (
              <p
                className={`text-xs ${configure.data.persisted ? "text-emerald-300" : "text-amber-300"}`}
              >
                {configure.data.persisted ? "Stored. " : "Not stored. "}
                {configure.data.note}
              </p>
            )}
          </div>
        </Card>
      </div>

      <Card title="3 · What the camera sees">
        <LiveView cameraId={cameraId} live={live} />
      </Card>
    </div>
  );
}

/** SSE subscription to the ingest snapshot.
 *
 *  EventSource rather than polling: the boxes move at 8 Hz and the whole
 *  point is watching them move, so an interval would show a slideshow.
 */
function useLiveTracks(cameraId: string) {
  const [data, setData] = useState<LiveCamera | null>(null);
  useEffect(() => {
    if (!cameraId) {
      setData(null);
      return;
    }
    const url = `${API_BASE}/api/mqtt/live?camera_id=${encodeURIComponent(cameraId)}`;
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        setData(parsed.cameras?.[cameraId] ?? null);
      } catch {
        /* a malformed frame is not worth tearing the stream down */
      }
    };
    return () => es.close();
  }, [cameraId]);
  return data;
}

function LiveView({ cameraId, live }: { cameraId: string; live: LiveCamera | null }) {
  const [frameKey, setFrameKey] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // Refresh the backdrop periodically. The boxes are live; the still behind
  // them only needs to be roughly current, and each fetch is a real API call.
  useEffect(() => {
    if (!cameraId) return;
    const t = setInterval(() => setFrameKey((k) => k + 1), 10000);
    return () => clearInterval(t);
  }, [cameraId]);

  if (!cameraId) {
    return <div className="text-sm text-slate-500">Pick a camera to start.</div>;
  }

  const objects = live?.objects ?? [];
  return (
    <div className="space-y-2">
      <div
        ref={box}
        className="relative w-full rounded-md overflow-hidden bg-slate-950 border border-slate-800"
        style={{ aspectRatio: "16 / 9" }}
      >
        <img
          key={frameKey}
          src={`${API_BASE}/api/mqtt/frame/${cameraId}?k=${frameKey}`}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-70"
        />
        {objects.map((o) => {
          const color = TYPE_COLOR[o.type] ?? "#94a3b8";
          return (
            <div
              key={o.obj_id}
              className="absolute border-2 rounded-sm"
              style={{
                left: `${(o.cx - o.w / 2) * 100}%`,
                top: `${(o.cy - o.h / 2) * 100}%`,
                width: `${o.w * 100}%`,
                height: `${o.h * 100}%`,
                borderColor: color,
                boxShadow: `0 0 12px ${color}55`,
                // Boxes arrive ~125ms apart; a short transition turns a
                // sequence of jumps into motion without inventing position.
                transition: "left 120ms linear, top 120ms linear, width 120ms linear, height 120ms linear",
              }}
            >
              <span
                className="absolute -top-5 left-0 text-[10px] px-1 rounded font-mono whitespace-nowrap"
                style={{ background: color, color: "#0f172a" }}
              >
                {o.type} · {o.age.toFixed(1)}s
              </span>
            </div>
          );
        })}
        {objects.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-xs text-slate-500">
            No objects in view
          </div>
        )}
      </div>
      <div className="flex items-center gap-4 text-xs text-slate-400">
        {["person", "vehicle", "animal"].map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ background: TYPE_COLOR[t] }}
            />
            {t} <span className="font-mono text-slate-200">{live?.counts?.[t] ?? 0}</span>
          </span>
        ))}
        <span className="text-slate-500">
          {live?.age_sec != null ? `last message ${live.age_sec}s ago` : "nothing received yet"}
        </span>
      </div>
    </div>
  );
}

function StatusBar({ status }: { status?: MqttStatus }) {
  if (!status) return null;
  const items: [string, string, boolean][] = [
    [
      "Ingest",
      status.enabled
        ? status.connected
          ? "connected"
          : "waiting for broker"
        : "not set up",
      status.connected,
    ],
    ["Broker", status.host, status.connected],
    ["Certificate", status.ca_present ? "generated" : "missing", status.ca_present],
    [
      "Credentials",
      status.credentials_present ? (status.broker_username ?? "stored") : "not set up",
      status.credentials_present,
    ],
    ["Messages", status.total_messages.toLocaleString(), status.total_messages > 0],
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {items.map(([label, value, good]) => (
        <div
          key={label}
          className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg px-3 py-2"
        >
          <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
          <div className={`text-sm font-mono ${good ? "text-emerald-300" : "text-slate-300"}`}>
            {value}
          </div>
        </div>
      ))}
      {status.last_error && (
        <div className="col-span-2 sm:col-span-5 text-xs text-amber-300/90">
          {status.last_error}
        </div>
      )}
    </div>
  );
}

function StateDot({ state }: { state: string }) {
  const color =
    state === "ok" ? "bg-emerald-400" : state === "fail" ? "bg-rose-400" : "bg-slate-500";
  return <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      <h2 className="text-xs uppercase tracking-wider text-slate-400 mb-3">{title}</h2>
      {children}
    </div>
  );
}
