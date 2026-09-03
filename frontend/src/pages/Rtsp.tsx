import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { API_BASE, apiDelete, apiGet, apiPost, apiPut } from "../lib/api";
import ConfirmDialog from "../components/ConfirmDialog";

/**
 * A camera that does not exist, for Verkada's Command Connector.
 *
 * The Connector adds third-party cameras by RTSP URL and then expects
 * that URL to keep answering forever — a stream that stops between
 * clips gets the camera marked offline. So this page is really one
 * switch and one promise: while it is on, there is always a picture,
 * even when there is nothing to show.
 */

type Status = {
  enabled: boolean;
  stream: string;
  advertise_host: string;
  read_username: string;
  read_password: string;
  loop: boolean;
  url: string;
  width: number;
  height: number;
  fps: number;
  port: number;
  readers: number | null;
  queued: number;
  played: number;
  pump: {
    running: boolean;
    publishing: boolean;
    now_playing: { id: string; name: string; kind: string } | null;
    uptime_sec: number | null;
    encoder_starts: number;
    last_error: string | null;
    log: string[];
  };
};

type QueueItem = {
  id: string;
  name: string;
  kind: "video" | "image";
  seconds: number | null;
  bytes: number;
  added_at: string;
  played_at: string | null;
};

const fmtBytes = (n: number) =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString() : "—";

