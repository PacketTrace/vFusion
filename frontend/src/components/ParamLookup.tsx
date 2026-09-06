import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { apiGet, apiPost } from "../lib/api";

export type Lookup = {
  param: string;
  method: string;
  path: string;
  summary: string | null;
  confidence: "exact" | "guess";
  reason: string;
};

type LookupResponse = { lookups: Lookup[]; unresolved: string[] };
type ResolveResponse = {
  options: { value: string; label: string }[];
  status_code: number;
  note: string | null;
};

/** Which call produces each id this endpoint needs. Cached per endpoint
 *  — the answer comes from the crawled spec and does not change while
 *  you are looking at one call.
 *
 *  ``extraParams`` covers query and body fields. An id is an id wherever
 *  it is asked for: user_id on the unlock endpoint is a body field, and
 *  resolving only {placeholders} left exactly the boxes nobody can
 *  fill. */
export function usePathLookups(
  path: string | undefined,
  extraParams: string[] = [],
) {
  const extra = [...new Set(extraParams)].sort().join(",");
  return useQuery({
    queryKey: ["param-lookups", path, extra],
    queryFn: () =>
      apiGet<LookupResponse>(
        `/api/param-lookup?path=${encodeURIComponent(path!)}` +
          (extra ? `&params=${encodeURIComponent(extra)}` : ""),
      ),
    enabled: !!path && (path.includes("{") || extra.length > 0),
    staleTime: 5 * 60_000,
  });
}

/**
 * Fetch the ids for one parameter and let the operator pick one.
 *
 * The runner would show an empty box for ``access_level_id`` and refuse
 * to run, and the only way forward was to already know which other call
 * lists them. The call is run right here and its results become a list
 * you click.
 */
export default function ParamLookup({
  lookup,
  connectionId,
  token,
  onPick,
}: {
  lookup: Lookup;
  connectionId: string | null;
  token: string | null;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const resolve = useMutation({
    mutationFn: () =>
      apiPost<ResolveResponse>("/api/param-lookup/resolve", {
        connection_id: connectionId,
        token,
        method: lookup.method,
        path: lookup.path,
        param: lookup.param,
      }),
  });

  const options = resolve.data?.options ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(needle) ||
          o.value.toLowerCase().includes(needle),
      )
    : options;

  return (
    <div className="mt-1">
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            if (!resolve.data && !resolve.isPending) resolve.mutate();
          }}
          className="text-[11px] px-2 py-1 rounded border border-sky-500/40 text-sky-200 hover:bg-sky-500/15"
          title={lookup.reason}
        >
          Look it up
          <span className="text-slate-500 ml-1.5 font-mono">
            {lookup.method} {lookup.path}
          </span>
        </button>
      ) : (
        <div className="rounded-md border border-white/15 bg-black/30 p-2 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-mono text-slate-400">
              {lookup.method} {lookup.path}
            </span>
            {/* Said up front, not after a confusing result. A guessed
                lookup that returns the wrong thing is otherwise
                indistinguishable from an org that has none. */}
            {lookup.confidence === "guess" && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300"
                title={lookup.reason}
              >
                best guess
              </span>
            )}
            <button
              type="button"
              onClick={() => resolve.mutate()}
              disabled={resolve.isPending}
              className="ml-auto text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-40"
            >
              {resolve.isPending ? "Running…" : "Re-run"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11px] text-slate-400 hover:text-slate-200"
            >
              Close
            </button>
          </div>

          {resolve.isPending && (
            <div className="text-[11px] text-slate-500">
              Running the lookup…
            </div>
          )}
          {resolve.isError && (
            <div className="text-[11px] text-rose-300">
              {(resolve.error as Error).message}
            </div>
          )}
          {resolve.data?.note && (
            <div className="text-[11px] text-amber-300">
              {resolve.data.note}
            </div>
          )}

          {options.length > 8 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${options.length}…`}
              className="w-full px-2 py-1 rounded bg-white/5 border border-white/15 text-xs"
            />
          )}

          {options.length > 0 && (
            <ul className="max-h-52 overflow-auto divide-y divide-white/5">
              {shown.map((o) => (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(o.value);
                      setOpen(false);
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-white/10 rounded"
                  >
                    <div className="text-xs text-slate-100">
                      {o.label || <span className="text-slate-500">(unnamed)</span>}
                    </div>
                    <div className="text-[10.5px] font-mono text-slate-500">
                      {o.value}
                    </div>
                  </button>
                </li>
              ))}
              {shown.length === 0 && (
                <li className="px-2 py-1.5 text-[11px] text-slate-500">
                  Nothing matches “{filter}”.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
