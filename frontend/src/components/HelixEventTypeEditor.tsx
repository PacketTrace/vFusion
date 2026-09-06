import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  Connection,
  HelixEventType,
} from "../lib/api";


export type AttrType = "string" | "integer" | "float";


interface AttrRow {
  key: string;
  type: AttrType;
}


/**
 * Modal form for creating or editing a Verkada Helix event type.
 *
 * Two consumers:
 *
 *   1. **Helix page** — the dedicated "manage Helix types" UI on the
 *      Workbench. Used for both create + edit.
 *   2. **StepConfigForm's helix_event_ref field** — when the operator
 *      is configuring a ``verkada_helix_event`` step and the type they
 *      want doesn't exist yet, a "+ New type" button next to the
 *      dropdown opens this in ``create`` mode so they can land back
 *      with a brand-new type selected without leaving the flow editor.
 *
 * On success, the editor invalidates the ``helix-event-types`` query
 * for the connection so any consumer's dropdown picks up the change.
 * Pass ``onCreated(newType)`` if you want to react beyond the auto
 * cache invalidation (e.g. auto-select the new type in a picker).
 */
export default function HelixEventTypeEditor({
  connId,
  mode,
  existing,
  seed,
  triggerSummary,
  onClose,
  onCreated,
}: {
  connId: string;
  mode: "create" | "edit";
  existing?: HelixEventType;
  /**
   * Pre-fill values for ``create`` mode — used by paired-prompt flows
   * (BYOA, action editor) where the prompt knows what Helix type it
   * pairs with, so the operator clicks once and lands on a form
   * with name + attributes already populated. Ignored in ``edit`` mode
   * (the existing row's fields take precedence).
   */
  seed?: { name?: string | null; event_schema?: Record<string, string> | null };
  /**
   * What the surrounding flow starts on, in operator words — e.g.
   * "Access / Door Event · door_opened". Passed to the drafting
   * assistant so it suggests attributes the trigger can actually fill,
   * rather than fields nobody has a source for.
   */
  triggerSummary?: string | null;
  onClose: () => void;
  onCreated?: (created: HelixEventType) => void;
}) {
  const qc = useQueryClient();
  const initialName = existing?.name ?? (mode === "create" ? seed?.name ?? "" : "");
  const initialSchema =
    existing?.event_schema ??
    (mode === "create" ? seed?.event_schema ?? null : null);
  const [name, setName] = useState<string>(initialName ?? "");
  const [attrs, setAttrs] = useState<AttrRow[]>(() => {
    if (initialSchema) {
      return Object.entries(initialSchema).map(([k, t]) => ({
        key: k,
        type: normalizeType(String(t)),
      }));
    }
    return [{ key: "", type: "string" }];
  });
  // How many attributes arrived pre-filled, so the form can say so
  // rather than looking like the operator typed them.
  const seededCount = Object.keys(
    (mode === "create" ? seed?.event_schema : null) ?? {},
  ).length;
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Name is required");
      const event_schema: Record<string, string> = {};
      for (const a of attrs) {
        const k = a.key.trim();
        if (!k) continue;
        if (event_schema[k]) throw new Error(`duplicate attribute name: ${k}`);
        event_schema[k] = a.type;
      }
      if (Object.keys(event_schema).length === 0) {
        throw new Error("Add at least one attribute");
      }
      if (mode === "create") {
        return apiPost<HelixEventType>(
          `/api/connections/${connId}/helix-event-types`,
          { name: trimmedName, event_schema },
        );
      }
      return apiPut<HelixEventType>(
        `/api/connections/${connId}/helix-event-types/${existing!.event_type_uid}`,
        { name: trimmedName, event_schema },
      );
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["helix-event-types", connId] });
      if (mode === "create" && onCreated) onCreated(row);
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  // Deleting from the editor, not only from the row behind it. If you
  // have opened a type and decided it is wrong, closing the dialog to
  // hunt for a bin icon in the list is a detour past the screen that
  // already knows which type you mean.
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () =>
      apiDelete(
        `/api/connections/${connId}/helix-event-types/${existing!.event_type_uid}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["helix-event-types", connId] });
      onClose();
    },
    onError: (e: Error) => {
      setConfirming(false);
      setErr(e.message);
    },
  });

  // Drafting assistant. This form is the hardest moment in building a
  // flow by hand: an empty attribute row tells you nothing about what a
  // good attribute is, how many to have, or that Helix truncates a long
  // value — and the cost of guessing wrong is a type that already has
  // events posted against it.
  const [intent, setIntent] = useState("");
  // Opened by default when the flow has already told us what it is for.
  // Making somebody click into an assistant, on a form the surrounding
  // flow could have filled, is the gap being closed here.
  const [assistOpen, setAssistOpen] = useState(
    mode === "create" && !!triggerSummary,
  );
  const [assistErr, setAssistErr] = useState<string | null>(null);
  const [assistCost, setAssistCost] = useState<number | null>(null);
  const [whys, setWhys] = useState<Record<string, string>>({});

  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
    enabled: assistOpen,
  });
  const geminiConn = (connections.data ?? []).find(
    (c) => c.type === "gemini" && c.setup_complete,
  );

  const draft = useMutation({
    mutationFn: () =>
      apiPost<{
        name: string;
        attributes: { key: string; type: AttrType; why?: string | null }[];
        cost_usd: number | null;
      }>("/api/helix-assist", {
        intent,
        gemini_connection_id: geminiConn?.id,
        trigger_summary: triggerSummary ?? null,
      }),
    onSuccess: (res) => {
      setAssistErr(null);
      setAssistCost(res.cost_usd);
      // Replaces rather than appends. A draft is a coherent set — mixing
      // it into whatever half-typed rows were already there produces a
      // type that is neither what you started nor what was suggested.
      setName(res.name);
      setAttrs(res.attributes.map((a) => ({ key: a.key, type: a.type })));
      setWhys(
        Object.fromEntries(
          res.attributes.filter((a) => a.why).map((a) => [a.key, a.why!]),
        ),
      );
    },
    onError: (e: Error) => setAssistErr(e.message),
  });

  const setAttr = (i: number, patch: Partial<AttrRow>) => {
    setAttrs((cur) => cur.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  };
  const removeAttr = (i: number) => {
    setAttrs((cur) => cur.filter((_, idx) => idx !== i));
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-white/15 rounded-xl w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {mode === "create" ? "Create event type" : "Edit event type"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-2 py-1 rounded text-slate-400 hover:text-slate-200"
          >
            Close
          </button>
        </div>

        {mode === "edit" && existing?.event_type_uid && (
          <div className="px-5 pt-3 flex items-center gap-2">
            <span className="text-[11px] text-slate-500 shrink-0">
              Event type uid
            </span>
            <code className="text-[11px] font-mono text-slate-400 truncate">
              {existing.event_type_uid}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(existing.event_type_uid);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="ml-auto text-[11px] px-2 py-0.5 rounded border border-white/15 text-slate-400 hover:text-slate-200 shrink-0"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {mode === "create" && (
            <div className="rounded-lg border border-violet-400/25 bg-violet-500/10">
              {!assistOpen ? (
                <button
                  type="button"
                  onClick={() => setAssistOpen(true)}
                  className="w-full text-left px-3 py-2.5 flex items-center gap-2 text-sm text-violet-100 hover:bg-violet-500/10 rounded-lg transition-[background-color] duration-150 ease-out-strong"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="w-3.5 h-3.5 fill-violet-300 shrink-0">
                    <path d="M12 2.5l1.9 5.1 5.1 1.9-5.1 1.9L12 16.5l-1.9-5.1L5 9.5l5.1-1.9L12 2.5z" />
                    <path d="M18.5 15l.85 2.15L21.5 18l-2.15.85L18.5 21l-.85-2.15L15.5 18l2.15-.85L18.5 15z" />
                  </svg>
                  {seededCount > 0 ? "Name it with AI" : "Draft it from a description"}
                  <span className="text-violet-300/70 text-xs ml-auto">
                    {seededCount > 0
                      ? "attributes already filled in"
                      : "describe what to log"}
                  </span>
                </button>
              ) : (
                <div className="p-3 space-y-2">
                  {/* What it already knows, shown rather than implied.
                      Otherwise the box looks blank and the draft looks
                      like a guess, when it is reading the flow. */}
                  {triggerSummary && (
                    <details className="text-[11px] text-slate-400">
                      <summary className="cursor-pointer hover:text-slate-200 select-none">
                        Reading {triggerSummary.split("\n").length} thing
                        {triggerSummary.split("\n").length === 1 ? "" : "s"} from
                        this flow
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap text-slate-500 font-mono text-[10.5px] max-h-32 overflow-auto">
                        {triggerSummary}
                      </pre>
                    </details>
                  )}
                  <textarea
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    rows={2}
                    autoFocus
                    placeholder={
                      triggerSummary
                        ? "Optional — anything the flow above doesn't already say"
                        : "e.g. log who opened the garage door and whether a vehicle was there"
                    }
                    className="w-full px-2.5 py-2 rounded bg-black/30 border border-white/15 text-sm placeholder:text-slate-500 focus:outline-none focus:border-violet-400/60"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={
                        (!intent.trim() && !triggerSummary) ||
                        draft.isPending ||
                        !geminiConn
                      }
                      onClick={() => draft.mutate()}
                      className="text-sm px-3 py-1.5 rounded-md bg-violet-500/25 hover:bg-violet-500/35 border border-violet-400/40 text-violet-100 disabled:opacity-40"
                    >
                      {draft.isPending ? "Drafting…" : "Draft it"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAssistOpen(false)}
                      className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1"
                    >
                      Cancel
                    </button>
                    {assistCost !== null && (
                      <span className="text-[11px] text-slate-500 ml-auto tabular-nums">
                        ~${assistCost.toFixed(4)}
                      </span>
                    )}
                  </div>
                  {/* Said before the button is pressed, not after it
                      fails: the assistant needs a Gemini key and the
                      rest of this form does not. */}
                  {connections.data && !geminiConn && (
                    <div className="text-[11px] text-amber-300/90">
                      Needs a Gemini connection — add one on Connections. You
                      can still fill this in by hand.
                    </div>
                  )}
                  {assistErr && (
                    <div className="text-[11px] text-rose-300">{assistErr}</div>
                  )}
                  <div className="text-[11px] text-slate-500">
                    It fills the name and attributes below. Nothing is created
                    on Verkada until you press Create.
                  </div>
                </div>
              )}
            </div>
          )}

          <label className="block">
            <div className="text-xs font-medium text-slate-300 mb-1">
              Name <span className="text-rose-400">*</span>
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Forklift movement detected"
              className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600"
            />
          </label>

          <div>
            <div className="text-xs font-medium text-slate-300 mb-2">
              Attributes <span className="text-rose-400">*</span>
            </div>
            {mode === "create" && seededCount > 0 ? (
              <div className="text-[11px] text-emerald-300/90 mb-3">
                Filled in from the step below — these are the {seededCount}{" "}
                attribute{seededCount === 1 ? "" : "s"} it is already
                configured to send. Names have to match exactly, so they are
                copied as written; Helix rejects a key the type does not
                declare.
              </div>
            ) : (
              <div className="text-[11px] text-slate-500 mb-3">
                Each attribute becomes a typed field on events posted against
                this type. Pick a name and the data type. For example, an event
                for "person detected" might have{" "}
                <code className="font-mono">person_name</code> (string) and{" "}
                <code className="font-mono">confidence</code> (float).
              </div>
            )}
            <div className="space-y-2">
              {attrs.map((a, i) => (
                <div key={i}>
                <div className="flex gap-2 items-center">
                  <input
                    value={a.key}
                    onChange={(e) => setAttr(i, { key: e.target.value })}
                    placeholder="attribute_name"
                    className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
                  />
                  <select
                    value={a.type}
                    onChange={(e) =>
                      setAttr(i, { type: e.target.value as AttrType })
                    }
                    className="px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  >
                    <option value="string">string</option>
                    <option value="integer">integer</option>
                    <option value="float">float</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => removeAttr(i)}
                    disabled={attrs.length === 1}
                    className="text-xs px-2 py-1 rounded border border-white/15 text-slate-400 hover:text-rose-300 hover:border-rose-800 disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
                {/* What the draft said this field is for. Keyed by the
                    attribute name so renaming a field drops its note
                    rather than leaving a caption describing something
                    else. */}
                {whys[a.key] && (
                  <div className="text-[11px] text-slate-500 mt-1 ml-1">
                    {whys[a.key]}
                  </div>
                )}
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setAttrs((cur) => [...cur, { key: "", type: "string" }])
                }
                className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-white hover:border-white/30"
              >
                + Add attribute
              </button>
            </div>
          </div>

          {mode === "edit" && (
            <div className="text-[11px] text-amber-300/90 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2">
              ⚠ Changing the schema of a type that already has events posted
              against it can break downstream tools that read those events.
              Adding new fields is safe; renaming or removing fields is not.
            </div>
          )}

          {err && (
            <div className="text-sm text-rose-300 bg-rose-950/40 border border-rose-900/50 rounded px-3 py-2">
              {err}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex items-center gap-2">
          {mode === "edit" && existing && (
            <div className="mr-auto flex items-center gap-2">
              {confirming ? (
                <>
                  <span className="text-[11px] text-rose-300">
                    Delete "{existing.name ?? "this type"}" from Verkada?
                    Events already posted against it stay.
                  </span>
                  <button
                    type="button"
                    onClick={() => remove.mutate()}
                    disabled={remove.isPending}
                    className="text-sm px-3 py-1.5 rounded bg-rose-800 hover:bg-rose-700 text-white disabled:opacity-40"
                  >
                    {remove.isPending ? "Deleting…" : "Delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="text-[11px] text-slate-400 hover:text-slate-200"
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  // Red before it is hovered, not after. A destructive
                  // action that looks like every other button until the
                  // pointer is already on it has told you nothing at the
                  // moment the telling was useful.
                  className="text-sm px-3 py-1.5 rounded border border-rose-800/70 text-rose-300 hover:bg-rose-950/40 hover:border-rose-700"
                >
                  Delete
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded border border-white/15 text-slate-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {save.isPending
              ? "Saving…"
              : mode === "create"
                ? "Create"
                : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}


function normalizeType(t: string): AttrType {
  const lower = t.toLowerCase();
  if (lower === "integer" || lower === "int") return "integer";
  if (lower === "float" || lower === "number" || lower === "double")
    return "float";
  return "string";
}
