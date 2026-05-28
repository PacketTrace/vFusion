import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { apiDelete, apiGet, UnrecognizedGroup, WebhookEvent } from "../lib/api";
import JsonView from "../components/JsonView";

export default function UnrecognizedEvents() {
  const qc = useQueryClient();
  const [openSample, setOpenSample] = useState<string | null>(null);

  const groups = useQuery({
    queryKey: ["unrecognized"],
    queryFn: () =>
      apiGet<UnrecognizedGroup[]>("/api/webhook-events/unrecognized"),
    refetchInterval: 5000,
  });

  const sample = useQuery({
    queryKey: ["webhook-event", openSample],
    queryFn: () => apiGet<WebhookEvent>(`/api/webhook-events/${openSample}`),
    enabled: openSample !== null,
  });

  const clearAll = useMutation({
    mutationFn: () => apiDelete("/api/webhook-events/unrecognized"),
    onSuccess: () => {
      setOpenSample(null);
      qc.invalidateQueries({ queryKey: ["unrecognized"] });
      qc.invalidateQueries({ queryKey: ["webhook-events"] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link to="/inbox" className="text-xs text-slate-500 hover:text-slate-300">
            ← Webhook Explorer
          </Link>
          <h1 className="text-2xl font-semibold text-white mt-1">Unrecognized variants</h1>
          <p className="text-slate-400 text-sm mt-1">
            Webhooks that arrived but don't fit any of the five known families. Each row
            here is a webhook shape we should add to{" "}
            <code className="bg-slate-800 px-1 rounded text-xs">
              backend/app/connectors/verkada/schemas.py
            </code>
            .
          </p>
        </div>
        {groups.data && groups.data.length > 0 && (
          <button
            onClick={() => {
              const total = groups.data!.reduce((a, g) => a + g.count, 0);
              if (
                confirm(
                  `Delete all ${total} unrecognized event${total === 1 ? "" : "s"}? This can't be undone.`
                )
              ) {
                clearAll.mutate();
              }
            }}
            disabled={clearAll.isPending}
            className="shrink-0 text-xs px-3 py-1.5 rounded border border-rose-900 text-rose-300 hover:bg-rose-950 transition-colors disabled:opacity-50"
          >
            {clearAll.isPending ? "Clearing…" : "Clear all"}
          </button>
        )}
      </div>

      <div className="grid grid-cols-12 gap-4 min-h-[60vh]">
        <div className="col-span-5 border border-slate-800 rounded-lg overflow-hidden bg-slate-900/50">
          {groups.isLoading ? (
            <div className="p-6 text-sm text-slate-500">Loading…</div>
          ) : !groups.data || groups.data.length === 0 ? (
            <div className="p-6 text-sm text-emerald-300">
              ✓ Every webhook so far fits the known taxonomy.
            </div>
          ) : (
            <ul className="divide-y divide-slate-800">
              {groups.data.map((g, i) => (
                <li
                  key={`${g.webhook_type}|${g.notification_type}|${i}`}
                  onClick={() => setOpenSample(g.sample_event_id)}
                  className={`px-3 py-2 cursor-pointer text-sm transition-colors ${
                    openSample === g.sample_event_id
                      ? "bg-slate-800"
                      : "hover:bg-slate-800/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-900 text-rose-200">
                      {g.count}×
                    </span>
                    <span className="font-mono text-slate-200">
                      {g.webhook_type ?? "<no webhook_type>"}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-slate-400 mt-1">
                    notification_type: {g.notification_type ?? "<none>"}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    last seen {new Date(g.last_seen).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="col-span-7 border border-slate-800 rounded-lg bg-slate-900/50 overflow-hidden">
          {sample.data ? (
            <div className="h-full flex flex-col">
              <div className="px-4 py-3 border-b border-slate-800">
                <div className="text-xs uppercase tracking-wider text-slate-500">
                  Sample payload
                </div>
                <div className="font-mono text-sm text-slate-200 mt-1 truncate">
                  webhook_type: {sample.data.webhook_type ?? "<none>"}
                </div>
                <div className="font-mono text-xs text-slate-400">
                  notification_type: {sample.data.notification_type ?? "<none>"}
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <div className="bg-slate-950 rounded p-3 overflow-x-auto">
                  {sample.data.body_json !== null &&
                  sample.data.body_json !== undefined ? (
                    <JsonView value={sample.data.body_json} />
                  ) : sample.data.body_text ? (
                    <pre className="font-mono text-xs whitespace-pre-wrap break-all text-slate-300">
                      {sample.data.body_text}
                    </pre>
                  ) : (
                    <span className="text-slate-500 text-sm">(empty body)</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-6 text-sm text-slate-500">
              Select a variant on the left to inspect a sample payload.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
