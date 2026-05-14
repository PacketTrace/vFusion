import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPut, SettingRow, SettingsResponse } from "../lib/api";


export default function Settings() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsResponse>("/api/settings"),
    // Storage usage changes constantly — refresh every 10s so users see
    // it tick down after they tighten a retention window and the next
    // cron sweep runs.
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">
          Tunable knobs for how long captured data sticks around. Changes apply
          on the next cleanup cron tick (within ~30 seconds).
        </p>
      </div>

      <Card title="Retention">
        <p className="text-xs text-slate-400 mb-4">
          The hourly cleanup cron deletes anything older than these windows.
          Set any row to <code className="font-mono text-slate-300">0</code> to
          keep that bucket forever. Storage figures on the right show how much
          you're currently keeping.
        </p>
        {!settings.data ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : (
          <div className="space-y-3">
            {settings.data.items.map((row) => (
              <SettingEditor key={row.key} row={row} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}


function SettingEditor({ row }: { row: SettingRow }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<string>(row.value ?? row.default);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setValue(row.value ?? row.default);
  }, [row.value, row.default]);

  const save = useMutation({
    mutationFn: (next: string) =>
      apiPut<SettingRow>(`/api/settings/${row.key}`, { value: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSavedAt(Date.now());
      window.setTimeout(() => setSavedAt(null), 1500);
    },
  });

  const isUnlimited = value === "0" || value === "";
  const isDirty = value !== (row.value ?? row.default);

  return (
    <div className="border border-white/10 rounded-md p-4 bg-white/5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-200">{row.label}</div>
          <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
            {row.description}
          </div>
        </div>
        {row.usage && (
          <div className="shrink-0 text-right">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              Current usage
            </div>
            <div className="text-sm text-slate-200 mt-0.5 font-medium">
              {row.usage.summary}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mt-4 flex-wrap">
        <input
          type="number"
          min={0}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-20 px-2 py-1.5 rounded bg-slate-950 border border-white/15 text-sm font-mono"
        />
        <span className="text-xs text-slate-400">{row.unit}</span>
        {isUnlimited && row.allow_zero && (
          <span className="text-[10px] text-amber-300 bg-amber-950/40 border border-amber-900/50 rounded px-1.5 py-0.5">
            unlimited — never deleted
          </span>
        )}
        <span className="text-[10px] text-slate-500 ml-1">
          default {row.default} {row.unit}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setValue(row.default)}
          className="text-xs px-2 py-1 rounded border border-white/15 text-slate-400 hover:text-slate-200 hover:border-white/30 disabled:opacity-30"
          disabled={value === row.default}
        >
          reset
        </button>
        <button
          onClick={() => save.mutate(value)}
          disabled={!isDirty || save.isPending}
          className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {save.isPending ? "Saving…" : savedAt ? "Saved ✓" : "Save"}
        </button>
      </div>
      {save.isError && (
        <div className="text-xs text-rose-300 mt-2">
          {(save.error as Error).message}
        </div>
      )}
    </div>
  );
}


function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      <h2 className="text-xs uppercase tracking-wider text-slate-400 mb-3">
        {title}
      </h2>
      {children}
    </div>
  );
}
