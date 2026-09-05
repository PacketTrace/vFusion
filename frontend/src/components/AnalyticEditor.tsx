import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPost, BuiltinAnalytic, SavedAnalytic } from "../lib/api";

/**
 * Edit an analytic where it lives, instead of navigating to the bench.
 *
 * "Open in Build" sent you to a different page to change a name or a
 * line of prompt, which meant leaving the list you were working through
 * and finding your way back. Everything an analytic *is* — the name, the
 * summary, the prompt, and the Helix type it writes into — is editable
 * here.
 *
 * What is not here is running it. That needs a camera, a Gemini key and
 * a live call, which is the bench's whole job; the modal links across
 * for it rather than growing a second copy.
 *
 * Built-ins open in the same editor and save as a copy. They live in
 * code, so there is nothing to update — but "edit this and keep it" is
 * exactly what people want from one, and refusing would mean retyping a
 * prompt to change a word.
 */

interface Props {
  // Exactly one of these. A saved analytic updates in place; a built-in
  // becomes a new one on save.
  analytic?: SavedAnalytic;
  builtin?: BuiltinAnalytic;
  onClose: () => void;
  onOpenInBuild: () => void;
}

export default function AnalyticEditor({
  analytic,
  builtin,
  onClose,
  onOpenInBuild,
}: Props) {
  const qc = useQueryClient();
  const isCopy = !analytic;

  const [name, setName] = useState(analytic?.name ?? builtin?.name ?? "");
  const [summary, setSummary] = useState(analytic?.summary ?? "");
  const [prompt, setPrompt] = useState(analytic?.prompt ?? builtin?.value ?? "");
  const [mapping, setMapping] = useState<Record<string, string>>(
    analytic?.helix_attribute_mapping ??
      builtin?.helix_attribute_mapping ??
      {},
  );
  const [err, setErr] = useState<string | null>(null);

  const helix = analytic?.helix_event_type ?? null;
  const builtinHelixName = builtin?.helix_event_type?.name ?? null;

  const save = useMutation({
    mutationFn: () =>
      apiPost<SavedAnalytic>("/api/byoa/analytics", {
        // Present for an edit, absent for a copy — the backend upserts
        // on id, so omitting it is what makes a built-in fork rather
        // than fail.
        id: analytic?.id,
        name: name.trim(),
        summary: summary.trim(),
        prompt,
        helix_event_type: analytic?.helix_event_type ?? builtin?.helix_event_type,
        helix_attribute_mapping: mapping,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["byoa-analytics"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const attributes = Object.keys(
    helix?.event_schema ?? {},
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="w-[min(52rem,100%)] rounded-xl border border-white/15 bg-[#0b0f14] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg font-semibold text-white">
              {isCopy ? "Edit a copy" : "Edit analytic"}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isCopy
                ? "This one ships with vFusion, so saving keeps your version alongside it rather than changing it."
                : "Changes apply to this analytic. Flows already using it keep their own copy of the prompt."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-white/10 shrink-0"
          >
            Close
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">Name</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              />
            </label>
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">
                Summary <span className="text-slate-600">optional</span>
              </div>
              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="One line, so you can tell two similar ones apart"
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              />
            </label>
          </div>

          <label className="block">
            <div className="text-xs text-slate-300 mb-1">
              Prompt{" "}
              <span className="text-slate-600">
                — the analytic is the prompt
              </span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={14}
              spellCheck={false}
              className="w-full px-3 py-2 rounded bg-black/30 border border-white/15 text-xs font-mono resize-y leading-relaxed"
            />
          </label>

          {(helix || builtinHelixName) && (
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">
                Writes into
              </div>
              <div className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60 inline-block">
                🧬 {helix?.name ?? builtinHelixName}
              </div>
              {attributes.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <div className="text-[11px] text-slate-500">
                    Which part of the model&rsquo;s answer fills each attribute.
                  </div>
                  {attributes.map((attr) => (
                    <div key={attr} className="flex items-center gap-2">
                      <span className="text-xs text-slate-300 w-40 shrink-0 truncate">
                        {attr}
                      </span>
                      <input
                        value={mapping[attr] ?? ""}
                        onChange={(e) =>
                          setMapping({ ...mapping, [attr]: e.target.value })
                        }
                        placeholder="{{ output.json.field }}"
                        className="flex-1 px-2 py-1 rounded bg-white/5 border border-white/15 text-[11px] font-mono"
                      />
                    </div>
                  ))}
                </div>
              )}
              {/* The pairing itself is chosen when the analytic is
                  composed. Changing which Helix type it writes into is
                  a different decision from editing the prompt, and doing
                  it here would let a mapping outlive the schema it was
                  written against. */}
              <p className="text-[11px] text-slate-500 mt-2">
                To point this at a different Helix type, compose it again on the
                bench.
              </p>
            </div>
          )}

          {err && <div className="text-sm text-rose-300">{err}</div>}
        </div>

        <div className="flex items-center gap-3 flex-wrap px-5 py-3 border-t border-white/10">
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!name.trim() || !prompt.trim() || save.isPending}
            className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white text-sm disabled:opacity-40"
          >
            {save.isPending
              ? "Saving…"
              : isCopy
                ? "Save as mine"
                : "Save changes"}
          </button>
          <button
            type="button"
            onClick={onOpenInBuild}
            className="px-3 py-2 rounded bg-white/10 hover:bg-white/15 text-slate-200 text-sm"
          >
            Test it on the bench
          </button>
          <span className="text-[11px] text-slate-500">
            Running it needs a camera and a Gemini key, which is what the bench
            is for.
          </span>
        </div>
      </div>
    </div>
  );
}
