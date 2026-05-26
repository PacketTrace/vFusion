import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  apiGet,
  apiPost,
  WebhookEventListItem,
  WebhookEventListResponse,
} from "../lib/api";


interface Props {
  flowId: string;
  family: string | null;
  notificationType: string | null;
  // Same field→value shape as the trigger's filters config. The modal
  // forwards these to the events list endpoint so the operator only
  // sees payloads that would actually fire the live trigger — e.g. a
  // flow filtered on ``objects = animal`` doesn't get drowned in
  // every motion event.
  filters?: Array<{ field: string; value: string }>;
  defaultEventId: string | null;
  onClose: () => void;
  onRun: (runId: string) => void;
}


export default function TestRunModal({
  flowId,
  family,
  notificationType,
  filters,
  defaultEventId,
  onClose,
  onRun,
}: Props) {
  const [picked, setPicked] = useState<string | null>(defaultEventId);
  const [error, setError] = useState<string | null>(null);

  // Recent events, filtered by the flow's trigger family/notification_type
  // so the user mostly sees plausible test inputs. The list endpoint accepts
  // optional family/notification_type so we just forward what we have.
  const activeFilters = (filters ?? []).filter((f) => f.field && f.value);
  const params = new URLSearchParams({ limit: "25" });
  if (family) params.set("family", family);
  if (notificationType) params.set("notification_type", notificationType);
  for (const f of activeFilters) {
    params.append("filters", `${f.field}=${f.value}`);
  }
  // Encode filters in the cache key so the list refetches when the
  // operator tweaks the trigger and reopens the modal.
  const filterKey = activeFilters
    .map((f) => `${f.field}=${f.value}`)
    .join("&");
  const recent = useQuery({
    queryKey: ["test-run-events", family, notificationType, filterKey],
    queryFn: () =>
      apiGet<WebhookEventListResponse>(
        `/api/webhook-events?${params.toString()}`,
      ),
  });

  // If the default event isn't in the recent list (older / wrong family),
  // we still want it shown so the user can re-pick it. Load it separately.
  const defaultEv = useQuery({
    queryKey: ["test-run-default-event", defaultEventId],
    queryFn: () =>
      apiGet<WebhookEventListItem>(`/api/webhook-events/${defaultEventId}`),
    enabled: Boolean(defaultEventId),
  });

  useEffect(() => {
    if (picked || !recent.data?.items?.length) return;
    setPicked(recent.data.items[0].id);
  }, [recent.data, picked]);

  const run = useMutation({
    mutationFn: (eventId: string) =>
      apiPost<{ run_id: string }>(`/api/flows/${flowId}/test-run`, {
        webhook_event_id: eventId,
      }),
    onSuccess: (res) => onRun(res.run_id),
    onError: (e: Error) => setError(e.message),
  });

  const items: WebhookEventListItem[] = recent.data?.items ?? [];
  const showsDefault = items.some((i) => i.id === defaultEventId);
  const merged =
    !showsDefault && defaultEv.data ? [defaultEv.data, ...items] : items;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-md w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-800 flex items-center">
          <div>
            <div className="text-sm font-medium text-slate-100">Test run</div>
            <div className="text-xs text-slate-500">
              Pick a past webhook to feed this flow as its trigger payload.
              {family ? ` Showing ${family}` : ""}
              {notificationType ? ` / ${notificationType}` : ""}
              {family || notificationType ? " events" : ""}
              {activeFilters.length > 0 && (
                <>
                  {" where "}
                  {activeFilters.map((f, i) => (
                    <span key={`${f.field}-${i}`}>
                      {i > 0 && " and "}
                      <code className="text-slate-300">{f.field}</code>
                      {" = "}
                      <code className="text-slate-300">{f.value}</code>
                    </span>
                  ))}
                </>
              )}
              {family || notificationType || activeFilters.length > 0
                ? "."
                : ""}
            </div>
          </div>
          <button
            className="ml-auto text-slate-500 hover:text-slate-200 text-sm"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {recent.isLoading ? (
            <div className="p-4 text-xs text-slate-500">Loading…</div>
          ) : merged.length === 0 ? (
            <div className="p-4 text-xs text-slate-500">
              No matching webhook events found. Send one or relax the trigger
              filter.
            </div>
          ) : (
            <ul>
              {merged.map((ev) => (
                <li key={ev.id}>
                  <label className="flex items-start gap-3 px-4 py-2 border-b border-slate-800 hover:bg-slate-800/50 cursor-pointer">
                    <input
                      type="radio"
                      checked={picked === ev.id}
                      onChange={() => setPicked(ev.id)}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-slate-200 truncate">
                        {ev.notification_type ?? ev.family ?? "unknown"}
                        {ev.id === defaultEventId && (
                          <span className="ml-2 text-[10px] text-sky-400 uppercase">
                            source
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {ev.received_at} · /{ev.slug}
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="px-4 py-3 border-t border-slate-800 flex items-center gap-2">
          {error && (
            <span className="text-xs text-rose-300 truncate" title={error}>
              {error}
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto text-xs px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            Cancel
          </button>
          <button
            disabled={!picked || run.isPending}
            onClick={() => picked && run.mutate(picked)}
            className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
          >
            {run.isPending ? "Running…" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
