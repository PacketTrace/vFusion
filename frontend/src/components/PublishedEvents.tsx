import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet, HelixEventType } from "../lib/api";
import { useCameras } from "../lib/cameras";

type PublishedEvent = {
  camera_id: string | null;
  event_type_uid: string | null;
  time_ms: number | null;
  flagged: boolean;
  attributes: Record<string, unknown>;
};

type PublishedResponse = {
  events: PublishedEvent[];
  next_token: unknown;
  path_used: string;
  method_used: string;
  source: string;
};

/** Stable identity for one event. Helix returns no id, so the closest
 *  thing is the triple that cannot repeat: a camera does not get two
 *  events of the same type at the same millisecond. */
const keyOf = (e: PublishedEvent) =>
  `${e.camera_id}|${e.event_type_uid}|${e.time_ms}`;

/**
 * What is actually on Verkada, polled.
 *
 * Everything else on this page is our own view: types we synced, events
 * a flow believes it posted. This asks Verkada. It is the difference
 * between "the run said HTTP 200" and "the event is there", and those
 * come apart more often than you would like.
 *
 * New arrivals are marked rather than just appearing at the top, because
 * a list that reorders on a ten-second timer is very hard to read: you
 * cannot tell what moved from what is new without watching it happen.
 */
export default function PublishedEvents({ connId }: { connId: string }) {
  const [live, setLive] = useState(true);
  const cameras = useCameras();

  const q = useQuery({
    queryKey: ["helix-published", connId],
    queryFn: () =>
      apiGet<PublishedResponse>(
        `/api/helix-published?connection_id=${connId}&limit=60`,
      ),
    enabled: !!connId,
    refetchInterval: live ? 10_000 : false,
    // Keep the last good page on screen while the next one is in
    // flight. Blanking every ten seconds would make the section
    // unreadable even when everything is working.
    placeholderData: (prev) => prev,
  });

  const types = useQuery({
    queryKey: ["helix-event-types", connId],
    queryFn: () =>
      apiGet<HelixEventType[]>(`/api/connections/${connId}/helix-event-types`),
    enabled: !!connId,
    staleTime: 60_000,
  });

  const typeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of types.data ?? [])
      m.set(t.event_type_uid, t.name ?? t.event_type_uid);
    return m;
  }, [types.data]);

  const cameraName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cameras.data ?? []) m.set(c.camera_id, c.name ?? c.camera_id);
    return m;
  }, [cameras.data]);

  // Keys seen on a previous poll. Anything not in here is new since you
  // started watching — which is the question this section exists to
  // answer.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const events = q.data?.events ?? [];

  useEffect(() => {
    if (!q.data) return;
    const keys = new Set(events.map(keyOf));
    if (seen.current === null) {
      // First load is the baseline. Marking all sixty as new would be
      // true and useless.
      seen.current = keys;
      return;
    }
    const added = [...keys].filter((k) => !seen.current!.has(k));
    if (added.length) setFresh((prev) => new Set([...prev, ...added]));
    seen.current = keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  const err = q.error as Error | null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-xs text-slate-400">
          Read straight from Verkada — what is on the timeline, not what
          vFusion thinks it posted.
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
            className="accent-sky-500"
          />
          Refresh every 10s
        </label>
        <button
          type="button"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="text-xs px-2 py-1 rounded-md border border-white/15 text-slate-300 hover:bg-white/10 disabled:opacity-40"
        >
          {q.isFetching ? "Checking…" : "Check now"}
        </button>
      </div>

      {err && (
        <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2 whitespace-pre-wrap">
          {err.message}
        </div>
      )}

      {!err && q.data && (
        <div className="text-[11px] text-slate-600 font-mono">
          {q.data.method_used} {q.data.path_used}
          {q.data.source === "fallback" && (
            <span className="text-amber-400/80">
              {" "}
              · path guessed, catalog has no Helix search — run the API
              catalog crawl to confirm it
            </span>
          )}
        </div>
      )}

      {!err && q.data && events.length === 0 && (
        <div className="text-sm text-slate-500 py-6 text-center">
          Verkada returned no Helix events for this org.
        </div>
      )}

      <ul className="divide-y divide-white/10">
        {events.map((e) => {
          const k = keyOf(e);
          const isNew = fresh.has(k);
          const attrs = Object.entries(e.attributes ?? {});
          return (
            <li
              key={k}
              className={`py-2.5 px-2 -mx-2 rounded transition-colors ${
                isNew ? "bg-emerald-500/10" : ""
              }`}
            >
              <div className="flex items-baseline gap-2 flex-wrap">
                {isNew && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-200">
                    new
                  </span>
                )}
                <span className="text-sm font-medium text-slate-100">
                  {e.event_type_uid
                    ? (typeName.get(e.event_type_uid) ?? e.event_type_uid)
                    : "(no type)"}
                </span>
                <span className="text-xs text-slate-500">
                  {e.camera_id
                    ? (cameraName.get(e.camera_id) ?? e.camera_id)
                    : "(no camera)"}
                </span>
                {e.flagged && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300">
                    flagged
                  </span>
                )}
                <span className="ml-auto text-[11px] text-slate-500 tabular-nums">
                  {e.time_ms ? new Date(e.time_ms).toLocaleString() : "—"}
                </span>
              </div>
              {attrs.length > 0 && (
                <div className="mt-1.5 space-y-0.5">
                  {attrs.map(([k2, v]) => (
                    <div key={k2} className="flex gap-2 text-[11px]">
                      <span className="font-mono text-slate-500 shrink-0">
                        {k2}
                      </span>
                      <span className="text-slate-300 break-words">
                        {typeof v === "string" ? v : JSON.stringify(v)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
