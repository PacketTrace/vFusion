import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPut } from "../lib/api";

/**
 * A spending cap, and an honest account of its reach.
 *
 * vFusion can only stop vFusion. This counts what this install spends
 * and refuses to run flows past it; it does not touch the Gemini key,
 * so anything else holding that key keeps spending and a leaked key is
 * not bounded by a number in this database.
 *
 * That is not a footnote — an operator who sets this and believes they
 * are covered is worse off than one who set nothing, because they have
 * stopped looking. So the page says it plainly and points at the thing
 * that is an actual ceiling.
 */

interface CostState {
  enabled: boolean;
  cap_usd: number;
  spent_usd: number;
  since: string;
  halted: boolean;
  remaining_usd: number | null;
}

export default function CostSettings() {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["cost-state"],
    queryFn: () => apiGet<CostState>("/api/cost/state"),
    refetchInterval: 30_000,
  });

  const [enabled, setEnabled] = useState(false);
  const [cap, setCap] = useState("25.00");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!state.data || dirty) return;
    setEnabled(state.data.enabled);
    if (state.data.cap_usd > 0) setCap(state.data.cap_usd.toFixed(2));
  }, [state.data, dirty]);

  const save = useMutation({
    mutationFn: () =>
      apiPut<CostState>("/api/cost/cap", {
        enabled,
        cap_usd: Number(cap) || 0,
      }),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["cost-state"] });
    },
  });

  const s = state.data;
  const pct = s && s.cap_usd > 0 ? Math.min(100, (s.spent_usd / s.cap_usd) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/15 bg-white/5 p-4">
        <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">
          This month
        </div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-2xl font-semibold text-white">
            ${(s?.spent_usd ?? 0).toFixed(2)}
          </span>
          {s?.enabled && (
            <span className="text-sm text-slate-400">
              of ${s.cap_usd.toFixed(2)}
              {s.remaining_usd !== null && !s.halted && (
                <span className="text-slate-500">
                  {" "}
                  · ${s.remaining_usd.toFixed(2)} left
                </span>
              )}
            </span>
          )}
        </div>
        {s?.enabled && (
          <div className="mt-2 h-1.5 rounded bg-white/10 overflow-hidden">
            <div
              className={`h-full ${
                pct >= 100 ? "bg-rose-500" : pct > 80 ? "bg-amber-500" : "bg-sky-500"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        <p className="text-[11px] text-slate-500 mt-2">
          Everything vFusion has spent on Gemini since{" "}
          {s ? new Date(s.since).toLocaleDateString() : "the first"} — flow
          runs, analytics, drafting, help and video. Resets when the month
          does. The full breakdown is on{" "}
          <a href="/settings?tab=stats" className="text-sky-400 hover:text-sky-300">
            Stats
          </a>
          .
        </p>
      </div>

      {s?.halted && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3">
          <div className="text-sm text-rose-200">
            Flows are paused — the cap has been reached.
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Nothing has been disabled. Runs are skipped with that reason
            recorded, and they resume on their own when you raise the cap or
            the month rolls over — so your enabled flows stay exactly as you
            left them.
          </p>
        </div>
      )}

      <div className="rounded-lg border border-white/15 bg-white/5 p-4 space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-slate-400">
          Stop flows at
        </div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setDirty(true);
            }}
            className="mt-0.5"
          />
          <span className="text-sm text-slate-200">
            Pause every flow once this month&rsquo;s spend reaches the amount
            below
          </span>
        </label>
        <div className="flex items-center gap-2">
          <span className="text-slate-400">$</span>
          <input
            value={cap}
            onChange={(e) => {
              setCap(e.target.value);
              setDirty(true);
            }}
            inputMode="decimal"
            className="w-32 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !dirty}
            className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          Checked when each run starts, not when it is queued — so raising the
          cap releases whatever was waiting. A run stopped this way is recorded
          as skipped with the reason, rather than failing.
        </p>
      </div>

      {/* The part that matters most, and the part a cap like this is
          most likely to be mistaken for. */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-4">
        <div className="text-sm text-amber-200">
          This does not limit your Gemini key
        </div>
        <p className="text-xs text-slate-300 mt-1">
          It stops <b>vFusion</b> spending, by refusing to run flows. The key
          itself is untouched: anything else using it keeps going, and if the
          key ever leaked, a number stored here would not slow it down for a
          second.
        </p>
        <p className="text-xs text-slate-300 mt-2">
          Use both. Set this for a fast, precise stop on vFusion&rsquo;s own
          usage, and set a budget and alert on the Google Cloud project that
          owns the key — that one is the actual ceiling, and it is the only
          thing that bounds spending vFusion cannot see.
        </p>
        <a
          href="https://console.cloud.google.com/billing"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-sky-400 hover:text-sky-300 mt-2 inline-block"
        >
          Google Cloud billing budgets ↗
        </a>
      </div>
    </div>
  );
}
