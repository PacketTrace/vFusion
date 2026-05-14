import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  apiGet,
  ApiEndpoint,
  ApiEndpointDetail,
  ApiEndpointList,
  ApiSpec,
} from "../lib/api";

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

function PickerModal({
  onClose,
  onPick,
  writeOnly,
}: {
  onClose: () => void;
  onPick: (endpoint: ApiEndpointDetail) => void;
  writeOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [namespace, setNamespace] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const specs = useQuery({
    queryKey: ["api-specs"],
    queryFn: () => apiGet<ApiSpec[]>("/api/verkada/catalog/specs"),
  });
  const endpoints = useQuery({
    queryKey: ["api-endpoints-picker", namespace, debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "500" });
      if (namespace) params.set("namespace", namespace);
      if (debouncedSearch) params.set("q", debouncedSearch);
      return apiGet<ApiEndpointList>(
        `/api/verkada/catalog/endpoints?${params.toString()}`
      );
    },
  });

  const visible = (endpoints.data?.items ?? []).filter((e) =>
    writeOnly ? ["POST", "PUT", "PATCH", "DELETE"].includes(e.method) : true
  );

  // Group by (namespace, tag) for the visual organization the user expects.
  type Bucket = { label: string; items: ApiEndpoint[] };
  const groupByNs = !namespace;
  const byNs = new Map<string, Map<string, ApiEndpoint[]>>();
  for (const e of visible) {
    const ns = groupByNs ? e.namespace : "";
    const tag = e.tags?.[0] ?? "(untagged)";
    if (!byNs.has(ns)) byNs.set(ns, new Map());
    const m = byNs.get(ns)!;
    if (!m.has(tag)) m.set(tag, []);
    m.get(tag)!.push(e);
  }

  const pick = async (e: ApiEndpoint) => {
    const detail = await apiGet<ApiEndpointDetail>(
      `/api/verkada/catalog/endpoints/${e.id}`
    );
    onPick(detail);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[60]">
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-3xl h-[85vh] flex flex-col">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Pick an endpoint</h3>
          <button
            onClick={onClose}
            className="text-sm px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200"
          >
            Close
          </button>
        </div>

        <div className="px-4 py-2 border-b border-slate-800 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setNamespace("")}
            className={`text-xs px-2 py-1 rounded border ${
              !namespace
                ? "border-sky-600 bg-sky-950/50 text-sky-200"
                : "border-slate-700 text-slate-400 hover:border-slate-500"
            }`}
          >
            All
          </button>
          {(specs.data ?? []).map((s) => (
            <button
              key={s.id}
              onClick={() => setNamespace(s.namespace)}
              className={`text-xs px-2 py-1 rounded border ${
                namespace === s.namespace
                  ? "border-sky-600 bg-sky-950/50 text-sky-200"
                  : "border-slate-700 text-slate-300 hover:border-slate-500"
              }`}
            >
              {s.namespace}
              <span className="text-slate-500 ml-1.5">{s.endpoint_count}</span>
            </button>
          ))}
        </div>

        <div className="px-4 py-2 border-b border-slate-800">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search path, summary, operation_id"
            className="w-full px-3 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm focus:outline-none focus:border-sky-600"
            autoFocus
          />
        </div>

        <div className="flex-1 overflow-auto">
          {[...byNs.entries()].sort().map(([ns, tagMap]) => (
            <div key={ns}>
              {groupByNs && (
                <div className="px-3 py-1.5 bg-slate-900/80 text-[10px] font-bold uppercase tracking-wider text-slate-400 sticky top-0">
                  {ns}
                </div>
              )}
              {[...tagMap.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([tag, items]) => (
                  <div key={tag}>
                    <div className="px-3 py-1.5 bg-slate-900/40 text-xs font-semibold uppercase tracking-wider text-slate-300">
                      {tag}{" "}
                      <span className="text-[10px] text-slate-500 font-normal normal-case">
                        ({items.length})
                      </span>
                    </div>
                    <ul className="divide-y divide-slate-800/50">
                      {items.map((e) => {
                        const label = e.summary || e.operation_id || e.path;
                        return (
                          <li
                            key={e.id}
                            onClick={() => pick(e)}
                            className="px-3 py-2 cursor-pointer hover:bg-slate-800/50 text-sm"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                                  METHOD_STYLE[e.method] ??
                                  "bg-slate-800 text-slate-200"
                                }`}
                              >
                                {e.method}
                              </span>
                              <span className="text-slate-100 truncate">
                                {label}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
            </div>
          ))}
          {!endpoints.isLoading && visible.length === 0 && (
            <div className="p-6 text-sm text-slate-500">No endpoints match.</div>
          )}
        </div>
      </div>
    </div>
  );
}