export default function Rtsp() {
  const qc = useQueryClient();
  const [host, setHost] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<QueueItem | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const status = useQuery({
    queryKey: ["rtsp-status"],
    queryFn: () => apiGet<Status>("/api/rtsp/status"),
    refetchInterval: 3000,
  });
  const items = useQuery({
    queryKey: ["rtsp-queue"],
    queryFn: () => apiGet<QueueItem[]>("/api/rtsp/queue"),
    refetchInterval: 3000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["rtsp-status"] });
    qc.invalidateQueries({ queryKey: ["rtsp-queue"] });
  };

  const saveHost = useMutation({
    mutationFn: (advertise_host: string) =>
      apiPut<Status>("/api/rtsp/settings", { advertise_host }),
    onSuccess: () => invalidate(),
  });
  const toggle = useMutation({
    // Saves the address on the way through. It sits in local state until
    // Save is pressed, so a typed-but-unsaved value looked committed and
    // turning the stream on failed with "set the address first" while
    // the address was plainly right there on screen.
    mutationFn: async (enabled: boolean) => {
      if (enabled) {
        const typed = (host ?? "").trim();
        if (typed && typed !== status.data?.advertise_host) {
          await apiPut<Status>("/api/rtsp/settings", { advertise_host: typed });
        }
      }
      return apiPost<Status>("/api/rtsp/enable", { enabled });
    },
    onSuccess: () => {
      setToggleError(null);
      invalidate();
    },
    onError: (e: Error) => setToggleError(e.message),
  });
  const rotate = useMutation({
    mutationFn: () => apiPost<Status>("/api/rtsp/rotate-password", {}),
    onSuccess: () => invalidate(),
  });
  const requeue = useMutation({
    mutationFn: (id: string) => apiPost(`/api/rtsp/queue/${id}/requeue`, {}),
    onSuccess: () => invalidate(),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/rtsp/queue/${id}`),
    onSuccess: () => invalidate(),
  });
  const clearPlayed = useMutation({
    mutationFn: () => apiPost<{ removed: number }>("/api/rtsp/queue/clear-played", {}),
    onSuccess: () => invalidate(),
  });

  // Multipart, so this one goes around apiPost.
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const resp = await fetch(`${API_BASE}/api/rtsp/queue`, {
        method: "POST",
        credentials: "include",
        body,
      });
      if (!resp.ok) {
        const text = await resp.text();
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { detail?: unknown };
          if (typeof parsed.detail === "string") detail = parsed.detail;
        } catch {
          /* keep the raw body */
        }
        throw new Error(detail || `upload failed (${resp.status})`);
      }
      return resp.json();
    },
    onSuccess: () => {
      setUploadError(null);
      invalidate();
    },
    onError: (e: Error) => setUploadError(e.message),
  });

  const s = status.data;
  const hostValue = host ?? s?.advertise_host ?? "";
  const pending = (items.data ?? []).filter((i) => !i.played_at);
  const done = (items.data ?? []).filter((i) => i.played_at);

  return (
    <div className="flex flex-col gap-4">
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete "${pendingDelete?.name ?? ""}"?`}
        body="The file goes with it. If it is playing right now, the stream moves on to the next item."
        busy={del.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) del.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />

      <div>
        <h1 className="text-2xl font-semibold text-white">Virtual camera</h1>
        <p className="text-slate-400 text-sm mt-1">
          A camera that does not exist, for Verkada's Command Connector to
          record. While it is on there is always a picture — your uploads when
          there are any, black with a clock when there are not — so the camera
          never goes offline between clips.
        </p>
      </div>

      <StatusBar s={s} />

      <Card title="1 · Where the Connector will find it">
        <label className="block text-[11px] uppercase tracking-wider text-slate-400 mb-1">
          Address this machine answers on
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            value={hostValue}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.50"
            className="flex-1 min-w-[16rem] px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => saveHost.mutate(hostValue.trim())}
            disabled={saveHost.isPending || !hostValue.trim()}
            className="text-sm px-3 py-1.5 rounded-md border border-white/15 text-slate-200 hover:bg-white/10 disabled:opacity-50"
          >
            {saveHost.isPending ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mt-1.5">
          Host or IP only — the port is {s?.port ?? 8554}, set by
          RTSP_PUBLIC_PORT. The Connector reaches this
          across your network, and a container cannot work out its own LAN
          address, so this is the one thing that has to be typed. Use something
          that will not move: a static IP, a DHCP reservation or a DNS name.
        </p>
      </Card>

      <Card title="2 · Turn it on">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => toggle.mutate(!s?.enabled)}
            disabled={toggle.isPending}
            className={`text-sm px-4 py-2 rounded-md border transition-colors ${
              s?.enabled
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                : "border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"
            } disabled:opacity-50`}
          >
            {toggle.isPending
              ? "Working…"
              : s?.enabled
                ? "Stream is on — turn it off"
                : "Turn the stream on"}
          </button>
          {s?.enabled && (
            <span className="text-[11px] text-slate-500">
              {s.width}×{s.height} · {s.fps} fps · H.264
            </span>
          )}
        </div>

        {toggleError && (
          <div className="mt-3 text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
            {toggleError}
          </div>
        )}

        {s?.url && s.read_password && (
          <div className="mt-4 space-y-2">
            <p className="text-[11px] text-slate-400">
              In Command: <strong className="text-slate-200">Add Cameras</strong> →{" "}
              <strong className="text-slate-200">RTSP</strong>, then paste these.
              {!s.enabled && (
                <span className="text-slate-500">
                  {" "}
                  They exist as soon as an address is saved, so you can test the
                  stream yourself before pointing Verkada at it — but nothing
                  answers on that URL until it is on.
                </span>
              )}
            </p>
            <CopyRow label="RTSP URL (HQ)" value={s.url} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <CopyRow label="Username" value={s.read_username} />
              <CopyRow label="Password" value={s.read_password} secret />
            </div>
            <button
              type="button"
              onClick={() => rotate.mutate()}
              disabled={rotate.isPending}
              className="text-[11px] text-slate-500 hover:text-slate-300 underline underline-offset-2 disabled:opacity-50"
            >
              {rotate.isPending ? "Rotating…" : "Generate a new password"}
            </button>
            <p className="text-[11px] text-slate-500">
              Rotating does not drop the session the Connector already has — it
              breaks the next time it reconnects. Update the camera in Command
              before that happens.
            </p>
          </div>
        )}
      </Card>

      <Card title="3 · What it plays">
        <input
          ref={fileRef}
          type="file"
          accept="video/*,image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) upload.mutate(file);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
            className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
          >
            {upload.isPending ? "Uploading…" : "Upload media"}
          </button>
          <span className="text-[11px] text-slate-500">
            Video or stills. Scaled and padded to {s?.width ?? 1920}×
            {s?.height ?? 1080} — the shape is fixed once the Connector has
            negotiated it, so a clip of another size is letterboxed rather than
            stretched.
          </span>
        </div>

        {uploadError && (
          <div className="mt-2 text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
            {uploadError}
          </div>
        )}

        {pending.length === 0 && done.length === 0 ? (
          <p className="text-[11px] text-slate-500 mt-3">
            Nothing uploaded. The stream is showing the standby card.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {pending.length > 0 && (
              <QueueTable
                title={`Up next — ${pending.length}`}
                items={pending}
                nowPlayingId={s?.pump.now_playing?.id ?? null}
                onDelete={setPendingDelete}
              />
            )}
            {done.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400">
                    Played — {done.length}
                  </div>
                  <button
                    type="button"
                    onClick={() => clearPlayed.mutate()}
                    disabled={clearPlayed.isPending}
                    className="text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-50"
                  >
                    {clearPlayed.isPending ? "Clearing…" : "Clear played"}
                  </button>
                </div>
                <QueueTable
                  items={done}
                  nowPlayingId={null}
                  onDelete={setPendingDelete}
                  onRequeue={(id) => requeue.mutate(id)}
                />
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function StatusBar({ s }: { s?: Status }) {
  if (!s) return null;
  const items: { label: string; value: string; good: boolean; hint: string }[] = [
    {
      label: "Stream",
      value: s.pump.publishing ? "publishing" : s.enabled ? "starting" : "off",
      good: s.pump.publishing,
      hint: "Whether the encoder is pushing frames into the RTSP server",
    },
    {
      label: "Watching",
      value:
        s.readers == null
          ? "unknown"
          : s.readers === 0
            ? "nobody"
            : `${s.readers} client${s.readers === 1 ? "" : "s"}`,
      good: (s.readers ?? 0) > 0,
      // The distinction is load-bearing: unknown means the RTSP server
      // did not answer, which is a different problem from a Connector
      // that has not been pointed here yet.
      hint:
        s.readers == null
          ? "The RTSP server did not answer — it may not be running"
          : "Clients pulling the stream. The Command Connector is one of these",
    },
    {
      label: "Showing",
      value: s.pump.now_playing ? s.pump.now_playing.name : "standby",
      good: !!s.pump.now_playing,
      hint: "The queue item on screen right now, or the black standby card",
    },
    {
      label: "Up",
      value:
        s.pump.uptime_sec == null
          ? "—"
          : s.pump.uptime_sec < 90
            ? `${Math.round(s.pump.uptime_sec)}s`
            : `${Math.round(s.pump.uptime_sec / 60)}m`,
      good: s.pump.running,
      hint: "How long the stream has been up. Restarts here are what take a camera offline",
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
            className={`text-sm font-mono truncate ${
              item.good ? "text-emerald-300" : "text-slate-300"
            }`}
          >
            {item.value}
          </div>
        </div>
      ))}
      {s.pump.encoder_starts > 1 && (
        <div className="col-span-2 sm:col-span-4 text-[11px] text-amber-300/90">
          The encoder has restarted {s.pump.encoder_starts - 1} time
          {s.pump.encoder_starts === 2 ? "" : "s"} since the stream was turned
          on. Each restart is a moment where the Connector could have seen the
          camera drop.
        </div>
      )}
      {/* ffmpeg's own words. An exit code alone says a thing failed;
          these say which thing, which is the difference between reading
          this page and reading container logs. */}
      {(s.pump.log ?? []).length > 0 && (
        <details className="col-span-2 sm:col-span-4">
          <summary className="text-[11px] text-amber-300/90 cursor-pointer">
            {s.pump.last_error ?? "encoder output"}
          </summary>
          <pre className="mt-1.5 text-[10px] font-mono text-slate-400 bg-black/40 border border-white/10 rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {(s.pump.log ?? []).join("\n")}
          </pre>
        </details>
      )}
      {s.pump.last_error && (s.pump.log ?? []).length === 0 && (
        <div className="col-span-2 sm:col-span-4 text-[11px] text-amber-300/90">
          {s.pump.last_error}
        </div>
      )}
    </div>
  );
}

function QueueTable({
  title,
  items,
  nowPlayingId,
  onDelete,
  onRequeue,
}: {
  title?: string;
  items: QueueItem[];
  nowPlayingId: string | null;
  onDelete: (item: QueueItem) => void;
  onRequeue?: (id: string) => void;
}) {
  return (
    <div>
      {title && (
        <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
          {title}
        </div>
      )}
      <div className="border border-white/15 rounded-lg overflow-hidden bg-white/5">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-white/10">
            {items.map((i) => (
              <tr key={i.id} className={i.id === nowPlayingId ? "bg-sky-950/30" : ""}>
                <td className="px-3 py-2">
                  <span className="text-slate-100">{i.name}</span>
                  {i.id === nowPlayingId && (
                    <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                      ON AIR
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                  {i.kind}
                  {i.kind === "image" && i.seconds ? ` · ${i.seconds}s` : ""} ·{" "}
                  {fmtBytes(i.bytes)}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                  {i.played_at ? `played ${fmtTime(i.played_at)}` : fmtTime(i.added_at)}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {onRequeue && (
                    <button
                      type="button"
                      onClick={() => onRequeue(i.id)}
                      className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-600 mr-2"
                    >
                      Play again
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDelete(i)}
                    className="text-xs px-2 py-1 rounded border border-white/15 text-slate-400 hover:text-rose-300 hover:border-rose-800"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CopyRow({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm text-slate-200">
          {shown ? value : "•".repeat(Math.min(value.length, 20))}
        </code>
        {secret && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            className="text-xs px-2 py-1.5 rounded border border-white/15 text-slate-400 hover:text-slate-200"
          >
            {shown ? "Hide" : "Show"}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="text-xs px-2 py-1.5 rounded border border-white/15 text-slate-200 hover:border-sky-600"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-white/15 rounded-lg bg-white/5 p-4">
      <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-3">
        {title}
      </div>
      {children}
    </div>
  );
}
