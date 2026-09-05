import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { apiPost } from "../lib/api";

/**
 * Ask vFusion about vFusion.
 *
 * The answers come from a corpus assembled out of the running source —
 * documentation, the live action and endpoint lists, and the docstrings
 * the authors wrote, which is where the constraints live. So it is
 * right about what does not work, not just what does, and it stays
 * right when the code changes because there is no second copy to update.
 */

interface Turn {
  role: "user" | "assistant";
  content: string;
  where?: string | null;
  cost?: number | null;
  tokensIn?: number;
}

interface HelpReply {
  reply: string;
  where: string | null;
  model: string;
  corpus_chars: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
}

/** Sub-cent answers are the normal case, so two decimals would render
 *  every question as "$0.00" and hide the one that was not. */
function money(n: number): string {
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

const OPENERS = [
  "What can vFusion actually do?",
  "How do I get notified when something happens?",
  "What's the difference between a flow and an analytic?",
  "Why isn't my flow firing?",
];

export default function HelpChat({ onClose }: { onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [meta, setMeta] = useState<HelpReply | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionCost = turns.reduce((sum, t) => sum + (t.cost ?? 0), 0);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  // Escape closes. A panel over the whole page that only closes by
  // finding the right button is the sort of thing people stop opening.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = useMutation({
    mutationFn: (history: Turn[]) =>
      apiPost<HelpReply>("/api/help/chat", {
        messages: history.map((t) => ({ role: t.role, content: t.content })),
      }),
    onSuccess: (r) => {
      setMeta(r);
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          content: r.reply,
          where: r.where,
          cost: r.cost_usd,
          tokensIn: r.tokens_in,
        },
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

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-[min(30rem,100%)] h-full bg-[#0b0f14] border-l border-white/15 flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-white/10">
          <div>
            <div className="text-sm font-semibold text-white">
              Help with vFusion
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Answers read from this install&rsquo;s own source, so they match
              the build you are running.
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

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
          {turns.length === 0 && (
            <div className="text-xs text-slate-400">
              <p>
                Ask what something does, where to find it, or whether vFusion
                can do a thing at all. It will say no when the answer is no —
                that is the part a manual usually gets wrong.
              </p>
              <div className="flex flex-col items-start gap-1.5 mt-3">
                {OPENERS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => ask(q)}
                    className="text-[11px] text-left px-2 py-1 rounded bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300"
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
                    ? "text-sm text-slate-200 bg-sky-900/30 border border-sky-700/30 rounded-lg px-3 py-2 ml-6"
                    : "text-sm text-slate-300 whitespace-pre-wrap"
                }
              >
                {t.content}
              </div>
              {t.role === "assistant" && t.cost != null && (
                <div className="text-[10px] text-slate-600 mt-1">
                  {money(t.cost)} &middot; {t.tokensIn?.toLocaleString()} tokens in
                </div>
              )}
              {t.where && (
                <div className="mt-1.5 text-[11px] text-emerald-300 bg-emerald-900/20 border border-emerald-800/40 rounded px-2 py-1 inline-block">
                  {t.where}
                </div>
              )}
            </div>
          ))}
          {send.isPending && (
            <div className="text-sm text-slate-500">Reading the source…</div>
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-white/10 p-3">
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
              autoFocus
              placeholder="Ask about vFusion…"
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
            <div className="text-[10px] text-slate-600 mt-1.5">
              Reads {Math.round(meta.corpus_chars / 1000)}k characters of this
              install&rsquo;s docs and source comments on every question &middot;{" "}
              {meta.model}
              {sessionCost > 0 && <> &middot; {money(sessionCost)} this session</>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
