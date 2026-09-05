import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { API_BASE, apiDelete, apiGet, apiPost, apiPut } from "../lib/api";
import { useCameraLookup, useCameras } from "../lib/cameras";
import ConfirmDialog from "../components/ConfirmDialog";

interface MqttStatus {
  connected: boolean;
  enabled: boolean;
  host: string;
  topic: string;
  last_error: string | null;
  uptime_sec: number | null;
  total_messages: number;
  recorded_tracks: number;
  suppressed_tracks: number;
  brief_tracks: number;
  cameras: string[];
  track_timeout_sec: number;
  last_message_age_sec: number | null;
  ca_present: boolean;
  credentials_present: boolean;
  broker_username: string | null;
  broker_host_port: string | null;
  mode: "builtin" | "external";
}

interface PreflightCheck {
  id: string;
  label: string;
  state: "ok" | "fail" | "unknown" | "pending";
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

/** The preflight checks, in the order the backend returns them. Knowing
 *  them up front lets the list render immediately with each row pending,
 *  instead of the panel sitting empty and then filling in at once. */
const PREFLIGHT_STEPS: { id: string; label: string }[] = [
  { id: "ca", label: "Broker certificate generated" },
  { id: "ingest", label: "Broker reachable from vFusion" },
  { id: "online", label: "Camera online" },
  { id: "analytics", label: "People analytics enabled" },
  { id: "line", label: "Occupancy Trends line drawn" },
  { id: "pushed", label: "Already pointed at this broker" },
];

const TYPE_COLOR: Record<string, string> = {
  person: "#38bdf8",
  vehicle: "#fbbf24",
  animal: "#a78bfa",
};

export default function Mqtt() {
  const [searchParams, setSearchParams] = useSearchParams();
  const cameras = useCameras();
  const [cameraId, setCameraId] = useState("");

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
        broker_host_port: knownBroker,
      }),
    onSuccess: () => {
      preflight.refetch();
      current.refetch();
    },
  });

  const [setupHost, setSetupHost] = useState("");
  const [setupHostTouched, setSetupHostTouched] = useState(false);
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
    onSuccess: () => {
      // Nothing to carry into step 2 any more: it reads the address off
      // the certificate this just generated.
      status.refetch();
    },
  });

  // Dry run: build the outbound request and show it without sending.
  const preview = useMutation({
    mutationFn: () =>
      apiPost<{ dry_run: boolean; request: unknown }>(
        `/api/mqtt/config/${cameraId}?dry_run=true`,
        { broker_host_port: knownBroker },
      ),
  });

  const reset = useMutation({
    mutationFn: () => apiPost<{ removed: string[]; note: string }>("/api/mqtt/reset", {}),
    onSuccess: () => {
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

  // Fill the camera form from the certificate. Cameras have to be
  // pointed at exactly the address the cert was cut for — anything else
  // routes fine and then fails the TLS handshake — so asking anyone to
  // retype it per camera is inviting a mismatch.
  const knownBroker = status.data?.broker_host_port ?? null;
  const knownHost = knownBroker ? knownBroker.replace(/:\d+$/, "") : "";
  // The certificate already names an address; showing an empty box, or
  // whatever was typed last, invites generating a cert for somewhere
  // else by accident.
  useEffect(() => {
    if (knownHost && !setupHostTouched) setSetupHost(knownHost);
  }, [knownHost, setupHostTouched]);

  // The preflight already worked this out; the button should not
  // present a re-push as the obvious next move when it is a no-op that
  // drops the camera for 5-25 seconds.
  const alreadyPushed =
    preflight.data?.some((c) => c.id === "pushed" && c.state === "ok") ?? false;

  const live = useLiveTracks(cameraId);


  const online = useMemo(
    () =>
      (cameras.data ?? [])
        .filter((c) => c.status && c.status.toLowerCase() !== "offline")
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [cameras.data],
  );

  // Sites in alphabetical order, cameras within them likewise, with
  // anything unsited last rather than under a blank heading.
  const onlineBySite = useMemo(() => {
    const groups = new Map<string, typeof online>();
    for (const c of online) {
      const site = c.site?.trim() || "No site";
      if (!groups.has(site)) groups.set(site, []);
      groups.get(site)!.push(c);
    }
    return [...groups.entries()]
      .sort((a, b) =>
        a[0] === "No site" ? 1 : b[0] === "No site" ? -1 : a[0].localeCompare(b[0]),
      )
      .map(
        ([site, cams]) =>
          [
            site,
            [...cams].sort((x, y) => (x.name ?? "").localeCompare(y.name ?? "")),
          ] as const,
      );
  }, [online]);

  // Setting the broker up and reading what it recorded are different
  // jobs done at different times: one is configuration you touch once,
  // the other is the thing you come back for. Stacked in one column the
  // second was four cards below the first.
  const tab = searchParams.get("tab") === "history" ? "history" : "server";
  const setTab = (next: string) => {
    const p = new URLSearchParams(searchParams);
    p.set("tab", next);
    setSearchParams(p, { replace: true });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">MQTT</h1>
        <p className="text-slate-400 text-sm mt-1 max-w-3xl">
          {tab === "history"
            ? "Every object a camera tracked through frame and out again, recorded as it happened. Replay one to pull the footage it came from."
            : "Point a camera at vFusion's MQTT broker and watch what it reports. Cameras publish bounding boxes for people, vehicles and animals about eight times a second — this is that stream, unedited."}
        </p>
        <div className="mt-4 flex items-center gap-1 border-b border-white/10">
          {[
            { key: "server", label: "Server" },
            { key: "history", label: "History" },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === t.key
                  ? "border-sky-500 text-white"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <StatusBar status={status.data} />

      {tab === "history" && (
        <Card title="What it saw earlier">
          <TrackHistory cameraId={cameraId} />
        </Card>
      )}

      {tab === "server" && (
      <>

      <Card title="0 · Set up the broker">
        <BrokerMode onChanged={() => status.refetch()} />

        {status.data?.mode !== "external" && (
        <>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[16rem]">
            <Labeled label="Address cameras will connect to">
              <input
                value={setupHost}
                onChange={(e) => {
                  setSetupHostTouched(true);
                  setSetupHost(e.target.value);
                }}
                placeholder="192.168.1.10"
                className="w-full px-2 py-1 rounded bg-black/30 border border-white/15 text-sm font-mono"
                spellCheck={false}
              />
            </Labeled>
          </div>
          <button
            onClick={() => setup.mutate()}
            disabled={!setupHost || setup.isPending}
            className="text-sm px-3 py-1.5 rounded border border-slate-600 text-slate-200 hover:border-sky-500 disabled:opacity-40"
          >
            {setup.isPending
              ? "Generating…"
              : !status.data?.ca_present
                ? "Generate certificate + credentials"
                : setupHost !== knownHost
                  ? "Generate for this address"
                  : "Regenerate certificate"}
          </button>
          <button
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
            className="text-sm px-3 py-1.5 rounded border border-white/15 text-slate-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-40"
            title="Delete the generated certificate, password file and credentials"
          >
            {reset.isPending ? "Clearing…" : "Clear broker setup"}
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mt-2 max-w-2xl">
          Host or IP only — the port is always 443. Use something that will
          not move: a static IP, a DHCP reservation or a DNS name.
        </p>
        <p className="text-[11px] text-slate-500 mt-1 max-w-2xl">
          It must be <span className="text-slate-300">this machine</span>.
          Cameras connect to whatever address is here and publish there —
          point it at another host and they will work perfectly, sending
          their data somewhere else, while everything below stays empty.
        </p>
        </>
        )}
        {setup.isError && (
          <p className="text-xs text-rose-300 mt-2">{(setup.error as Error).message}</p>
        )}
        {status.data?.mode !== "external" && setup.data && (
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
            className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/15 text-sm"
          >
            <option value="">— choose a camera —</option>
            {onlineBySite.map(([site, cams]) => (
              <optgroup key={site} label={site}>
                {cams.map((c) => (
                  <option key={c.camera_id} value={c.camera_id}>
                    {c.name ?? "(unnamed)"}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {cameraId && (
            <ul className="mt-3 space-y-2">
              {(preflight.data ?? PREFLIGHT_STEPS.map((s) => ({
                ...s,
                state: "pending" as const,
                detail: "",
                fix: null,
              }))).map((c) => (
                <li key={c.id} className="text-sm flex gap-2">
                  <StateDot state={c.state} />
                  <div className="min-w-0">
                    <div
                      className={
                        c.state === "pending" ? "text-slate-400" : "text-slate-200"
                      }
                    >
                      {c.label}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {c.state === "pending" ? "checking…" : c.detail}
                    </div>
                    {c.fix && c.state !== "ok" && c.state !== "pending" && (
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
            <Labeled label="Broker address">
              <div className="px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono text-slate-200">
                {knownBroker ?? "— run step 0 first —"}
              </div>
            </Labeled>
            <p className="text-[11px] text-slate-500">
              Taken from the certificate generated in step 0. It cannot differ:
              the address is written into the certificate's SAN, so pointing a
              camera anywhere else fails the TLS handshake even when the address
              routes. Change it by regenerating above.
            </p>
            <p className="text-[11px] text-slate-500">
              Credentials come from step 0 and are sent straight to the camera —
              nothing to copy.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => configure.mutate()}
                disabled={!cameraId || !knownBroker || configure.isPending}
                className={`text-sm px-3 py-1.5 rounded text-white disabled:opacity-40 ${
                  alreadyPushed ? "bg-white/10 hover:bg-white/15" : "bg-sky-600"
                }`}
                title={
                  alreadyPushed
                    ? "This camera already has the current config — pushing again just churns its connection"
                    : undefined
                }
              >
                {configure.isPending
                  ? "Pushing…"
                  : alreadyPushed
                    ? "Push again anyway"
                    : "Push config to camera"}
              </button>
              <button
                onClick={() => preview.mutate()}
                disabled={!cameraId || !knownBroker || preview.isPending}
                className="text-sm px-3 py-1.5 rounded border border-white/15 text-slate-400 hover:border-sky-500 hover:text-sky-300 disabled:opacity-40"
                title="Build the request and show it without sending"
              >
                Show request
              </button>
              <button
                onClick={() => clearCamera.mutate()}
                disabled={!cameraId || clearCamera.isPending}
                className="text-sm px-3 py-1.5 rounded border border-white/15 text-slate-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-40"
                title="Unpoint this camera. Also the documented way to force a reconnect."
              >
                {clearCamera.isPending ? "Clearing…" : "Clear"}
              </button>
            </div>
            {clearCamera.isError && (
              <p className="text-xs text-rose-300">{(clearCamera.error as Error).message}</p>
            )}
            {preview.data && (
              <pre className="text-[11px] font-mono text-slate-300 bg-black/30 border border-white/15 rounded p-2 overflow-x-auto max-h-72">
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

      {status.data?.mode === "external" && (
        <Card title="Viewing is off in external mode">
          <p className="text-sm text-slate-400">
            Cameras are publishing to your own broker, so vFusion never sees the
            stream — the live view, the noise filter and the history below only
            show what arrives here.
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            Everything above still works: vFusion pushes the address,
            credentials and certificate to each camera and verifies they took.
          </p>
        </Card>
      )}

      {status.data?.mode !== "external" && (
      <Card title="3 · What this broker is receiving">
        <LiveView
          cameraId={cameraId}
          live={live}
          everPublished={
            !!cameraId && (status.data?.cameras ?? []).includes(cameraId)
          }
        />
      </Card>

      )}

      {status.data?.mode !== "external" && (
      <Card title="Noise filter">
        <NoiseFilter cameraId={cameraId} status={status.data} />
      </Card>

      )}

      </>
      )}
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

function LiveView({
  cameraId,
  live,
  everPublished,
}: {
  cameraId: string;
  live: LiveCamera | null;
  everPublished: boolean;
}) {
  const [frameKey, setFrameKey] = useState(0);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [frameError, setFrameError] = useState(false);

  // Loaded once per camera and then left alone. The boxes are the live
  // part; the picture behind them is context, and re-grabbing it on a
  // timer spends an ffmpeg run every cycle to change almost nothing.
  useEffect(() => {
    if (!cameraId) return;
    setFrameError(false);
    setLoadingFrame(true);
    setFrameKey((k) => k + 1);
  }, [cameraId]);

  const refreshFrame = () => {
    setFrameError(false);
    setLoadingFrame(true);
    setFrameKey((k) => k + 1);
  };

  if (!cameraId) {
    return <div className="text-sm text-slate-500">Pick a camera to start.</div>;
  }

  const objects = live?.objects ?? [];
  return (
    <div className="space-y-2">
      <div
        className="relative w-full max-w-2xl rounded-md overflow-hidden bg-black/30 border border-white/15"
        style={{ aspectRatio: "16 / 9" }}
      >
        <img
          key={frameKey}
          src={`${API_BASE}/api/mqtt/frame/${cameraId}?k=${frameKey}`}
          alt=""
          onLoad={() => setLoadingFrame(false)}
          onError={() => {
            setLoadingFrame(false);
            setFrameError(true);
          }}
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ease-out-strong"
          style={{ opacity: loadingFrame ? 0 : 0.7 }}
        />
        {loadingFrame && (
          // The grab decodes a frame out of the live stream with ffmpeg,
          // which takes a couple of seconds. Without saying so, the first
          // read of a blank rectangle is "this is broken".
          <div className="absolute inset-0 grid place-items-center gap-2 text-center px-4">
            <div>
              <div className="mx-auto mb-2 h-4 w-4 rounded-full border-2 border-slate-600 border-t-sky-400 animate-spin" />
              <div className="text-xs text-slate-400">
                Grabbing a live frame from the camera
              </div>
              <div className="text-[11px] text-slate-600 mt-0.5">
                decoding one frame out of the stream — usually 2–3 seconds
              </div>
            </div>
          </div>
        )}
        {frameError && !loadingFrame && (
          <div className="absolute inset-0 grid place-items-center px-4 text-center text-xs text-amber-300">
            Could not grab a frame. The camera may be offline, or ffmpeg could
            not reach the stream.
          </div>
        )}
        {objects.map((o) => (
          <TrackedBox key={o.obj_id} object={o} />
        ))}
        {objects.length === 0 && !loadingFrame && !frameError && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            {everPublished ? (
              <span className="text-xs text-slate-500">No objects in view</span>
            ) : (
              <span className="text-xs text-slate-400 max-w-sm">
                This camera has never published to this broker.
                <span className="block text-slate-500 mt-1">
                  Boxes only appear for cameras pointed at this machine. Check
                  the address in step 0 is this server, that the config was
                  pushed in step 2, and that the camera has an Occupancy Trends
                  line drawn.
                </span>
              </span>
            )}
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
            title="Camera detection timestamp to arrival here. The camera keeps its own clock, so treat this as an estimate."
          >
            latency ~<span className="font-mono text-slate-200">{live.latency_ms}ms</span>
          </span>
        )}
        <button
          type="button"
          onClick={refreshFrame}
          disabled={loadingFrame}
          className="text-slate-500 hover:text-slate-300 underline underline-offset-2 disabled:opacity-50"
        >
          {loadingFrame ? "Refreshing…" : "Refresh image"}
        </button>
      </div>
    </div>
  );
}

/** One tracked object: the box, and a figure walking inside it.
 *
 *  The box alone shows position. The figure shows that something is
 *  *there* — and because the still behind it is up to 15 seconds old,
 *  it also makes clear which part of the picture is live. */
function TrackedBox({ object: o }: { object: LiveObject }) {
  const color = TYPE_COLOR[o.type] ?? "#94a3b8";
  return (
    <div
      className="absolute border-2 rounded-sm"
      style={{
        left: `${(o.cx - o.w / 2) * 100}%`,
        top: `${(o.cy - o.h / 2) * 100}%`,
        width: `${o.w * 100}%`,
        height: `${o.h * 100}%`,
        borderColor: color,
        boxShadow: `0 0 12px ${color}55`,
        // Detections land ~125ms apart; a matching transition turns a
        // sequence of jumps into movement without inventing positions
        // between them.
        transition:
          "left 120ms linear, top 120ms linear, width 120ms linear, height 120ms linear",
      }}
    >
      <Figure type={o.type} color={color} />
      <span
        className="absolute -top-5 left-0 text-[10px] px-1 rounded font-mono whitespace-nowrap"
        style={{ background: color, color: "#0f172a" }}
      >
        {o.type} · {o.age.toFixed(1)}s
      </span>
    </div>
  );
}

/** A walking figure sized to its box. Deliberately simple — a silhouette
 *  reads at 30px where detail turns to mush. */
function Figure({ type, color }: { type: string; color: string }) {
  if (type !== "person") {
    return (
      <span
        className="absolute inset-0 grid place-items-center text-[10px] font-mono opacity-70"
        style={{ color }}
      >
        {type === "vehicle" ? "▭" : "◆"}
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 24 48"
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 w-full h-full opacity-90 animate-walk"
      aria-hidden="true"
    >
      {/* Drawn in profile, facing right. The previous figure was
          front-on with its limbs splayed into a V, and rotating a
          splayed limb about its root can only widen or narrow that V —
          which is a jumping jack, not a stride. A walk only reads from
          the side.

          Each limb is two segments with a real joint: the shin group
          sits inside the thigh group, so knee rotation composes on top
          of hip rotation the way forward kinematics does. That knee is
          what carries the whole thing — a straight stick leg swinging
          fore and aft is a metronome, while a leg that folds under
          itself through swing and straightens to meet the ground is a
          person. Far-side limbs are dimmed so the near pair reads in
          front rather than the four crossing into a scribble. */}
      <g
        className="walk-body"
        fill="none"
        stroke={color}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g className="walk-far" opacity="0.45">
          <g className="walk-arm walk-phase-a">
            <line x1="12.4" y1="15.5" x2="12.4" y2="21.5" />
            <g className="walk-forearm">
              <line x1="12.4" y1="21.5" x2="12.4" y2="27.5" />
            </g>
          </g>
          <g className="walk-leg walk-phase-b">
            <line x1="11.5" y1="28" x2="11.5" y2="37.5" />
            <g className="walk-shin">
              <line x1="11.5" y1="37.5" x2="11.5" y2="46" />
            </g>
          </g>
        </g>

        {/* Torso and head sit between the two limb pairs, so the far
            arm passes behind the body and the near one in front. */}
        <circle cx="13" cy="7.5" r="4.6" fill={color} stroke="none" />
        <line x1="12.6" y1="12" x2="11.5" y2="28" />

        <g className="walk-leg walk-phase-a">
          <line x1="11.5" y1="28" x2="11.5" y2="37.5" />
          <g className="walk-shin">
            <line x1="11.5" y1="37.5" x2="11.5" y2="46" />
          </g>
        </g>
        <g className="walk-arm walk-phase-b">
          <line x1="12.4" y1="15.5" x2="12.4" y2="21.5" />
          <g className="walk-forearm">
            <line x1="12.4" y1="21.5" x2="12.4" y2="27.5" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/** Operational status, not implementation detail.
 *
 *  This previously reported "ingest: connected", the broker's internal
 *  container hostname, and the broker username — none of which answer
 *  the question someone opens this page with. Whether a socket is open
 *  matters far less than whether data is arriving, and a value that can
 *  only ever read "mqtt-broker" is not status at all.
 */
function StatusBar({ status }: { status?: MqttStatus }) {
  if (!status) return null;

  const age = status.last_message_age_sec;
  const flowing = age != null && age < 30;

  const items: { label: string; value: string; good: boolean; hint?: string }[] = [
    {
      label: "Broker",
      value: status.connected
        ? "listening"
        : status.enabled
          ? "not running"
          : "not set up",
      good: status.connected,
      hint: status.connected
        ? "vFusion is subscribed and waiting for camera data"
        : "The broker container is not reachable",
    },
    {
      label: "Cameras publishing",
      value: String(status.cameras.length),
      good: status.cameras.length > 0,
      hint: "Cameras that have sent object positions since the backend restarted",
    },
    {
      label: "Data",
      value:
        age == null
          ? "none yet"
          : age < 2
            ? "live"
            : age < 90
              ? `${Math.round(age)}s ago`
              : `${Math.round(age / 60)}m ago`,
      good: flowing,
      hint: "Time since the most recent message from any camera",
    },
    {
      label: "Messages",
      value: status.total_messages.toLocaleString(),
      good: status.total_messages > 0,
      hint: "Received since the backend restarted — cameras only publish while something is being tracked",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map((item) => (
        <div
          key={item.label}
          title={item.hint}
          className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg px-3 py-2"
        >
          <div className="text-[10px] uppercase tracking-wider text-slate-400">
            {item.label}
          </div>
          <div
            className={`text-sm font-mono ${
              item.good ? "text-emerald-300" : "text-slate-300"
            }`}
          >
            {item.value}
          </div>
        </div>
      ))}
      {status.last_error && (
        <div className="col-span-2 sm:col-span-4 text-xs text-amber-300/90">
          {status.last_error}
        </div>
      )}
      {!status.last_error &&
        status.connected &&
        status.total_messages === 0 &&
        status.uptime_sec != null && (
          <div className="col-span-2 sm:col-span-4 text-[11px] text-slate-500">
            Counting since the backend restarted{" "}
            {status.uptime_sec < 90
              ? Math.round(status.uptime_sec) + "s"
              : Math.round(status.uptime_sec / 60) + "m"}{" "}
            ago. Cameras only publish while something is being tracked, so
            zero here means nothing has moved — not that anything is wrong.
          </div>
        )}
      {/* Where the messages went. Someone looking at "155 messages" and
          "9 tracks" has no way to reconcile the two, and the gap is
          entirely made of tracks that were deliberately not written —
          suppressed by the noise filter, or too short to mean anything.
          Naming both makes the arithmetic close. */}
      {status.total_messages > 0 && (
        <div className="col-span-2 sm:col-span-4 text-[11px] text-slate-500">
          Those messages became{" "}
          <span className="text-slate-300">{status.recorded_tracks}</span> recorded
          track{status.recorded_tracks === 1 ? "" : "s"} —{" "}
          <span className="text-slate-300">{status.suppressed_tracks}</span> more
          were suppressed by the noise filter and{" "}
          <span className="text-slate-300">{status.brief_tracks}</span> were too
          brief to record. All four counters reset when the backend restarts;
          the history further down does not.
        </div>
      )}
    </div>
  );
}

function StateDot({ state }: { state: string }) {
  if (state === "pending") {
    // Pulsing rather than coloured: an unanswered check should not look
    // like it has been answered.
    return (
      <span className="mt-1.5 w-2 h-2 rounded-full shrink-0 bg-slate-600 animate-pulse" />
    );
  }
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
  const [selected, setSelected] = useState<TrackRecord | null>(null);
  // Narrows the table without touching the page-level camera choice,
  // which also drives the live view and the noise filter. Reading
  // history for one camera should not tear down the stream for another.
  const [only, setOnly] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const cams = useCameraLookup();
  const history = useQuery({
    queryKey: ["mqtt-history", cameraId],
    queryFn: () =>
      apiGet<{ tracks: TrackRecord[]; summary: Record<string, unknown> }>(
        `/api/mqtt/history?limit=200${cameraId ? `&camera_id=${cameraId}` : ""}`,
      ),
    refetchInterval: 15000,
  });

  const allTracks = history.data?.tracks ?? [];
  // Which cameras actually appear, busiest first. Built from the data
  // rather than the camera list: twenty configured cameras of which
  // three are publishing should offer three chips, not twenty.
  const byCamera = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of allTracks) {
      counts.set(t.camera_id, (counts.get(t.camera_id) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [allTracks]);
  const tracks = only
    ? allTracks.filter((t) => t.camera_id === only)
    : allTracks;
  const shown = showAll ? tracks : tracks.slice(0, 50);
  const summary = history.data?.summary as
    | { total: number; by_type: Record<string, number>; median_duration_sec: number | null }
    | undefined;

  if (allTracks.length === 0) {
    return (
      <div className="text-sm text-slate-500">
        No completed tracks yet — an object is recorded once it leaves view.
        <span className="block text-[11px] mt-1">
          This is what this broker received, so it stays empty unless cameras
          are publishing here. Nothing recorded elsewhere shows up.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {selected && (
        <TrackReplay
          key={`${selected.obj_id}-${selected.started_at}`}
          track={selected}
          onClose={() => setSelected(null)}
        />
      )}
      {/* Which cameras this is, before what they saw. With one camera
          it is a label; with twenty it is the only way to read the
          table at all. */}
      {byCamera.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOnly(null)}
            className={`text-[11px] px-2 py-1 rounded border ${
              only === null
                ? "border-sky-600 bg-sky-900/40 text-white"
                : "border-white/10 text-slate-400 hover:bg-white/5"
            }`}
          >
            All {byCamera.length} cameras
          </button>
          {byCamera.map(([id, n]) => (
            <button
              key={id}
              type="button"
              onClick={() => setOnly(id === only ? null : id)}
              className={`text-[11px] px-2 py-1 rounded border ${
                only === id
                  ? "border-sky-600 bg-sky-900/40 text-white"
                  : "border-white/10 text-slate-400 hover:bg-white/5"
              }`}
            >
              {cams.lookup(id)}{" "}
              <span className="font-mono text-slate-500">{n}</span>
            </button>
          ))}
        </div>
      )}
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
              <th className="text-left px-2 py-1">Camera</th>
              <th className="text-left px-2 py-1">Type</th>
              <th className="text-left px-2 py-1">Dwell</th>
              <th className="text-left px-2 py-1">Closest</th>
              <th className="text-left px-2 py-1">Path</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr
                key={`${t.obj_id}-${t.started_at}`}
                onClick={() => setSelected(t)}
                className={`border-t border-white/15/60 cursor-pointer hover:bg-white/5 ${
                  selected?.obj_id === t.obj_id && selected?.started_at === t.started_at
                    ? "bg-white/5"
                    : ""
                }`}
                title="Replay this track and pull the footage"
              >
                <td className="px-2 py-1 font-mono text-xs text-slate-300">
                  {new Date(t.started_at).toLocaleString()}
                </td>
                <td className="px-2 py-1 text-xs text-slate-300 max-w-[12rem] truncate">
                  {cams.lookup(t.camera_id)}
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
      {tracks.length > shown.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-xs px-3 py-1.5 rounded border border-white/15 text-slate-300 hover:border-sky-600"
        >
          Showing {shown.length} of {tracks.length} — show the rest
        </button>
      )}
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
    <svg viewBox="0 0 96 54" className="w-24 h-[54px] rounded bg-black/30/60">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" opacity="0.8" />
      <circle cx={sx * 96} cy={sy * 54} r="2" fill={color} opacity="0.5" />
      <circle cx={ex * 96} cy={ey * 54} r="2.5" fill={color} />
    </svg>
  );
}


/** A recorded track, played back two ways at once: the path the camera
 *  reported, and the footage it reported it from.
 *
 *  Side by side on purpose — the bounding boxes are the camera's own
 *  interpretation, and the only way to judge them is against what was
 *  actually in frame. */
function TrackReplay({
  track,
  onClose,
}: {
  track: TrackRecord;
  onClose: () => void;
}) {
  const progressRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  // ffmpeg cuts the clip out of HLS, which can only start on a segment
  // boundary — up to four seconds before the timestamp we asked for, and
  // a different amount each time. So the offset between the two panels
  // is per-clip and cannot be a constant; this is the correction, kept
  // per camera so it only has to be found once.
  const alignKey = `mqtt-align-${track.camera_id}`;
  // 0.75s is where this lands in practice: the clip starts on a segment
  // boundary before the track, so the footage runs behind the replay
  // until it is pulled forward. Still per-camera and still adjustable —
  // segment cadence differs by camera.
  const [align, setAlign] = useState(() => {
    const raw = localStorage.getItem(alignKey);
    if (raw === null) return 0.75;
    const saved = Number(raw);
    return Number.isFinite(saved) ? saved : 0.75;
  });
  useEffect(() => {
    localStorage.setItem(alignKey, String(align));
  }, [alignKey, align]);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(true);
  const startEpoch = Math.floor(new Date(track.started_at).getTime() / 1000);

  const clip = useMutation({
    mutationFn: () =>
      apiPost<{ url: string; duration_sec: number; pad_sec: number }>("/api/mqtt/clip", {
        camera_id: track.camera_id,
        start_epoch: Math.floor(new Date(track.started_at).getTime() / 1000),
        duration_sec: track.duration_sec,
      }),
  });

  // Walk the path in the time the track actually took, so a slow amble
  // and a sprint across the same ground do not look identical. Scrubbing
  // rebases the clock to wherever the handle was dropped, so play
  // continues from there rather than snapping back.
  const pad = (clip.data?.pad_sec ?? 0) + align;

  // Two players drifting apart is worse than one: the whole point is
  // comparing them frame for frame. Once the clip exists it owns the
  // clock and the replay follows, so they cannot separate. Until then
  // the replay runs on its own timer.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const durationMs = Math.max(1000, track.duration_sec * 1000);
    const standaloneStart = performance.now() - progressRef.current * durationMs;

    const tick = () => {
      const video = videoRef.current;
      if (video && clip.data) {
        // Video time pad_sec is track time zero.
        const t = (video.currentTime - pad) / Math.max(0.1, track.duration_sec);
        progressRef.current = Math.min(1, Math.max(0, t));
      } else {
        const elapsed = (performance.now() - standaloneStart) % durationMs;
        progressRef.current = elapsed / durationMs;
      }
      setProgress(progressRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [track, playing, clip.data, pad]);

  // Start the clip at the moment the track did, not at the padding.
  const onClipReady = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = pad;
    video.play().catch(() => undefined);
  };

  const restartBoth = () => {
    progressRef.current = 0;
    setProgress(0);
    const video = videoRef.current;
    if (video) {
      video.currentTime = pad;
      video.play().catch(() => undefined);
    }
    setPlaying(true);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    setPlaying((wasPlaying) => {
      if (video) {
        if (wasPlaying) video.pause();
        else video.play().catch(() => undefined);
      }
      return !wasPlaying;
    });
  };

  const idx = Math.min(
    track.path.length - 1,
    Math.floor(progress * track.path.length),
  );
  const [cx, cy, w, h] = track.path[idx] ?? [0.5, 0.5, 0.1, 0.2];
  const color = TYPE_COLOR[track.type] ?? "#94a3b8";

  return (
    <div className="rounded-md border border-white/15 bg-black/30/60 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-slate-200">
          {track.type} · {new Date(track.started_at).toLocaleString()} ·{" "}
          <span className="font-mono">{track.duration_sec}s</span>
        </div>
        <button
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">
            What the camera reported
          </div>
          <div
            className="relative w-full rounded overflow-hidden bg-black/30 border border-white/15"
            style={{ aspectRatio: "16 / 9" }}
          >
            <img
              src={`${API_BASE}/api/mqtt/frame/${track.camera_id}?epoch=${startEpoch}`}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-60"
            />
            <svg viewBox="0 0 160 90" className="absolute inset-0 w-full h-full">
              <polyline
                points={track.path.map(([x, y]) => `${x * 160},${y * 90}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth="0.6"
                opacity="0.35"
              />
            </svg>
            <div
              className="absolute border-2 rounded-sm"
              style={{
                left: `${(cx - w / 2) * 100}%`,
                top: `${(cy - h / 2) * 100}%`,
                width: `${w * 100}%`,
                height: `${h * 100}%`,
                borderColor: color,
                boxShadow: `0 0 10px ${color}55`,
              }}
            >
              <Figure type={track.type} color={color} />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={togglePlay}
              className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:border-sky-500 w-14"
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              onClick={restartBoth}
              className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:border-sky-500 whitespace-nowrap"
              title="Restart the replay and the footage together"
            >
              Restart both
            </button>
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round(progress * 1000)}
              onChange={(e) => {
                const v = Number(e.target.value) / 1000;
                progressRef.current = v;
                setProgress(v);
                const video = videoRef.current;
                if (video) video.currentTime = pad + v * track.duration_sec;
              }}
              onMouseDown={() => {
                videoRef.current?.pause();
                setPlaying(false);
              }}
              className="flex-1 accent-sky-500"
              aria-label="Scrub the reported track"
            />
            <span className="text-[11px] font-mono text-slate-400 w-20 text-right">
              {(progress * track.duration_sec).toFixed(1)}s /{" "}
              {track.duration_sec.toFixed(1)}s
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-slate-500">
            <span title="Shift the footage against the replay. The clip starts on a segment boundary, so the gap differs per clip; this is remembered per camera.">
              Align
            </span>
            <button
              type="button"
              onClick={() => setAlign((a) => Math.round((a - 0.25) * 100) / 100)}
              className="px-1.5 py-0.5 rounded border border-white/15 hover:border-sky-500 hover:text-slate-300"
              aria-label="Footage earlier"
            >
              −0.25s
            </button>
            <span className="font-mono text-slate-300 w-14 text-center">
              {align > 0 ? "+" : ""}
              {align.toFixed(2)}s
            </span>
            <button
              type="button"
              onClick={() => setAlign((a) => Math.round((a + 0.25) * 100) / 100)}
              className="px-1.5 py-0.5 rounded border border-white/15 hover:border-sky-500 hover:text-slate-300"
              aria-label="Footage later"
            >
              +0.25s
            </button>
            {align !== 0 && (
              <button
                type="button"
                onClick={() => setAlign(0)}
                className="underline underline-offset-2 hover:text-slate-300"
              >
                reset
              </button>
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">
            The footage
          </div>
          <div
            className="relative w-full rounded overflow-hidden bg-black/30 border border-white/15"
            style={{ aspectRatio: "16 / 9" }}
          >
            {clip.data ? (
              <video
                ref={videoRef}
                src={`${API_BASE}${clip.data.url}`}
                controls
                muted
                playsInline
                onLoadedMetadata={onClipReady}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={restartBoth}
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center px-4 text-center">
                {clip.isPending ? (
                  <div>
                    <div className="mx-auto mb-2 h-4 w-4 rounded-full border-2 border-slate-600 border-t-sky-400 animate-spin" />
                    <div className="text-xs text-slate-400">Cutting the clip</div>
                    <div className="text-[11px] text-slate-600 mt-0.5">
                      ffmpeg is pulling this window out of the footage
                    </div>
                  </div>
                ) : clip.isError ? (
                  <div className="text-xs text-amber-300">
                    {(clip.error as Error).message}
                  </div>
                ) : (
                  <button
                    onClick={() => clip.mutate()}
                    className="text-sm px-3 py-1.5 rounded bg-sky-600 text-white"
                  >
                    Pull the footage
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


/** Thresholds a detection must clear before it is reported.
 *
 *  The camera reports fixed objects as people — on this org, 221 of 227
 *  recorded tracks never moved and sat in three grid cells. Both knobs
 *  are shown against the tracks already on record, because a threshold
 *  is a guess until it is checked against real detections, and the
 *  history holds hundreds of them.
 */
function NoiseFilter({
  cameraId,
  status,
}: {
  cameraId: string;
  status?: MqttStatus;
}) {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ["mqtt-filters"],
    queryFn: () =>
      apiGet<{ min_area: number; min_movement: number; note: string }>(
        "/api/mqtt/filters",
      ),
  });

  const [area, setArea] = useState<number | null>(null);
  const [move, setMove] = useState<number | null>(null);
  const minArea = area ?? current.data?.min_area ?? 0.01;
  const minMove = move ?? current.data?.min_movement ?? 0;

  const preview = useQuery({
    queryKey: ["mqtt-filter-preview", minArea, minMove, cameraId],
    queryFn: () =>
      apiGet<{
        considered: number;
        kept: number;
        dropped: number;
        kept_by_type: Record<string, number>;
        would_drop: (TrackRecord & { area: number; travelled: number })[];
        closest_kept: (TrackRecord & { area: number; travelled: number })[];
      }>(
        `/api/mqtt/filters/preview?min_area=${minArea}&min_movement=${minMove}${
          cameraId ? `&camera_id=${cameraId}` : ""
        }`,
      ),
  });

  const save = useMutation({
    mutationFn: () =>
      apiPut("/api/mqtt/filters", {
        min_area: minArea,
        min_movement: minMove,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mqtt-filters"] });
      qc.invalidateQueries({ queryKey: ["mqtt-history"] });
    },
  });

  const dirty =
    current.data != null &&
    (minArea !== current.data.min_area || minMove !== current.data.min_movement);

  const [inspect, setInspect] = useState<TrackRecord | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const [showKept, setShowKept] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const purge = useMutation({
    mutationFn: () =>
      apiPost<{ removed: number; kept: number }>("/api/mqtt/filters/purge", {
        min_area: minArea,
        min_movement: minMove,
      }),
    onSuccess: () => {
      setConfirmPurge(false);
      qc.invalidateQueries({ queryKey: ["mqtt-history"] });
      qc.invalidateQueries({ queryKey: ["mqtt-filter-preview"] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">
              Minimum size
            </span>
            <span className="font-mono text-sm text-slate-200">
              {(minArea * 100).toFixed(1)}% of frame
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={0.05}
            step={0.001}
            value={minArea}
            onChange={(e) => setArea(Number(e.target.value))}
            className="w-full accent-sky-500 mt-1"
          />
          <p className="text-[11px] text-slate-500">
            The reliable one. Every false positive measured here sat under
            0.6% of frame; every real detection was above 2.6%.
          </p>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">
              Minimum movement
            </span>
            <span className="font-mono text-sm text-slate-200">
              {minMove === 0 ? "off" : `${(minMove * 100).toFixed(1)}% of frame`}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={0.2}
            step={0.005}
            value={minMove}
            onChange={(e) => setMove(Number(e.target.value))}
            className="w-full accent-sky-500 mt-1"
          />
          <p className="text-[11px] text-slate-500">
            Off by default — a subject standing still is still a subject. Turn
            it up only if size alone is not enough.
          </p>
        </div>
      </div>

      {preview.data?.considered === 0 && (
        <p className="text-[11px] text-slate-500">
          Nothing recorded yet, so there is nothing to tune against. These
          thresholds only see detections cameras published to this broker.
        </p>
      )}
      {preview.data && preview.data.considered > 0 && (
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="text-slate-400">
            Against {preview.data.considered.toLocaleString()} recorded tracks:
          </span>
          <span className="text-emerald-300">
            keeps <span className="font-mono">{preview.data.kept}</span>
          </span>
          <span className="text-rose-300">
            drops <span className="font-mono">{preview.data.dropped}</span>
          </span>
          {Object.entries(preview.data.kept_by_type).map(([t, n]) => (
            <span key={t} className="text-slate-500">
              {t} <span className="font-mono text-slate-300">{n}</span>
            </span>
          ))}
        </div>
      )}
      {/* The row above is a what-if over recorded history, and history
          only ever holds tracks that already passed the thresholds in
          force when they were written. So at unchanged settings it reads
          "drops 0" however much work the filter is actually doing, which
          looks broken while data is visibly arriving. The live counter is
          the one that answers "is this doing anything". */}
      {status && status.recorded_tracks + status.suppressed_tracks > 0 && (
        <p className="text-[11px] text-slate-500">
          Live since the backend restarted, these thresholds have kept{" "}
          <span className="font-mono text-emerald-300">{status.recorded_tracks}</span>{" "}
          and suppressed{" "}
          <span className="font-mono text-rose-300">{status.suppressed_tracks}</span>.
          The row above can only ever drop tracks that are already on record,
          so it stays at zero until you raise a slider past where it was when
          they were written.
        </p>
      )}

      {inspect && (
        <TrackReplay
          key={`${inspect.obj_id}-${inspect.started_at}`}
          track={inspect}
          onClose={() => setInspect(null)}
        />
      )}

      {/* Only worth showing when the threshold is actually cutting
          something. With nothing to drop these are just the history
          table below, repeated. */}
      {preview.data &&
        preview.data.closest_kept.length > 0 &&
        (preview.data.dropped > 0 || showKept) && (
          <div>
            <div className="flex items-baseline justify-between gap-3 mb-1.5">
              <div className="text-[11px] uppercase tracking-wider text-slate-400">
                Closest survivors — check these before applying
              </div>
              {preview.data.dropped === 0 && (
                <button
                  type="button"
                  onClick={() => setShowKept(false)}
                  className="text-[11px] text-slate-500 hover:text-slate-300"
                >
                  Hide
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mb-2">
              The kept tracks nearest the threshold. A count of what gets
              removed says nothing about whether the setting is about to remove
              something real; these are the rows that would go next.
            </p>
            <TrackRows rows={preview.data.closest_kept} onSelect={setInspect} />
          </div>
        )}

      {preview.data && preview.data.dropped === 0 && !showKept && (
        <p className="text-[11px] text-slate-500">
          Nothing on record falls below these thresholds.{" "}
          <button
            type="button"
            onClick={() => setShowKept(true)}
            className="underline underline-offset-2 hover:text-slate-300"
          >
            Show the closest survivors
          </button>{" "}
          to see how much headroom there is.
        </p>
      )}

      {preview.data && preview.data.dropped > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowDropped((v) => !v)}
            className="text-[11px] text-slate-500 hover:text-slate-300 underline underline-offset-2"
          >
            {showDropped ? "Hide" : "Show"} the {preview.data.dropped} tracks
            this would remove
          </button>
          {showDropped && (
            <div className="mt-2">
              <TrackRows rows={preview.data.would_drop} onSelect={setInspect} />
              {preview.data.would_drop.length < preview.data.dropped && (
                <p className="text-[11px] text-slate-600 mt-1">
                  Showing the first {preview.data.would_drop.length} of{" "}
                  {preview.data.dropped}.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Two separate decisions, so two separate captions. Sharing one
          sentence between them meant neither button said what it did. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-white/10 pt-4">
        <div>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
            className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {save.isPending
              ? "Saving…"
              : dirty
                ? "Save these settings"
                : "Settings saved"}
          </button>
          <p className="text-[11px] text-slate-500 mt-1.5">
            Detections below the threshold stop appearing in the live view and
            stop being recorded. Nothing already recorded changes.
          </p>
        </div>

        <div className={preview.data?.dropped ? "" : "hidden sm:block sm:invisible"}>
          <button
            type="button"
            onClick={() => setConfirmPurge(true)}
            disabled={!preview.data?.dropped || purge.isPending}
            className="text-sm px-3 py-1.5 rounded-md border border-rose-700/60 bg-rose-900/30 text-rose-200 hover:bg-rose-900/50 disabled:opacity-40"
          >
            {purge.isPending
              ? "Deleting…"
              : `Delete the ${preview.data?.dropped ?? 0} old tracks too`}
          </button>
          <p className="text-[11px] text-slate-500 mt-1.5">
            Clears them out of the history above as well, so past noise stops
            cluttering it. Permanent.
          </p>
        </div>
      </div>
      {purge.data && (
        <p className="text-xs text-emerald-300">
          Removed {purge.data.removed}; {purge.data.kept} kept.
        </p>
      )}
      {purge.isError && (
        <p className="text-xs text-rose-300">{(purge.error as Error).message}</p>
      )}

      <ConfirmDialog
        open={confirmPurge}
        title={`Delete ${preview.data?.dropped ?? 0} tracks from the history?`}
        body={`Anything smaller than ${(minArea * 100).toFixed(1)}% of the frame${
          minMove > 0 ? ` or that moved less than ${(minMove * 100).toFixed(1)}%` : ""
        } is removed for good. ${preview.data?.kept ?? 0} tracks stay. Worth checking the list above first — there is no undo.`}
        confirmLabel="Delete them"
        busy={purge.isPending}
        onCancel={() => setConfirmPurge(false)}
        onConfirm={() => purge.mutate()}
      />
    </div>
  );
}


/** Compact track rows with their measurements and route, for judging a
 *  threshold by eye rather than by count. */
function TrackRows({
  rows,
  onSelect,
}: {
  rows: (TrackRecord & { area: number; travelled: number })[];
  onSelect?: (t: TrackRecord) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-500 uppercase tracking-wider text-[10px]">
          <tr>
            <th className="text-left px-2 py-1">When</th>
            <th className="text-left px-2 py-1">Type</th>
            <th className="text-left px-2 py-1">Dwell</th>
            <th className="text-left px-2 py-1">Size</th>
            <th className="text-left px-2 py-1">Moved</th>
            <th className="text-left px-2 py-1">Path</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr
              key={`${t.obj_id}-${t.started_at}`}
              onClick={() => onSelect?.(t)}
              title={onSelect ? "Replay this track and pull the footage" : undefined}
              className={`border-t border-white/10 ${
                onSelect ? "cursor-pointer hover:bg-white/5" : ""
              }`}
            >
              <td className="px-2 py-1 font-mono text-slate-300 whitespace-nowrap">
                {new Date(t.started_at).toLocaleTimeString()}
              </td>
              <td className="px-2 py-1 whitespace-nowrap">
                <span
                  className="inline-block w-2 h-2 rounded-sm mr-1.5"
                  style={{ background: TYPE_COLOR[t.type] ?? "#94a3b8" }}
                />
                {t.type}
              </td>
              <td className="px-2 py-1 font-mono">{t.duration_sec}s</td>
              <td className="px-2 py-1 font-mono">
                {(t.area * 100).toFixed(2)}%
              </td>
              <td className="px-2 py-1 font-mono">
                {(t.travelled * 100).toFixed(1)}%
              </td>
              <td className="px-2 py-1">
                <PathSpark path={t.path} color={TYPE_COLOR[t.type] ?? "#94a3b8"} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


/** Whether vFusion is the broker, or is only pointing cameras at one.
 *
 *  These are different deployments, not a setting. Running the broker
 *  means vFusion can generate the certificate, invent the credentials
 *  and show what arrives. Pointing at somebody else's broker means it
 *  can do none of those: the camera validates against that broker's CA,
 *  which we do not hold, and the data goes somewhere we are not
 *  listening.
 */
function BrokerMode({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ["mqtt-broker-mode"],
    queryFn: () =>
      apiGet<{
        mode: "builtin" | "external";
        host: string;
        port: number;
        username: string;
        password_set: boolean;
        cert_present: boolean;
      }>("/api/mqtt/broker-mode"),
  });

  const [draft, setDraft] = useState<{
    mode: "builtin" | "external";
    host: string;
    port: number;
    username: string;
    password: string;
    broker_cert: string;
  } | null>(null);

  const value = draft ?? {
    mode: current.data?.mode ?? "builtin",
    host: current.data?.host ?? "",
    port: current.data?.port ?? 443,
    username: current.data?.username ?? "",
    password: "",
    broker_cert: "",
  };
  const set = (patch: Partial<typeof value>) => setDraft({ ...value, ...patch });

  const save = useMutation({
    mutationFn: () => apiPut("/api/mqtt/broker-mode", value),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["mqtt-broker-mode"] });
      onChanged();
    },
  });

  return (
    <div className="mb-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => set({ mode: "builtin" })}
          className={`text-left rounded-lg border p-3 transition-colors duration-150 ease-out-strong ${
            value.mode === "builtin"
              ? "border-sky-500/60 bg-sky-500/10"
              : "border-white/15 bg-white/5 hover:border-white/30"
          }`}
        >
          <div className="text-sm text-slate-100">vFusion is the broker</div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            It generates the certificate and credentials, cameras publish here,
            and everything below this card works.
          </div>
        </button>
        <button
          type="button"
          onClick={() => set({ mode: "external" })}
          className={`text-left rounded-lg border p-3 transition-colors duration-150 ease-out-strong ${
            value.mode === "external"
              ? "border-sky-500/60 bg-sky-500/10"
              : "border-white/15 bg-white/5 hover:border-white/30"
          }`}
        >
          <div className="text-sm text-slate-100">Point at another broker</div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            You supply its address, credentials and CA certificate. vFusion
            configures the cameras and stops — the data goes there, not here.
          </div>
        </button>
      </div>

      {value.mode === "external" && (
        <div className="mt-3 space-y-2">
          <BrokerRequirements />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Labeled label="Broker host">
              <input
                value={value.host}
                onChange={(e) => set({ host: e.target.value })}
                placeholder="mqtt.example.com"
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
                spellCheck={false}
              />
            </Labeled>
            <Labeled label="Port">
              <select
                value={value.port}
                onChange={(e) => set({ port: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                <option value={443}>443</option>
                <option value={123}>123</option>
                <option value={53}>53</option>
              </select>
            </Labeled>
            <Labeled label="Username">
              <input
                value={value.username}
                onChange={(e) => set({ username: e.target.value })}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
                spellCheck={false}
              />
            </Labeled>
          </div>
          <Labeled label="Password">
            <input
              type="password"
              value={value.password}
              onChange={(e) => set({ password: e.target.value })}
              placeholder={
                current.data?.password_set ? "unchanged" : "broker password"
              }
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
            />
          </Labeled>
          <Labeled label="Broker CA certificate">
            <textarea
              value={value.broker_cert}
              onChange={(e) => set({ broker_cert: e.target.value })}
              rows={3}
              placeholder={
                current.data?.cert_present
                  ? "unchanged — paste a new PEM to replace it"
                  : "-----BEGIN CERTIFICATE----- …"
              }
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs font-mono"
              spellCheck={false}
            />
          </Labeled>
          <p className="text-[11px] text-slate-500">
            The CA that signs your broker's certificate, not the broker's own
            certificate. The camera uses it as its only trust anchor — a leaf
            gets rejected as "unknown ca". Port is limited to 443, 123 or 53
            because Verkada refuses anything else.
          </p>
        </div>
      )}

      {draft && (
        <div className="flex items-center gap-3 mt-3">
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {save.isPending ? "Saving…" : "Save broker setup"}
          </button>
          <button
            type="button"
            onClick={() => setDraft(null)}
            className="text-[11px] text-slate-500 hover:text-slate-300"
          >
            Cancel
          </button>
          {save.isError && (
            <span className="text-xs text-rose-300">
              {(save.error as Error).message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}


/**
 * What a broker has to do before a Verkada camera will publish to it.
 *
 * None of this is discoverable from the API — a camera accepts a
 * configuration it cannot use, reports nothing, and leaves the evidence
 * in a log on the broker side. So each requirement is paired with the
 * symptom you get without it, because the symptom is what someone
 * actually has in front of them when they come looking. Knowing that a
 * CA without basicConstraints reads as "bad certificate" is the whole
 * value; the requirement on its own is a sentence you have already read
 * and dismissed.
 *
 * vFusion's built-in broker satisfies all of it, which is why this only
 * appears when you have pointed the cameras somewhere else.
 */
function BrokerRequirements() {
  const [open, setOpen] = useState(false);
  const reqs = useQuery({
    queryKey: ["mqtt-broker-requirements"],
    queryFn: () =>
      apiGet<{
        requirements: { id: string; title: string; detail: string; symptom: string }[];
        allowed_ports?: number[];
        topic?: string;
      }>("/api/mqtt/broker-requirements"),
  });

  const items = reqs.data?.requirements ?? [];
  if (items.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <p className="text-xs text-slate-300">
        Your broker has to satisfy {items.length} requirements before a camera
        will publish to it — vFusion&rsquo;s built-in one already does. None of
        them are reported by the API: a camera accepts a configuration it
        cannot use and says nothing, so each one lists the symptom you get
        without it.
      </p>
      {reqs.data?.topic && (
        <p className="text-[11px] text-slate-500 mt-1">
          Cameras publish to <code className="text-slate-400">{reqs.data.topic}</code>
          {reqs.data.allowed_ports
            ? ` on port ${reqs.data.allowed_ports.join(", ")} — Verkada rejects every other port outright.`
            : "."}
        </p>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs mt-2 px-3 py-1.5 rounded border border-amber-500/30 text-amber-200 hover:bg-amber-500/10"
      >
        {open ? "Hide them" : `Read them before you configure this`}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {items.map((r) => (
            <div key={r.id} className="border-t border-white/10 pt-3">
              <div className="text-sm text-slate-100">{r.title}</div>
              <p className="text-xs text-slate-400 mt-0.5">{r.detail}</p>
              <p className="text-[11px] text-amber-300/90 mt-1">
                Without it: {r.symptom}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
