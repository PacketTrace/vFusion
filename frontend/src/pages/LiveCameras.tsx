import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import LivePlayer from "../components/LivePlayer";
import SectionHeading from "../components/SectionHeading";
import { apiDelete, apiGet } from "../lib/api";
import { useCameras } from "../lib/cameras";

/**
 * Watching a camera, live, without leaving vFusion.
 *
 * Everything else here works from a still or a saved clip, which is
 * enough to build an analytic and not enough to tell whether a camera
 * is pointed where you think it is.
 */

type Session = {
  session_id: string;
  camera_id: string;
  name: string;
  ready: boolean;
  error: string | null;
  restarts: number;
  idle_sec: number;
};

export default function LiveCameras() {
  const cameras = useCameras();
  const [selected, setSelected] = useState<string>("");
  const [query, setQuery] = useState("");
  const qc = useQueryClient();

  const sessions = useQuery({
    queryKey: ["live-sessions"],
    queryFn: () =>
      apiGet<{ sessions: Session[]; max_sessions: number }>("/api/live"),
    refetchInterval: 5000,
  });

  const shown = useMemo(() => {
    const all = cameras.data ?? [];
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? all.filter((c) =>
          `${c.name ?? ""} ${c.site ?? ""} ${c.camera_id}`
            .toLowerCase()
            .includes(needle),
        )
      : all;
    // Online first: an offline camera has nothing to show, and burying
    // the ones that do behind them is the whole list's usefulness gone.
    return [...matched].sort((a, b) => {
      const rank = (s: string | null) =>
        (s ?? "").toLowerCase() === "live" ? 0 : 1;
      return rank(a.status) - rank(b.status) || (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [cameras.data, query]);

  const active = sessions.data?.sessions ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <LivePlayer cameraId={selected} />
          {selected && (
            <p className="text-[11px] text-slate-500">
              Re-encoded to H.264 on the server, so the Verkada stream token
              never reaches this page. Expect a few seconds behind real time —
              that is the segment buffer, not the camera.
            </p>
          )}
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <SectionHeading hint={`${shown.length} cameras`}>Cameras</SectionHeading>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or site"
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600/60 focus:outline-none"
            />
            <div className="max-h-[420px] overflow-y-auto rounded-lg border border-white/10 bg-white/[0.03] divide-y divide-white/5">
              {cameras.isLoading && (
                <p className="p-3 text-sm text-slate-500">Loading cameras…</p>
              )}
              {!cameras.isLoading && shown.length === 0 && (
                <p className="p-3 text-sm text-slate-500">
                  No cameras match. They come from the last Verkada sync on the
                  Connections page.
                </p>
              )}
              {shown.map((c) => {
                const online = (c.status ?? "").toLowerCase() === "live";
                const isSelected = c.camera_id === selected;
                return (
                  <button
                    key={c.camera_id}
                    data-testid="camera-item"
                    data-online={online ? "true" : "false"}
                    data-camera-id={c.camera_id}
                    onClick={() => setSelected(c.camera_id)}
                    className={`w-full px-3 py-2 text-left transition-colors duration-150 ease-out-strong ${
                      isSelected
                        ? "bg-sky-500/10 text-sky-200"
                        : "text-slate-300 hover:bg-white/5"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          online ? "bg-emerald-400" : "bg-slate-600"
                        }`}
                      />
                      <span className="truncate text-sm">
                        {c.name || `${c.camera_id.slice(0, 8)}…`}
                      </span>
                    </span>
                    <span className="ml-3.5 block truncate text-[11px] text-slate-500">
                      {[c.site, c.model].filter(Boolean).join(" · ") || "—"}
                      {!online && " · offline"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <SectionHeading
              hint={
                sessions.data
                  ? `${active.length} of ${sessions.data.max_sessions}`
                  : undefined
              }
            >
              Streaming now
            </SectionHeading>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
              {active.length === 0 && (
                <p className="text-[11px] text-slate-500">
                  Nothing is being transcoded. Streams stop on their own once
                  nobody is watching.
                </p>
              )}
              {active.map((s) => (
                <div
                  key={s.session_id}
                  data-testid="live-session"
                  className="flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">{s.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {s.error
                        ? s.error
                        : s.ready
                          ? `live${s.restarts ? ` · ${s.restarts} reconnects` : ""}`
                          : "starting…"}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      await apiDelete(`/api/live/${s.session_id}`);
                      qc.invalidateQueries({ queryKey: ["live-sessions"] });
                    }}
                    className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-400 transition-[color,border-color] duration-150 ease-out-strong hover:border-rose-600/60 hover:text-rose-300"
                  >
                    Stop
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
