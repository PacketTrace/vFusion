import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet, ApiEndpoint, ApiEndpointDetail } from "../lib/api";
import EndpointBrowser from "./EndpointBrowser";

const METHOD_STYLE: Record<string, string> = {
  GET: "bg-sky-900 text-sky-200",
  POST: "bg-emerald-900 text-emerald-200",
  PUT: "bg-amber-900 text-amber-200",
  PATCH: "bg-violet-900 text-violet-200",
  DELETE: "bg-rose-900 text-rose-200",
};

interface Props {
  value: string | null;
  onChange: (endpoint: ApiEndpointDetail | null) => void;
  /** Restrict to writing methods if set (POST/PUT/PATCH/DELETE only). */
  writeOnly?: boolean;
}

export default function EndpointPicker({ value, onChange, writeOnly }: Props) {
  const [open, setOpen] = useState(false);

  const current = useQuery({
    queryKey: ["api-endpoint", value],
    queryFn: () =>
      apiGet<ApiEndpointDetail>(`/api/verkada/catalog/endpoints/${value}`),
    enabled: !!value,
  });

  return (
    <>
      <div className="flex items-center gap-2">
        {current.data ? (
          <button
            onClick={() => setOpen(true)}
            className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm text-left hover:border-sky-600"
          >
            <span
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                METHOD_STYLE[current.data.method] ?? "bg-slate-800 text-slate-200"
              }`}
            >
              {current.data.method}
            </span>
            <span className="font-mono text-slate-100 truncate">
              {current.data.path}
            </span>
          </button>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="flex-1 px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm text-left text-slate-400 hover:border-sky-600"
          >
            — pick an endpoint from the API Catalog —
          </button>
        )}
        {value && (
          <button
            onClick={() => onChange(null)}
            className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-rose-300"
          >
            Clear
          </button>
        )}
      </div>

      {current.data?.summary && (
        <div className="text-xs text-slate-500 mt-1">{current.data.summary}</div>
      )}

      {open && (
        <PickerModal
          writeOnly={writeOnly}
          onClose={() => setOpen(false)}
          onPick={(detail) => {
            onChange(detail);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/**
 * The modal is now a frame around the shared browser.
 *
 * It used to be a second implementation of the same catalog: its own
 * search with its own debounce, its own namespace chips, its own
 * grouping. Every improvement went to whichever copy was in front of
 * me, so the runner grew search aliases and tag categories and this one
 * did not. One browser, two frames.
 */
function PickerModal({
  onClose,
  onPick,
  writeOnly,
}: {
  onClose: () => void;
  onPick: (endpoint: ApiEndpointDetail) => void;
  writeOnly?: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null);

  // The browser lists endpoints; the caller wants the full operation,
  // so the detail is fetched on pick rather than for all 166 up front.
  const detail = useQuery({
    queryKey: ["api-endpoint", chosen],
    queryFn: () =>
      apiGet<ApiEndpointDetail>(`/api/verkada/catalog/endpoints/${chosen}`),
    enabled: !!chosen,
  });

  useEffect(() => {
    if (detail.data) onPick(detail.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-12 px-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-white/15 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Pick an endpoint</h2>
            {writeOnly && (
              <div className="text-[11px] text-slate-500 mt-0.5">
                Only endpoints that change something — this is an action step.
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-2 py-1 rounded text-slate-400 hover:text-slate-200"
          >
            Close
          </button>
        </div>
        <div className="flex-1 min-h-0 p-3">
          <EndpointBrowser
            className="h-full max-h-[60vh] border-0 bg-transparent"
            selectedId={chosen}
            filter={
              writeOnly
                ? (e: ApiEndpoint) =>
                    ["POST", "PUT", "PATCH", "DELETE"].includes(e.method)
                : undefined
            }
            onPick={(e: ApiEndpoint) => setChosen(e.id)}
          />
        </div>
        {detail.isFetching && (
          <div className="px-5 py-2 text-[11px] text-slate-500 border-t border-white/10">
            Loading the endpoint…
          </div>
        )}
      </div>
    </div>
  );
}
