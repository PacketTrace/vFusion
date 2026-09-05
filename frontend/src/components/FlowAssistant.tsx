import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { apiPost } from "../lib/api";

/**
 * An advisor beside the flow builder, not a second way to build.
 *
 * It answers questions and can hand a *description* to the builder, but
 * it never generates or edits a flow itself. That boundary is the point:
 * a chat that mutates the canvas means flows appear without anyone
 * asking for one, and the operator stops being able to predict what a
 * message will do. Pressing "Send to the builder" stays a deliberate act.
 */

interface Turn {
  role: "user" | "assistant";
  content: string;
  // Attached to an assistant turn when it thinks there is something to
  // build. Rendered as an offer, never applied on its own.
  suggestion?: string | null;
}

interface AssistReply {
  reply: string;
  suggestion: string | null;
  model: string;
  context_chars: number;
  known_flows: number;
  known_cameras: number;
}

const OPENERS = [
  "What can a flow actually do?",
  "Do I already have something like this?",
  "Why did it choose that trigger?",
];

export default function FlowAssistant({
  currentFlow,
  onUseSuggestion,
}: {
  // Whatever is on the canvas right now — an unsaved proposal only
  // exists in the browser, so it is sent rather than looked up.
  currentFlow: unknown;
  onUseSuggestion: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [meta, setMeta] = useState<AssistReply | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, open]);

  const send = useMutation({
    mutationFn: (history: Turn[]) =>
      apiPost<AssistReply>("/api/flow-assist/chat", {
        messages: history.map((t) => ({ role: t.role, content: t.content })),
        flow: currentFlow ?? null,
      }),
    onSuccess: (r) => {
      setMeta(r);
      setTurns((t) => [
        ...t,
        { role: "assistant", content: r.reply, suggestion: r.suggestion },
      ]);
    },
    onError: (e: Error) => {
      setTurns((t) => [
        ...t,
        { role: "assistant", content: `I couldn't answer that: ${e.message}` },
      ]);
    },
  });

  function ask(text: string) {
    const next: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(next);
    setDraft("");
    send.mutate(next);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 text-sm px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 text-slate-200"
      >
        Ask about flows
        <span className="text-slate-500 ml-2 text-xs">
          questions, not generation
        </span>
      </button>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-white/15 bg-white/5">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="text-sm text-slate-200">Ask about flows</div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-white/10"
        >
          Close
        </button>
      </div>

      <div className="max-h-[380px] overflow-y-auto px-3 py-3 space-y-3">
        {turns.length === 0 && (
          <div className="text-xs text-slate-400">
            <p>
              This answers questions about what vFusion can do and about the
              draft on screen. It reads the same action catalog, taxonomy and
              device list the builder generates from, so it will not invent an
              action that does not exist. It never edits your flow — at most it
              offers a description you can send to the builder.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {OPENERS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => ask(q)}
                  className="text-[11px] px-2 py-1 rounded bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i}>
            <div
              className={
                t.role === "user"
                  ? "text-sm text-slate-200 bg-sky-900/30 border border-sky-700/30 rounded-lg px-3 py-2 ml-8"
                  : "text-sm text-slate-300 whitespace-pre-wrap"
              }
            >
              {t.content}
            </div>
            {t.suggestion && (
              <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                <div className="text-[11px] uppercase tracking-wider text-emerald-300/80 mb-1">
                  Description for the builder
                </div>
                <div className="text-xs text-slate-300">{t.suggestion}</div>
                <button
                  type="button"
                  onClick={() => onUseSuggestion(t.suggestion as string)}
                  className="mt-2 text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
                >
                  Send to the builder
                </button>
              </div>
            )}
          </div>
        ))}

        {send.isPending && (
          <div className="text-sm text-slate-500">Thinking…</div>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-white/10 p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() && !send.isPending) ask(draft.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask a question…"
            className="flex-1 px-2.5 py-1.5 rounded bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600"
          />
          <button
            type="submit"
            disabled={!draft.trim() || send.isPending}
            className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            Ask
          </button>
        </form>
        {meta && (
          <div className="text-[11px] text-slate-500 mt-1.5 px-1">
            Grounded in {meta.known_cameras} camera
            {meta.known_cameras === 1 ? "" : "s"}, {meta.known_flows} existing
            flow{meta.known_flows === 1 ? "" : "s"} and the live action catalog
            — {Math.round(meta.context_chars / 1000)}k characters, read fresh
            each time. {meta.model}.
          </div>
        )}
      </div>
    </div>
  );
}
