import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet, ApiEndpoint, ApiEndpointList } from "../lib/api";

const METHOD_COLOR: Record<string, string> = {
  GET: "text-sky-300",
  POST: "text-emerald-300",
  PUT: "text-amber-300",
  PATCH: "text-amber-300",
  DELETE: "text-rose-300",
};

// Starting points for someone who does not know the vocabulary. These
// are searches, not endpoints — "door" finds eleven things and one of
// them is the one you meant.
// What people call these things, mapped onto the paths Verkada uses.
// Searching "plate" should find LPR; searching "notify" should find the
// nothing it deserves, but say so having actually looked.
const ALIASES: Record<string, string> = {
  video_tagging: "helix event tag custom data timeline",
  lpr: "plate license plate vehicle anpr",
  occupancy: "people count crowd busy footfall",
  audit_log: "audit history who did what activity log",
  access_users: "badge credential card person employee",
  doors: "door lock unlock entry",
  alarms: "alarm siren panic intrusion",
  environment: "sensor temperature humidity air quality noise",
  footage: "video clip recording playback thumbnail image",
  devices: "camera hardware inventory",
  guest: "visitor reception sign in",
};

/** A readable name for a namespace, for endpoints the spec left untagged. */
function namespaceLabel(ns: string): string {
  return ns
    .replace(/_v\d+$/, "")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** The distinguishing tail of a path. Every camera endpoint starts
 *  "/cameras/v1/", so leading with it wastes the width a sidebar has
 *  least of. */
function shortName(e: { path: string }): string {
  const parts = e.path.split("/").filter(Boolean);
  return parts.slice(2).join("/") || e.path;
}

/** Whether a field names a single camera.
 *
 * Matched on the name rather than a list of endpoints, because the
 * spec uses camera_id consistently and a curated list would miss the
 * next endpoint to use it. Deliberately not camera_ids — a plural takes
 * a comma-separated set, and offering one picker for it would quietly
 * discard whatever was already typed. */

/**
 * Browse Verkada's endpoint catalog.
 *
 * There were two of these: this one, grown on the API runner, and an
 * older modal the flow editor opened to pick an endpoint for a
 * verkada_api_call step. Same catalog, two implementations, and every
 * improvement went to whichever one was in front of me — search
 * aliases, tag categories and method colours only ever reached the
 * runner. One component, used by both.
 */
export default function EndpointBrowser({
  selectedId,
  onPick,
  filter,
  className = "",
}: {
  selectedId?: string | null;
  onPick: (e: ApiEndpoint) => void;
  /** Narrow what is offered — the flow editor's write-action picker
   *  only wants endpoints that change something. */
  filter?: (e: ApiEndpoint) => boolean;
  className?: string;
}) {
  const [q, setQ] = useState("");
  // Which categories are expanded. Nothing is open on arrival: a wall of
  // 166 endpoints is the thing the categories exist to prevent.
  const [open, setOpen] = useState<Set<string>>(new Set());

  // The whole catalog, once. It is a few hundred rows, so filtering in
  // the browser is instant and keystrokes do not each cost a request.
  const all = useQuery({
    queryKey: ["api-endpoints-all"],
    queryFn: () =>
      apiGet<ApiEndpointList>("/api/verkada/catalog/endpoints?limit=1000"),
  });

  const hits = useMemo(() => {
    const items = (all.data?.items ?? []).filter((e) => !filter || filter(e));
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    const words = needle.split(/\s+/);
    return items.filter((e) => {
      const path = e.path.toLowerCase();
      let hay = `${e.method} ${path} ${e.summary ?? ""} ${
        e.operation_id ?? ""
      }`.toLowerCase();
      // Fold in the words an operator would actually type for these
      // paths. Verkada names things its own way and you cannot search a
      // vocabulary you do not have.
      for (const [fragment, extra] of Object.entries(ALIASES)) {
        if (path.includes(fragment)) hay += ` ${extra}`;
      }
      return words.every((w) => hay.includes(w));
    });
  }, [all.data, q, filter]);

  // Categories come from the spec's tags rather than from a list here.
  // A hand-written taxonomy would be a second opinion about someone
  // else's API, wrong the first time they add a section.
  const groups = useMemo(() => {
    const by = new Map<string, ApiEndpoint[]>();
    for (const e of hits) {
      const tag = e.tags?.[0]?.trim() || namespaceLabel(e.namespace);
      if (!by.has(tag)) by.set(tag, []);
      by.get(tag)!.push(e);
    }
    for (const list of by.values()) {
      list.sort(
        (a, b) =>
          a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
      );
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [hits]);

  return (
    <div
      className={`rounded-lg border border-white/15 bg-white/5 flex flex-col ${className}`}
    >
      <div className="p-2 border-b border-white/10">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            all.data ? `Filter ${all.data.total} endpoints…` : "Loading…"
          }
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs focus:outline-none focus:border-sky-600"
        />
      </div>

      <div className="overflow-y-auto flex-1 py-1">
        {all.error && (
          <div className="px-3 py-3 text-xs text-rose-300">
            Could not load the catalog: {(all.error as Error).message}
          </div>
        )}
        {all.data?.total === 0 && (
          <div className="px-3 py-3 text-xs text-amber-300">
            Nothing crawled yet. Trigger a sync from MCP › Verkada API catalog.
          </div>
        )}
        {groups.map(([group, items]) => {
          // A search collapses the tree to what matched, so the
          // categories stop being navigation and start being labels on
          // the results.
          const isOpen = q.trim() !== "" || open.has(group);
          return (
            <div key={group}>
              <button
                type="button"
                onClick={() => {
                  const next = new Set(open);
                  if (next.has(group)) next.delete(group);
                  else next.add(group);
                  setOpen(next);
                }}
                className="w-full flex items-baseline gap-2 px-3 py-1.5 text-left hover:bg-white/5"
              >
                <span className="text-slate-500 text-[10px] w-2">
                  {isOpen ? "▾" : "▸"}
                </span>
                <span className="text-xs text-slate-200">{group}</span>
                <span className="text-[10px] text-slate-600 ml-auto">
                  {items.length}
                </span>
              </button>
              {isOpen &&
                items.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onPick(e)}
                    title={e.summary ?? e.path}
                    className={`w-full text-left pl-7 pr-2 py-1 flex items-baseline gap-1.5 hover:bg-white/5 ${
                      selectedId === e.id ? "bg-sky-900/30" : ""
                    }`}
                  >
                    <span
                      className={`text-[9px] font-mono w-10 shrink-0 ${
                        METHOD_COLOR[e.method] ?? "text-slate-400"
                      }`}
                    >
                      {e.method}
                    </span>
                    <span className="text-[11px] text-slate-300 truncate">
                      {shortName(e)}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
        {q.trim() !== "" && groups.length === 0 && (
          <div className="px-3 py-3 text-xs text-slate-500">
            Nothing matches “{q}”. Verkada names things its own way — Helix
            lives under video_tagging, plates under lpr.
          </div>
        )}
      </div>
    </div>
  );
}
