import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiDelete,
  apiGet,
  apiPost,
  Connection,
  HelixEventType,
} from "../lib/api";
import HelixEventTypeEditor from "../components/HelixEventTypeEditor";


/**
 * The Helix tab — event type CRUD.
 *
 * Lists every Helix event type for a chosen Verkada connection. The
 * editor itself lives in ``components/HelixEventTypeEditor`` so it can
 * also be opened from the flow editor's helix_event_ref picker when an
 * operator needs a new type while wiring up a step.
 *
 * Scope is deliberately narrow: types only, not event instances. Posting
 * actual events still happens via flows (the verkada_helix_event action).
 */


export default function Helixr() {
  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const verkadaConns = useMemo(
    () =>
      (conns.data ?? []).filter(
        (c) => c.type === "verkada" && c.setup_complete,
      ),
    [conns.data],
  );
  const [connId, setConnId] = useState<string>("");
  // Default to first connection once they load.
  if (!connId && verkadaConns.length > 0 && verkadaConns[0]) {
    setConnId(verkadaConns[0].id);
  }
  const [editing, setEditing] = useState<HelixEventType | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-6">
      {verkadaConns.length === 0 ? (
        <Card>
          <div className="text-sm text-amber-200">
            You need at least one ready Verkada org in{" "}
            <a href="/connections" className="text-sky-300 hover:underline">
              Connections
            </a>{" "}
            to manage Helix event types.
          </div>
        </Card>
      ) : (
        <>
          {/* What a Helix event type is, in the terms someone arriving
              here has. The tab blurb says what the page does; this says
              why the thing it manages exists, which is the part that is
              not guessable from a list of names and attributes. */}
          <div className="text-[11px] text-slate-500 leading-relaxed max-w-3xl">
            A Helix event type is a schema Verkada stores against a camera's
            timeline — a name and a set of typed attributes. When an analytic
            runs, its answer is written into one of these, and Command can then
            search and filter footage by those attributes.
            <br />
            Anything that writes to Helix has to name a type that already
            exists on the org, which is what this page is for: create one,
            change its attributes, or remove one nothing posts against any
            more. Renaming or removing an attribute that events were already
            written with will break searches that rely on it.
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-slate-300">Verkada org</span>
              <select
                value={connId}
                onChange={(e) => setConnId(e.target.value)}
                className="px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {verkadaConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => setCreating(true)}
              disabled={!connId}
              className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
            >
              + Create event type
            </button>
          </div>

          {connId && (
            <EventTypeList
              connId={connId}
              onEdit={(et) => setEditing(et)}
            />
          )}

          {creating && (
            <HelixEventTypeEditor
              connId={connId}
              mode="create"
              onClose={() => setCreating(false)}
            />
          )}
          {editing && (
            <HelixEventTypeEditor
              connId={connId}
              mode="edit"
              existing={editing}
              onClose={() => setEditing(null)}
            />
          )}
        </>
      )}
    </div>
  );
}


function EventTypeList({
  connId,
  onEdit,
}: {
  connId: string;
  onEdit: (et: HelixEventType) => void;
}) {
  const types = useQuery({
    queryKey: ["helix-event-types", connId],
    queryFn: () =>
      apiGet<HelixEventType[]>(`/api/connections/${connId}/helix-event-types`),
    enabled: !!connId,
  });
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: () =>
      apiPost(`/api/connections/${connId}/sync-helix`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["helix-event-types", connId] }),
  });
  // Two-step, and no browser confirm(): Verkada does not document what
  // happens to events already logged against a type, so this is treated
  // as unrecoverable and the name has to be read before it goes.
  const [confirming, setConfirming] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: (uid: string) =>
      apiDelete(`/api/connections/${connId}/helix-event-types/${uid}`),
    onSuccess: () => {
      setConfirming(null);
      qc.invalidateQueries({ queryKey: ["helix-event-types", connId] });
    },
  });
  const list = types.data ?? [];
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs uppercase tracking-wider text-slate-400">
          Event types ({list.length})
        </div>
        <button
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-white hover:border-white/30 disabled:opacity-40"
        >
          {sync.isPending ? "Syncing…" : "↻ Re-sync from Verkada"}
        </button>
      </div>
      {types.isLoading && (
        <div className="text-sm text-slate-500">Loading…</div>
      )}
      {!types.isLoading && list.length === 0 && (
        <div className="text-sm text-slate-500 italic px-3 py-6 text-center border border-dashed border-white/10 rounded">
          No event types yet. Click <strong className="text-slate-200">+ Create event type</strong> above to make one.
        </div>
      )}
      <ul className="divide-y divide-white/10">
        {list.map((et) => {
          const schema = (et.event_schema ?? {}) as Record<string, string>;
          const attrs = Object.entries(schema);
          return (
            <li
              key={et.id}
              onClick={() => onEdit(et)}
              className="py-3 cursor-pointer hover:bg-white/5 px-2 -mx-2 rounded transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-medium text-slate-100">
                  {et.name ?? "(unnamed)"}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <code className="text-[10px] font-mono text-slate-600">
                    {et.event_type_uid}
                  </code>
                  {confirming === et.event_type_uid ? (
                    <span
                      className="flex items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => del.mutate(et.event_type_uid)}
                        disabled={del.isPending}
                        className="text-[11px] px-2 py-0.5 rounded border border-rose-700/70 bg-rose-900/40 text-rose-200 hover:bg-rose-800/60 disabled:opacity-40"
                      >
                        {del.isPending ? "Deleting…" : "Delete for good"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="text-[11px] text-slate-400 hover:text-slate-200"
                      >
                        cancel
                      </button>
                    </span>
                  ) : (
                    // A text link the width of the word "Delete", sat
                    // beside a 36-character uid, is genuinely hard to
                    // find. A bordered icon button with a real hit area
                    // reads as a control at a glance without competing
                    // with the type name.
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirming(et.event_type_uid);
                      }}
                      aria-label={`Delete ${et.name ?? "event type"}`}
                      title="Delete this event type from Verkada"
                      className="grid h-7 w-7 place-items-center rounded-md border border-white/10 text-slate-400 opacity-70 transition-[opacity,color,border-color] duration-150 ease-out-strong hover:opacity-100 hover:border-rose-600/60 hover:text-rose-300"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.6 9a1 1 0 0 0 1 1h4.8a1 1 0 0 0 1-1L12 4M6.5 7v4M9.5 7v4" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              {confirming === et.event_type_uid && (
                <div
                  className="text-[11px] text-amber-300/90 mt-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  Deletes {et.name ?? "this type"} from Verkada. Any flow or
                  analytic posting to it will start failing, and events already
                  logged against it may go with it.
                </div>
              )}
              {del.isError && confirming === et.event_type_uid && (
                <div className="text-[11px] text-rose-300 mt-1">
                  {(del.error as Error).message}
                </div>
              )}
              {attrs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {attrs.map(([k, t]) => (
                    <span
                      key={k}
                      className="text-[11px] font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5"
                    >
                      <span className="text-slate-200">{k}</span>
                      <span className="text-slate-500">: {t}</span>
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      {children}
    </div>
  );
}
