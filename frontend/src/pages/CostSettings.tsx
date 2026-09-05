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

interface Breakdown {
  sources: {
    name: string;
    what: string;
    token_priced: boolean;
    cost_usd: number;
    calls: number;
  }[];
  flows: { flow_id: string; name: string | null; cost_usd: number; steps: number }[];
  unregistered: { name: string; cost_usd: number }[];
}

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

  const breakdown = useQuery({
    queryKey: ["cost-breakdown"],
    queryFn: () => apiGet<Breakdown>("/api/cost/breakdown"),
    refetchInterval: 60_000,
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

      <div className="rounded-lg border border-white/15 bg-white/5 p-4">
        <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">
          Where it went
        </div>
        <p className="text-[11px] text-slate-500 mb-3">
          Every way vFusion can spend, listed whether or not it has. A row you
          have used this month that still reads $0.00 is not free — it is not
          being recorded, and that is worth knowing.
        </p>
        <table className="w-full text-sm">
          <tbody>
            {(breakdown.data?.sources ?? []).map((row) => (
              <tr key={row.name} className="border-t border-white/10">
                <td className="py-1.5 pr-3">
                  <div className="text-slate-200">{row.name}</div>
                  <div className="text-[11px] text-slate-500">{row.what}</div>
                </td>
                <td className="py-1.5 pr-3 text-right text-[11px] text-slate-500 whitespace-nowrap align-top">
                  {row.calls > 0
                    ? `${row.calls.toLocaleString()} ${row.token_priced ? "calls" : "clips"}`
                    : "—"}
                </td>
                <td
                  className={`py-1.5 text-right font-mono whitespace-nowrap align-top ${
                    row.cost_usd > 0 ? "text-slate-200" : "text-slate-600"
                  }`}
                >
                  ${row.cost_usd.toFixed(row.cost_usd >= 0.01 ? 2 : 4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {(breakdown.data?.unregistered ?? []).length > 0 && (
          <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 p-2">
            <div className="text-xs text-amber-200">
              Spend recorded under a name that is not declared
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              {(breakdown.data?.unregistered ?? [])
                .map((u) => `${u.name} $${u.cost_usd.toFixed(4)}`)
                .join(" · ")}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Add it to app/pricing/sources.py so it appears above with the
              rest.
            </div>
          </div>
        )}
      </div>

      {(breakdown.data?.flows ?? []).length > 0 && (
        <div className="rounded-lg border border-white/15 bg-white/5 p-4">
          <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">
            Which flows
          </div>
          <p className="text-[11px] text-slate-500 mb-3">
            The actionable form of &ldquo;what costs most&rdquo;. Flow spend
            comes off each run&rsquo;s own recorded step costs.
          </p>
          <table className="w-full text-sm">
            <tbody>
              {(breakdown.data?.flows ?? []).map((f) => (
                <tr key={f.flow_id} className="border-t border-white/10">
                  <td className="py-1.5 pr-3 text-slate-200">
                    {f.name ?? (
                      <span className="text-slate-500">
                        deleted flow · {f.flow_id.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-[11px] text-slate-500 whitespace-nowrap">
                    {f.steps.toLocaleString()} steps
                  </td>
                  <td className="py-1.5 text-right font-mono text-slate-200 whitespace-nowrap">
                    ${f.cost_usd.toFixed(f.cost_usd >= 0.01 ? 2 : 4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
