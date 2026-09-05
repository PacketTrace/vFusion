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
import LiveDemoPanel from "../components/LiveDemoPanel";
import { useCameras } from "../lib/cameras";


/** What /api/helix-demo/compose returns: the event type an integration
 *  would write, and the specification for generating events against it.
 *  The model never returns rows -- see backend/app/helixdemo/generate.py
 *  for why a spec beats a list. */
interface ComposedDemo {
  name: string;
  summary: string;
  model: string;
  helix_event_type: { name: string; event_schema: Record<string, string> };
  spec: Record<string, unknown>;
  raw: unknown;
  sample: { attributes: Record<string, string>; at: string }[];
}

interface DemoTemplate {
  id: string;
  name: string;
  summary: string;
  helix_event_type: { name: string; event_schema: Record<string, string> };
  spec: Record<string, unknown>;
  sample: { attributes: Record<string, string>; at: string }[];
}

interface DemoRun {
  id: string;
  at: string;
  name: string;
  summary: string;
  camera_id: string;
  event_type_uid: string;
  count: number;
  window_days: number;
  timing: string;
  seed: number;
  posted: number;
  requested: number;
  spec: Record<string, unknown>;
}

interface SeedResult {
  posted: number;
  requested: number;
  seed: number;
  timing: string;
  anchored_to_detections: boolean;
  detections_note: string | null;
  first_at: string | null;
  last_at: string | null;
  errors: string[];
}


/** "Aug 28" — enough to place the window, short enough to sit in a line. */
function shortDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}


