import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost } from "../lib/api";

/**
 * A demo that runs, with footage behind every event.
 *
 * The Connector records what the virtual camera sends when it arrives,
 * so a backfilled event can never have matching video. This runs
 * forward instead: a clip plays, and the Helix event is stamped inside
 * the window it played in.
 *
 * The offset is exposed because it decides whether that works. Between
 * ffmpeg emitting a frame and the Connector writing it to disk there is
 * real latency, and an event that lands outside its clip points at an
 * empty room — worse than no demo. Start at the default, look at one
 * event in Command, and correct it.
 */

interface QueueItem {
  id: string;
  name: string;
  kind: string;
}

interface LiveState {
  status: string;
  posted?: number;
  requested?: number;
  offset_sec?: number;
  interval_sec?: number;
  events?: { at: string; attributes: Record<string, string> }[];
  errors?: string[];
}

export default function LiveDemoPanel({
  connId,
  cameraId,
  eventTypeUid,
  spec,
}: {
  connId: string;
  cameraId: string;
  eventTypeUid: string;
  spec: Record<string, unknown> | null;
}) {
  const qc = useQueryClient();
  const [eventClip, setEventClip] = useState("");
  const [count, setCount] = useState(10);
  const [interval, setIntervalSec] = useState(120);
  const [offset, setOffset] = useState(3);
  const [err, setErr] = useState<string | null>(null);

  const clips = useQuery({
    queryKey: ["rtsp-queue"],
    queryFn: () => apiGet<QueueItem[]>("/api/rtsp/queue"),
  });

  const state = useQuery({
    queryKey: ["helix-live"],
    queryFn: () => apiGet<LiveState>("/api/helix-demo/live"),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 5000 : false),
  });

  const start = useMutation({
    mutationFn: () =>
      apiPost<LiveState>("/api/helix-demo/live/start", {
        connection_id: connId,
        camera_id: cameraId,
        event_type_uid: eventTypeUid,
        spec,
        event_clip_id: eventClip,
        count,
        interval_sec: interval,
        offset_sec: offset,
      }),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["helix-live"] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const stop = useMutation({
    mutationFn: () => apiPost<LiveState>("/api/helix-demo/live/stop", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["helix-live"] }),
  });

  const running = state.data?.status === "running";
  const videos = (clips.data ?? []).filter((c) => c.kind === "video");
  const minutes = Math.round((count * interval) / 60);

  // Everything this needs before it can run, in the order you would fix
  // them. Listed rather than enforced by hiding the panel: a control
  // that disappears until it is satisfiable cannot tell you why.
  const blockers: string[] = [];
  if (!cameraId) blockers.push("Pick a camera above.");
  if (!eventTypeUid)
    blockers.push(
      "Create the Helix event type above — the events need somewhere to go.",
    );
  if (videos.length === 0)
    blockers.push(
      "Generate a clip on Workbench › Video, then press “Use in virtual camera” on it.",
    );
  if (!eventClip && videos.length > 0) blockers.push("Pick a clip below.");

  return (
    <div className="space-y-3">

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block sm:col-span-2">
          <div className="text-xs text-slate-300 mb-1">Clip to play per event</div>
          <select
            value={eventClip}
            onChange={(e) => setEventClip(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
          >
            <option value="">— pick a clip —</option>
            {videos.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {videos.length === 0 && (
            <p className="text-[11px] text-amber-300 mt-1">
              Nothing in the camera's queue yet. Generate a clip on Workbench ›
              Video, then press “Use in virtual camera”.
            </p>
          )}
        </label>

        <label className="block">
          <div className="text-xs text-slate-300 mb-1">How many events</div>
          <input
            type="number"
            min={1}
            max={200}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
          />
        </label>
        <label className="block">
          <div className="text-xs text-slate-300 mb-1">Seconds between</div>
          <input
            type="number"
            min={15}
            max={3600}
            value={interval}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
          />
        </label>

        <label className="block sm:col-span-2">
          <div className="text-xs text-slate-300 mb-1">
            Recording offset — {offset.toFixed(1)}s
          </div>
          <input
            type="range"
            min={-5}
            max={20}
            step={0.5}
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
            className="w-full"
          />
          <p className="text-[11px] text-slate-500 mt-0.5">
            How far the Connector's recording lags the encoder. The event is
            stamped mid-clip plus this. If your first event shows an empty
            room, open it in Command, see how far off it is, and move this by
            that much.
          </p>
        </label>
      </div>

      {blockers.length > 0 && !running && (
        <ul className="text-[11px] text-amber-300 space-y-0.5 list-disc pl-4">
          {blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {running ? (
          <button
            type="button"
            onClick={() => stop.mutate()}
            className="px-4 py-2 rounded bg-rose-800 hover:bg-rose-700 text-white text-sm"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={blockers.length > 0 || !spec}
            className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white text-sm disabled:opacity-40"
          >
            Start
          </button>
        )}
        <span className="text-[11px] text-slate-500">
          {running
            ? `${state.data?.posted ?? 0} of ${state.data?.requested ?? 0} posted`
            : `runs for about ${minutes} minute${minutes === 1 ? "" : "s"}`}
        </span>
      </div>

      {err && <div className="text-xs text-rose-300">{err}</div>}
      {(state.data?.errors ?? []).length > 0 && (
        <div className="text-xs text-rose-300">{state.data!.errors![0]}</div>
      )}

      {(state.data?.events ?? []).length > 0 && (
        <div className="text-[11px] text-slate-400 space-y-0.5 max-h-40 overflow-y-auto">
          {state.data!.events!.map((e) => (
            <div key={e.at} className="font-mono">
              {new Date(e.at).toLocaleTimeString()} ·{" "}
              {Object.values(e.attributes).slice(0, 3).join(" · ")}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
