import { useEffect, useMemo, useRef, useState } from "react";

import Hls from "hls.js";

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
  /** Camera-clock detection time in ms, used to line boxes up with the
   *  video frame on screen rather than with the wall clock. */
  ts: number | null;
}

interface LiveCamera {
  objects: LiveObject[];
  counts: Record<string, number>;
  total: number;
  age_sec: number | null;
  latency_ms: number | null;
  latency_samples: number;
}

interface TrackRecord {
  camera_id: string;
  obj_id: string;
  type: string;
  started_at: string;
  duration_sec: number;
  points: number;
  max_size: number;
  path: [number, number, number, number][];
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
        password_rotated: boolean;
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
              {setup.data.password_rotated
                ? " New broker password generated."
                : " Existing broker password kept."}
            </p>
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
              <p className="text-amber-200">
                {setup.data.password_rotated
                  ? "The broker must be restarted to pick up the new password."
                  : "Restart the TLS terminator so it serves the new certificate."}
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

      <Card title="4 · What it saw earlier">
        <TrackHistory cameraId={cameraId} />
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  // Boxes keyed by camera timestamp, so a frame can be reconstructed for
  // any moment the video might be showing.
  const buffer = useRef<{ ts: number; objects: LiveObject[] }[]>([]);
  const [drawn, setDrawn] = useState<LiveObject[]>([]);
  const [offset, setOffset] = useState<number | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!cameraId || !video) return;
    setError(null);
    setPlaying(false);
    const src = `${API_BASE}/api/mqtt/stream/${cameraId}/index.m3u8`;
    let cancelled = false;

    // Fetch the playlist ourselves first. A <video> that cannot load its
    // source reports nothing useful — it just stays black — so this turns
    // an auth failure or an upstream error into a message instead of a
    // blank rectangle.
    fetch(src, { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          setError(
            `Stream unavailable (HTTP ${res.status}). ${body.slice(0, 200)}`,
          );
          return;
        }
        // The camera sends HEVC. Where MSE cannot decode it, hls.js will
        // attach and play silently to a black frame, so check up front.
        const hevcOk =
          typeof MediaSource !== "undefined" &&
          MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');
        if (!video.canPlayType("application/vnd.apple.mpegurl") && !hevcOk) {
          setError(
            "This browser cannot decode HEVC, which is the only codec this " +
              "camera streams. Safari plays it; Chrome only does with hardware support.",
          );
        }
      })
      .catch((e) => !cancelled && setError(`Stream request failed: ${e}`));

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari plays HLS natively. The playlist is on the API origin, so
      // it needs credentials — without this the request goes out without
      // the session cookie and 401s invisibly.
      video.crossOrigin = "use-credentials";
      video.src = src;
      video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      return () => {
        cancelled = true;
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      setError("This browser cannot play HLS.");
      return;
    }
    const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, xhrSetup: (xhr) => {
      xhr.withCredentials = true;
    } });
    hlsRef.current = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      // The camera streams HEVC and only some browsers decode it.
      setError(
        data.type === Hls.ErrorTypes.MEDIA_ERROR
          ? "Could not decode the stream. This camera sends HEVC, which Safari plays and most Chrome builds do not."
          : `Stream error: ${data.details}`,
      );
    });
    return () => {
      cancelled = true;
      hls.destroy();
      hlsRef.current = null;
    };
  }, [cameraId]);

  // Collect every frame of boxes with its camera timestamp.
  useEffect(() => {
    if (!live?.objects?.length) return;
    const ts = live.objects.find((o) => o.ts)?.ts;
    if (!ts) return;
    const buf = buffer.current;
    buf.push({ ts, objects: live.objects });
    const cutoff = ts - 60_000;
    while (buf.length && buf[0].ts < cutoff) buf.shift();
  }, [live]);

  // Draw the boxes belonging to the frame actually on screen. HLS runs
  // roughly 8-12s behind real time; without this the boxes lead the
  // subject by an entire segment or three and look plain wrong.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const hls = hlsRef.current;
      // hls.js exposes the EXT-X-PROGRAM-DATE-TIME of the current frame
      // directly. Safari plays HLS natively instead, where the same
      // information comes from the WebKit-only getStartDate().
      const native = video as HTMLVideoElement & { getStartDate?: () => Date };
      let playingDate: Date | null = hls?.playingDate ?? null;
      if (!playingDate && typeof native.getStartDate === "function") {
        const start = native.getStartDate();
        if (start && !Number.isNaN(start.getTime())) {
          playingDate = new Date(start.getTime() + video.currentTime * 1000);
        }
      }
      if (!playingDate) return;
      const target = playingDate.getTime();
      setOffset(Math.round((Date.now() - target) / 100) / 10);
      const buf = buffer.current;
      if (!buf.length) return;
      // Nearest frame within half a second; otherwise nothing was moving.
      let best = buf[0];
      for (const f of buf) {
        if (Math.abs(f.ts - target) < Math.abs(best.ts - target)) best = f;
      }
      setDrawn(Math.abs(best.ts - target) < 500 ? best.objects : []);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cameraId]);

  // Capability checks lie: Chrome reports HEVC support via hardware and
  // then renders nothing. Ask the element how many frames it actually
  // decoded — bytes arriving with zero frames out is a decode failure,
  // whatever the browser claimed beforehand.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraId) return;
    const t = setTimeout(() => {
      const q = video.getVideoPlaybackQuality?.();
      if (q && q.totalVideoFrames === 0 && video.readyState < 2) {
        setError(
          "Segments are downloading but no frames decoded — this camera streams " +
            "H.265, which this browser will not render. Safari plays it.",
        );
      }
    }, 8000);
    return () => clearTimeout(t);
  }, [cameraId]);

  if (!cameraId) {
    return <div className="text-sm text-slate-500">Pick a camera to start.</div>;
  }

  return (
    <div className="space-y-2">
      <div
        className="relative w-full max-w-2xl rounded-md overflow-hidden bg-slate-950 border border-slate-800"
        style={{ aspectRatio: "16 / 9" }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />
        {drawn.map((o) => {
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
                transition:
                  "left 120ms linear, top 120ms linear, width 120ms linear, height 120ms linear",
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
        {error && (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-amber-300 bg-slate-950/80">
            {error}
          </div>
        )}
        {!playing && !error && (
          <div className="absolute inset-0 grid place-items-center text-xs text-slate-500">
            Connecting to the stream…
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 max-w-2xl">
        {["person", "vehicle", "animal"].map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ background: TYPE_COLOR[t] }}
            />
            {t} <span className="font-mono text-slate-200">{live?.counts?.[t] ?? 0}</span>
          </span>
        ))}
        {live?.latency_ms != null && (
          <span
            className="text-slate-500"
            title="Camera detection timestamp to arrival here. The camera keeps its own clock, so treat this as an estimate — skew shows up as a constant offset."
          >
            box latency ~
            <span className="font-mono text-slate-200">{live.latency_ms}ms</span>
          </span>
        )}
        {offset != null && (
          <span
            className="text-slate-500"
            title="How far behind real time the video is. Boxes are delayed to match it, so what you see lines up."
          >
            video behind{" "}
            <span className="font-mono text-slate-200">{offset.toFixed(1)}s</span>
          </span>
        )}
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


/** Completed tracks. One row per object rather than per message — the
 *  live view covers the messages, and what is useful later is what came
 *  through, when, and for how long. */
function TrackHistory({ cameraId }: { cameraId: string }) {
  const history = useQuery({
    queryKey: ["mqtt-history", cameraId],
    queryFn: () =>
      apiGet<{ tracks: TrackRecord[]; summary: Record<string, unknown> }>(
        `/api/mqtt/history?limit=200${cameraId ? `&camera_id=${cameraId}` : ""}`,
      ),
    refetchInterval: 15000,
  });

  const tracks = history.data?.tracks ?? [];
  const summary = history.data?.summary as
    | { total: number; by_type: Record<string, number>; median_duration_sec: number | null }
    | undefined;

  if (tracks.length === 0) {
    return (
      <div className="text-sm text-slate-500">
        No completed tracks yet. An object is recorded once it leaves view.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {summary && (
        <div className="text-xs text-slate-400 flex flex-wrap gap-4">
          <span>
            <span className="font-mono text-slate-200">{summary.total}</span> tracks
          </span>
          {Object.entries(summary.by_type).map(([t, n]) => (
            <span key={t} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ background: TYPE_COLOR[t] ?? "#94a3b8" }}
              />
              {t} <span className="font-mono text-slate-200">{n}</span>
            </span>
          ))}
          {summary.median_duration_sec != null && (
            <span>
              median dwell{" "}
              <span className="font-mono text-slate-200">
                {summary.median_duration_sec}s
              </span>
            </span>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-slate-400 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-2 py-1">When</th>
              <th className="text-left px-2 py-1">Type</th>
              <th className="text-left px-2 py-1">Dwell</th>
              <th className="text-left px-2 py-1">Closest</th>
              <th className="text-left px-2 py-1">Path</th>
            </tr>
          </thead>
          <tbody>
            {tracks.slice(0, 50).map((t) => (
              <tr key={`${t.obj_id}-${t.started_at}`} className="border-t border-slate-800/60">
                <td className="px-2 py-1 font-mono text-xs text-slate-300">
                  {new Date(t.started_at).toLocaleString()}
                </td>
                <td className="px-2 py-1">
                  <span
                    className="inline-block w-2 h-2 rounded-sm mr-1.5"
                    style={{ background: TYPE_COLOR[t.type] ?? "#94a3b8" }}
                  />
                  {t.type}
                </td>
                <td className="px-2 py-1 font-mono text-xs">{t.duration_sec}s</td>
                <td
                  className="px-2 py-1 font-mono text-xs text-slate-400"
                  title="Largest box area seen — bigger means nearer the camera"
                >
                  {(t.max_size * 100).toFixed(1)}%
                </td>
                <td className="px-2 py-1">
                  <PathSpark path={t.path} color={TYPE_COLOR[t.type] ?? "#94a3b8"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The track's route through the frame, drawn in the frame's own
 *  proportions so left-to-right on screen means left-to-right in view. */
function PathSpark({
  path,
  color,
}: {
  path: [number, number, number, number][];
  color: string;
}) {
  if (path.length < 2) return <span className="text-slate-600 text-xs">—</span>;
  const pts = path.map(([cx, cy]) => `${cx * 96},${cy * 54}`).join(" ");
  const [sx, sy] = path[0];
  const [ex, ey] = path[path.length - 1];
  return (
    <svg viewBox="0 0 96 54" className="w-24 h-[54px] rounded bg-slate-950/60">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" opacity="0.8" />
      <circle cx={sx * 96} cy={sy * 54} r="2" fill={color} opacity="0.5" />
      <circle cx={ex * 96} cy={ey * 54} r="2.5" fill={color} />
    </svg>
  );
}