/**
 * Helix — event types, and demo data to fill a timeline with.
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
  // Two things live here now: the types themselves, and a way to fill
  // one with believable events so a customer can see Helix working
  // before the integration that would feed it exists.
  const [sub, setSub] = useState<"types" | "demo">("types");

  return (
    <div className="space-y-6">
      {/* Verkada's own framing, near enough to their words: Helix is an
          event search and integration feature in Command that connects
          third-party data to camera footage. One line, because the two
          tabs below say what you can do here and a second paragraph
          restating the first is just something to scroll past. */}
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold text-white">Helix</h1>
        <p className="text-slate-400 text-sm mt-1">
          Connects third-party data to camera footage, so you can find video by
          what happened rather than scrub for it. An event type is the shape
          that data arrives in.
        </p>
      </div>

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
          <div className="flex items-center gap-1 border-b border-white/10">
            {([
              ["types", "Event types"],
              ["demo", "Demo data"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSub(key)}
                className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                  sub === key
                    ? "border-sky-500 text-white"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
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
            {sub === "types" && (
              <button
                onClick={() => setCreating(true)}
                disabled={!connId}
                className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
              >
                + Create event type
              </button>
            )}
          </div>

          {connId && sub === "types" && (
            <EventTypeList
              connId={connId}
              onEdit={(et) => setEditing(et)}
            />
          )}
          {connId && sub === "demo" && <DemoPanel connId={connId} />}

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


/** Describe an integration, get a Helix type and a week of events.
 *
 *  Two steps rather than one button. Composing is cheap and reversible;
 *  seeding writes to a live Verkada org. Running them together would
 *  mean finding out the schema was wrong only after several hundred rows
 *  had landed on it.
 */
function DemoPanel({ connId }: { connId: string }) {
  const qc = useQueryClient();
  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const cameras = useCameras();
  const types = useQuery({
    queryKey: ["helix-event-types", connId],
    queryFn: () =>
      apiGet<HelixEventType[]>(`/api/connections/${connId}/helix-event-types`),
    enabled: !!connId,
  });
  const geminiConns = (conns.data ?? []).filter(
    (c) => c.type === "gemini" && c.setup_complete,
  );

  const [intent, setIntent] = useState("");
  const [geminiId, setGeminiId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [count, setCount] = useState(60);
  const [windowDays, setWindowDays] = useState(7);
  const [timing, setTiming] = useState<"business" | "random" | "detections">(
    "business",
  );
  const [draft, setDraft] = useState<ComposedDemo | null>(null);
  // Names for the result message. Both lists are already loaded for the
  // pickers, so there is nothing to fetch.
  const allCameras = cameras.data ?? [];
  const onlineCameras = allCameras.filter(
    (c) => (c.status ?? "").toLowerCase() !== "offline",
  );
  const offlineCount = allCameras.length - onlineCameras.length;
  const cameraName =
    allCameras.find((c) => c.camera_id === cameraId)?.name || "this camera";
  const [typeUid, setTypeUid] = useState("");
  // The name is editable before it is created. The model picks a good
  // one often enough to keep, and not often enough to be stuck with.
  const [typeName, setTypeName] = useState("");
  const [refinement, setRefinement] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!geminiId && geminiConns.length > 0 && geminiConns[0]) {
    setGeminiId(geminiConns[0].id);
  }

  const compose = useMutation({
    mutationFn: (note: string) =>
      apiPost<ComposedDemo>("/api/helix-demo/compose", {
        gemini_connection_id: geminiId,
        intent,
        // Only on a second pass. The model is told to keep everything
        // the note did not mention, so refining the product pool does
        // not also rename the type.
        previous: note ? draft : null,
        refinement: note,
      }),
    onSuccess: (d) => {
      setErr(null);
      setDraft(d);
      setTypeName(d.helix_event_type.name);
      setRefinement("");
      // If a type with this name already exists, seed into it rather
      // than making a near-duplicate the customer then has to tell
      // apart in Command.
      const match = (types.data ?? []).find(
        (t) => (t.name ?? "").trim() === d.helix_event_type.name.trim(),
      );
      setTypeUid(match?.event_type_uid ?? "");
    },
    onError: (e: Error) => setErr(e.message),
  });

  const createType = useMutation({
    mutationFn: () =>
      apiPost<HelixEventType>(`/api/connections/${connId}/helix-event-types`, {
        name: typeName.trim() || draft!.helix_event_type.name,
        event_schema: draft!.helix_event_type.event_schema,
      }),
    onSuccess: (row) => {
      setTypeUid(row.event_type_uid);
      qc.invalidateQueries({ queryKey: ["helix-event-types", connId] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const seed = useMutation({
    mutationFn: () =>
      apiPost<SeedResult>("/api/helix-demo/seed", {
        connection_id: connId,
        camera_id: cameraId,
        event_type_uid: typeUid,
        spec: draft!.spec,
        count,
        window_days: windowDays,
        timing,
        name: draft?.name ?? typeName,
        summary: draft?.summary ?? "",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["helix-demo-history"] }),
    onError: (e: Error) => setErr(e.message),
  });

  const demoTemplates = useQuery({
    queryKey: ["helix-demo-templates"],
    queryFn: () => apiGet<DemoTemplate[]>("/api/helix-demo/templates"),
  });
  const runs = useQuery({
    queryKey: ["helix-demo-history"],
    queryFn: () => apiGet<DemoRun[]>("/api/helix-demo/history"),
  });
  const forget = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/helix-demo/history/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["helix-demo-history"] }),
  });
  // Re-runs post *fresh* events: no seed is sent, so the generator picks
  // a new one. Repeating a seed exactly would duplicate the timeline
  // rather than replace it — vFusion keeps no record of what it posted
  // and could not clean up after itself.
  const rerun = useMutation({
    mutationFn: (r: DemoRun) =>
      apiPost<SeedResult>("/api/helix-demo/seed", {
        connection_id: connId,
        camera_id: r.camera_id,
        event_type_uid: r.event_type_uid,
        spec: r.spec,
        count: r.count,
        window_days: r.window_days,
        timing: r.timing,
        name: r.name,
        summary: r.summary,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["helix-demo-history"] }),
    onError: (e: Error) => setErr(e.message),
  });

  /** Put a past design back in the panel so the adjust box works on it.
   *  The schema and samples are not stored — only the spec, which is
   *  what a refinement actually edits — so this restores enough to
   *  describe a change and recompose, not a full replay of the draft. */
  function loadForAdjust(r: DemoRun) {
    setDraft({
      name: r.name,
      summary: r.summary,
      helix_event_type: { name: r.name, event_schema: {} },
      spec: r.spec,
      model: "",
      raw: {},
      sample: [],
    } as unknown as ComposedDemo);
    setTypeName(r.name);
    setTypeUid(r.event_type_uid);
    setCameraId(r.camera_id);
    setCount(r.count);
    setWindowDays(r.window_days);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // The name of the type actually posted to, which is not always the
  // editable draft name above -- an existing type can be picked instead.
  const postedType =
    (types.data ?? []).find((t) => t.event_type_uid === typeUid)?.name || "";
  // "Aug 28 - Sep 4", or one day if the window collapsed to one.
  const from = shortDay(seed.data?.first_at ?? null);
  const to = shortDay(seed.data?.last_at ?? null);
  const span =
    from && to ? (from === to ? from : from + " – " + to) : "";

  const attrs = draft ? Object.keys(draft.helix_event_type.event_schema) : [];

  return (
    <div className="space-y-4">
      <Card>
        <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">
          Describe the integration
        </div>
        <p className="text-[11px] text-slate-500 mb-3">
          What system would be writing to Helix if it were connected? vFusion
          designs the event type it would use and fills a camera's timeline
          with believable events, so the value is visible before anyone builds
          the integration.
        </p>
        {(demoTemplates.data ?? []).length > 0 && !draft && (
          <div className="mb-3">
            <div className="text-[11px] text-slate-400 mb-1.5">
              Or start from one of these — no model call, loads instantly:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(demoTemplates.data ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  title={t.summary}
                  onClick={() => {
                    setErr(null);
                    setIntent(t.summary);
                    setDraft({
                      name: t.name,
                      summary: t.summary,
                      helix_event_type: t.helix_event_type,
                      spec: t.spec,
                      model: "template",
                      raw: {},
                      sample: t.sample,
                    } as unknown as ComposedDemo);
                    setTypeName(t.helix_event_type.name);
                    // Reuse an existing type of the same name rather
                    // than making a near-duplicate to tell apart later.
                    const match = (types.data ?? []).find(
                      (x) =>
                        (x.name ?? "").trim() ===
                        t.helix_event_type.name.trim(),
                    );
                    setTypeUid(match?.event_type_uid ?? "");
                  }}
                  className="text-[11px] px-2 py-1 rounded border border-white/15 text-slate-300 hover:border-sky-600 hover:text-white"
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          rows={3}
          placeholder="e.g. our point-of-sale system — items bought, total, discount code, register number"
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm placeholder:text-slate-500 placeholder:italic"
        />
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <select
            value={geminiId}
            onChange={(e) => setGeminiId(e.target.value)}
            className="px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs"
          >
            {geminiConns.length === 0 && <option value="">no Gemini key</option>}
            {geminiConns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => compose.mutate("")}
            disabled={!intent.trim() || !geminiId || compose.isPending}
            className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {compose.isPending ? "Designing…" : "Design it"}
          </button>
          <span className="text-[11px] text-slate-500">
            Nothing is written to Verkada yet.
          </span>
        </div>
      </Card>

      {err && (
        <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
          {err}
        </div>
      )}

      {draft && (
        <Card>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <div className="text-sm font-medium text-slate-100">
                {draft.helix_event_type.name}
              </div>
              <div className="text-[11px] text-slate-400">{draft.summary}</div>
            </div>
            <span className="text-[10px] text-slate-600">
              written by {draft.model}
            </span>
          </div>

          {/* Rows from the real generator, not a description of it. Five
              is enough to judge whether the numbers agree with each
              other and whether the values sound like a real business. */}
          <div className="mt-3 border border-white/10 rounded overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-white/5 text-slate-400">
                <tr>
                  {attrs.map((a) => (
                    <th key={a} className="text-left px-2 py-1 font-medium">
                      {a}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 font-mono text-slate-300">
                {draft.sample.map((row, i) => (
                  <tr key={i}>
                    {attrs.map((a) => (
                      <td
                        key={a}
                        title={row.attributes[a]}
                        className="px-2 py-1 max-w-[22rem] truncate"
                      >
                        {row.attributes[a] || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-slate-500 mt-1">
            A sample from the same generator that will fill the timeline.
          </p>

          {/* Refining beats starting over. The first answer is usually
              right in shape and wrong in flavour — groceries when the
              customer sells timber — and re-describing the whole thing
              to fix that loses the parts that were already right. */}
          <div className="flex flex-wrap gap-2 mt-3">
            <input
              value={refinement}
              onChange={(e) => setRefinement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && refinement.trim()) {
                  compose.mutate(refinement.trim());
                }
              }}
              placeholder="not quite? e.g. these should be hardware store items"
              className="flex-1 min-w-[18rem] px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs placeholder:text-slate-500 placeholder:italic"
            />
            <button
              type="button"
              onClick={() => compose.mutate(refinement.trim())}
              disabled={!refinement.trim() || compose.isPending}
              className="text-xs px-3 py-1.5 rounded border border-white/15 text-slate-200 hover:bg-white/10 disabled:opacity-40"
            >
              {compose.isPending ? "Adjusting…" : "Adjust it"}
            </button>
          </div>

          <details className="mt-2">
            <summary className="text-[10px] text-slate-600 hover:text-slate-400 cursor-pointer">
              raw model output
            </summary>
            <pre className="mt-1 text-[10px] font-mono text-slate-500 bg-black/40 border border-white/10 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(draft.raw, null, 2)}
            </pre>
          </details>
        </Card>
      )}

      {draft && (
        <Card>
          <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-3">
            Fill a timeline
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">Camera</div>
              <select
                value={cameraId}
                onChange={(e) => setCameraId(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                <option value="">— pick a camera —</option>
                {onlineCameras.map((c) => (
                  <option key={c.camera_id} value={c.camera_id}>
                    {c.name ?? c.camera_id}
                  </option>
                ))}
              </select>
              {offlineCount > 0 && (
                <div className="text-[11px] text-slate-500 mt-1">
                  {offlineCount} offline{" "}
                  {offlineCount === 1 ? "camera is" : "cameras are"} hidden —
                  there would be no footage under the events.
                </div>
              )}
              {allCameras.length > 0 && onlineCameras.length === 0 && (
                <div className="text-[11px] text-amber-300 mt-1">
                  Every known camera is offline. Sync cameras on the
                  Connections page if that looks wrong.
                </div>
              )}
            </label>
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">Event type</div>
              <select
                value={typeUid}
                onChange={(e) => setTypeUid(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                <option value="">— not created yet —</option>
                {(types.data ?? []).map((t) => (
                  <option key={t.event_type_uid} value={t.event_type_uid}>
                    {t.name ?? t.event_type_uid}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!typeUid && (
            <div className="flex flex-wrap items-end gap-2 mt-2">
              <label className="flex-1 min-w-[16rem]">
                <div className="text-xs text-slate-300 mb-1">
                  Name it before creating
                </div>
                <input
                  value={typeName}
                  onChange={(e) => setTypeName(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                />
              </label>
              <button
                type="button"
                onClick={() => createType.mutate()}
                disabled={createType.isPending || !typeName.trim()}
                className="text-sm px-3 py-1.5 rounded border border-emerald-700/60 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-800/60 disabled:opacity-40"
              >
                {createType.isPending ? "Creating…" : "Create on this org"}
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">How many</div>
              <input
                type="number"
                min={1}
                max={500}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              />
            </label>
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">Over the last</div>
              <select
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                <option value={1}>day</option>
                <option value={3}>3 days</option>
                <option value={7}>week</option>
                <option value={14}>2 weeks</option>
                <option value={30}>30 days</option>
              </select>
            </label>
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">When</div>
              <select
                value={timing}
                onChange={(e) =>
                  setTiming(e.target.value as "business" | "random" | "detections")
                }
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                <option value="business">Business hours, with peaks</option>
                <option value="detections">When the camera saw someone</option>
                <option value="random">Spread at random</option>
              </select>
            </label>
          </div>
          <p className="text-[10px] text-slate-500 mt-1">
            {timing === "detections"
              ? "Stamps each event at a moment this camera really detected a person or vehicle, so clicking one in Command shows footage of something happening. Falls back to business hours if the camera has no detection history."
              : timing === "business"
                ? "Shaped by hour with a lunch and evening peak. A timeline as busy at 4am as at noon is the first thing that gives invented data away."
                : "Evenly scattered across the window. Honest, and obviously synthetic."}
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-4">
            <button
              type="button"
              onClick={() => seed.mutate()}
              disabled={!cameraId || !typeUid || seed.isPending}
              className="text-sm px-4 py-2 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
            >
              {seed.isPending
                ? "Posting…"
                : seed.data
                  ? "Run it again with fresh data"
                  : "Fill the timeline"}
            </button>
          </div>
          {seed.data && seed.data.posted > 0 && (
            <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="text-sm text-emerald-200">
                {seed.data.posted.toLocaleString()}{" "}
                {postedType ? <b>{postedType}</b> : "demo"} events are now on{" "}
                <b>{cameraName}</b>&rsquo;s timeline.
              </div>
              <div className="mt-1.5 text-xs text-slate-400">
                {span ? `Spread across ${span}` : "Spread across the window"}
                {seed.data.anchored_to_detections
                  ? ", each one stamped at a moment the camera really saw a person or a vehicle"
                  : ", shaped like a working day rather than scattered evenly"}
                .
              </div>
              <div className="mt-2 text-xs text-slate-400">
                Open <b>{cameraName}</b> in Command and scrub the timeline, or
                search Helix for this event type. Run it again for a different
                set — nothing here overwrites what you just posted.
              </div>
              {seed.data.timing !== timing && seed.data.detections_note && (
                <div className="mt-2 text-xs text-amber-300">
                  {seed.data.detections_note} Business hours were used instead.
                </div>
              )}
              {seed.data.posted < seed.data.requested && (
                <div className="mt-2 text-xs text-amber-300">
                  {(seed.data.requested - seed.data.posted).toLocaleString()} of{" "}
                  {seed.data.requested.toLocaleString()} did not post.
                  {seed.data.errors[0] ? ` ${seed.data.errors[0]}` : ""}
                </div>
              )}
            </div>
          )}
          {seed.data && seed.data.posted === 0 && (
            <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-200">
              Nothing posted. {seed.data.errors[0] ?? "The API rejected it."}
            </div>
          )}
        </Card>
      )}

      {draft && typeUid && cameraId && (
        <LiveDemoPanel
          connId={connId}
          cameraId={cameraId}
          eventTypeUid={typeUid}
          spec={(draft.spec ?? null) as Record<string, unknown> | null}
        />
      )}

      {(runs.data ?? []).length > 0 && (
        <Card>
          <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">
            Past runs
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Running again posts a fresh set with the same shape — different
            values, different timings. Nothing is removed: vFusion keeps no
            record of the events it posted, so a second run adds to the
            timeline rather than replacing it.
          </p>
          <div className="space-y-2">
            {(runs.data ?? []).map((r) => (
              <div
                key={r.id}
                className="rounded border border-white/10 bg-white/5 p-2.5 flex items-start justify-between gap-3 flex-wrap"
              >
                <div className="min-w-0">
                  <div className="text-sm text-slate-100">{r.name}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {r.posted.toLocaleString()} events on{" "}
                    {allCameras.find((c) => c.camera_id === r.camera_id)?.name ??
                      "a camera"}{" "}
                    &middot; {r.window_days}d window &middot;{" "}
                    {new Date(r.at).toLocaleString()}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => rerun.mutate(r)}
                    disabled={rerun.isPending}
                    className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
                  >
                    {rerun.isPending ? "Posting…" : "Run again"}
                  </button>
                  <button
                    type="button"
                    onClick={() => loadForAdjust(r)}
                    title="Load this design so you can describe a change to it"
                    className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 text-slate-200"
                  >
                    Adjust
                  </button>
                  <button
                    type="button"
                    onClick={() => forget.mutate(r.id)}
                    title="Forget this run. The events it posted stay."
                    className="text-xs px-2 py-1.5 rounded border border-white/15 text-slate-500 hover:text-rose-300"
                  >
                    &times;
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
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
