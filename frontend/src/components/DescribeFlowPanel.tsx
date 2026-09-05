import { useRef, useState } from "react";

import { API_BASE } from "../lib/api";

/**
 * Describe a flow and watch it appear on the canvas.
 *
 * The builder used to draft into a preview you then installed, which
 * meant reading a proposal, deciding, and landing in a different place
 * to actually work. Drafting straight into the editor removes the middle
 * step: what you get is the flow, in the tool you edit flows with, and
 * nothing is saved until you press Save — the same promise the editor
 * already makes about everything else on the canvas.
 *
 * The stages are shown as they stream rather than hidden behind a
 * spinner. It grounds itself, drafts, validates, and sometimes catches
 * its own mistake and fixes it; watching that happen is more
 * trustworthy than a pause followed by an answer.
 */

interface Stage {
  stage: string;
  detail?: string;
  result?: unknown;
}

const EXAMPLES = [
  "Every morning at 8, check whether the garage doorway is blocked",
  "When a person is seen at the front door after 10pm, describe what they're doing",
  "When a vehicle is detected in the driveway, log the plate to Helix",
];

export default function DescribeFlowPanel({
  onDraft,
  onDismiss,
}: {
  // Handed the proposal's template. The editor decides what to do with
  // it — this panel never touches flow state itself.
  onDraft: (template: Record<string, unknown>) => void;
  onDismiss: () => void;
}) {
  const [intent, setIntent] = useState("");
  const [runMode, setRunMode] = useState<"webhook" | "schedule" | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function run(text: string) {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    setError(null);
    setStages([]);
    try {
      const res = await fetch(`${API_BASE}/api/flow-builder/propose`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: text, run_mode: runMode }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let detail = `Draft failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.detail) detail = j.detail;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        // The trailing partial line stays buffered for the next chunk.
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          if (!raw.trim()) continue;
          const msg = JSON.parse(raw) as Stage;
          setStages((s) => [...s, msg]);
          if (msg.stage === "done" && msg.result) {
            const result = msg.result as {
              template?: Record<string, unknown>;
              errors?: string[];
            };
            if (result.template) {
              onDraft(result.template);
            } else {
              setError(
                result.errors?.[0] ??
                  "The draft came back unusable. Try describing it differently.",
              );
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="w-[min(46rem,90vw)] rounded-xl border border-white/15 bg-black/80 backdrop-blur-md shadow-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Describe what you want to happen
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            It drafts the trigger, the steps and any Helix event type onto this
            canvas, using your real cameras and doors. Nothing is saved until
            you press Save.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-white/10 shrink-0"
        >
          Build it manually
        </button>
      </div>

      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (intent.trim() && !running) run(intent.trim());
        }}
      >
        <textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          rows={3}
          autoFocus
          placeholder="e.g. when a person shows up at the back door after midnight, describe what they're carrying"
          className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/15 text-sm resize-y focus:outline-none focus:border-sky-600"
        />

        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-slate-400 mr-1">How should it run?</span>
          {(
            [
              [null, "Let it decide"],
              ["webhook", "When something happens"],
              ["schedule", "On a schedule"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setRunMode(v)}
              className={`text-[11px] px-2 py-1 rounded border ${
                runMode === v
                  ? "border-sky-600 bg-sky-900/40 text-white"
                  : "border-white/10 text-slate-400 hover:bg-white/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button
            type="submit"
            disabled={!intent.trim() || running}
            className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white text-sm disabled:opacity-40"
          >
            {running ? "Drafting…" : "Draft it"}
          </button>
          {!running && stages.length === 0 && (
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setIntent(ex)}
                  className="text-[11px] px-2 py-1 rounded border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200"
                >
                  {ex.length > 44 ? ex.slice(0, 44) + "…" : ex}
                </button>
              ))}
            </div>
          )}
        </div>
      </form>

      {stages.length > 0 && (
        <div className="mt-4 rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11.5px] space-y-0.5 max-h-40 overflow-y-auto">
          {stages.map((s, i) => (
            <div key={i} className="flex gap-2">
              <span
                className={
                  s.stage === "error" || s.stage === "invalid"
                    ? "text-amber-300 w-24 shrink-0"
                    : "text-sky-300/80 w-24 shrink-0"
                }
              >
                {s.stage}
              </span>
              <span className="text-slate-400">{s.detail}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="mt-3 text-sm text-rose-300">{error}</div>}
    </div>
  );
}
