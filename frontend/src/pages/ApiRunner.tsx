import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import JsonView from "../components/JsonView";
import { copyToClipboard } from "../lib/clipboard";
import {
  ApiEndpoint,
  ApiEndpointDetail,
  ApiEndpointList,
  apiGet,
  apiPost,
  Connection,
} from "../lib/api";

/**
 * Run any Verkada endpoint. Search first, because nobody knows the
 * names.
 *
 * The first version put a picker component behind a label and a form
 * around it, which assumed you already knew what you were looking for.
 * You do not — you know you want to unlock a door, or find out what a
 * camera saw. So this is one search box over path, summary and
 * operation id, a flat list of hits, and the form appears only once you
 * have chosen. Everything the endpoint does not need stays off screen.
 */

interface RunResult {
  ok: boolean;
  method: string;
  path: string;
  query: Record<string, unknown>;
  status_code?: number;
  elapsed_ms: number;
  body?: unknown;
  error?: string;
}

interface Param {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string; enum?: string[] };
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

function paramsOf(detail: ApiEndpointDetail | null): Param[] {
  const raw = detail?.raw as { parameters?: Param[] } | undefined;
  return Array.isArray(raw?.parameters) ? raw!.parameters! : [];
}

interface BodyField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: string[];
}

/** Descriptions in the spec carry HTML — mostly <code> around example
 *  values — which would otherwise render as literal angle brackets. */
function plain(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The request body as a list of fields, the way Verkada's own docs show
 * it: a labelled input per property with its description and whether it
 * is required.
 *
 * This used to be a JSON textarea with a "fill from schema" button,
 * which put the burden of knowing seven parameter names on whoever was
 * trying to find out what they were. The spec has all of it — names,
 * types, descriptions, the required list — and the backend already
 * inlines the $ref, so there was never a reason not to render it.
 */
function bodyFields(detail: ApiEndpointDetail | null): BodyField[] {
  const raw = detail?.raw as
    | { requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> } }
    | undefined;
  const schema = raw?.requestBody?.content?.["application/json"]?.schema as
    | {
        properties?: Record<
          string,
          { type?: string; description?: string; enum?: string[] }
        >;
        required?: string[];
      }
    | undefined;
  const props = schema?.properties;
  if (!props) return [];
  const required = new Set(schema?.required ?? []);
  return Object.entries(props).map(([name, v]) => ({
    name,
    type: v.type ?? "string",
    required: required.has(name),
    description: plain(v.description),
    enum: v.enum,
  }));
}

/** Coerce to what the schema says. Sending "1" where an integer is
 *  expected is a 400 that reads like a permissions problem. */
function coerce(value: string, type: string): unknown {
  if (type === "integer" || type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === "boolean") return value === "true" || value === "1";
  if (type === "array") {
    return value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return value;
}

export default function ApiRunner() {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ApiEndpoint | null>(null);
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [bodyValues, setBodyValues] = useState<Record<string, string>>({});
  const [rawMode, setRawMode] = useState(false);
  const [bodyText, setBodyText] = useState("");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [connId, setConnId] = useState("");
  const [armed, setArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  // Which categories are expanded. Nothing is open on arrival: a wall of
  // 121 endpoints is the thing the categories exist to prevent.
  const [open, setOpen] = useState<Set<string>>(new Set());

  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const verkada = (conns.data ?? []).filter((c) => c.type === "verkada");

  // The whole catalog, once. It is a few hundred rows, so filtering in
  // the browser is instant and keystrokes do not each cost a request.
  const all = useQuery({
    queryKey: ["api-endpoints-all"],
    queryFn: () =>
      apiGet<ApiEndpointList>("/api/verkada/catalog/endpoints?limit=1000"),
  });

  const hitsRaw = useMemo(() => {
    const items = all.data?.items ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    const words = needle.split(/\s+/);
    return items
      .filter((e) => {
        const path = e.path.toLowerCase();
        let hay = `${e.method} ${path} ${e.summary ?? ""} ${
          e.operation_id ?? ""
        }`.toLowerCase();
        // Fold in the words an operator would actually type for these
        // paths. Verkada names things its own way and you cannot search
        // a vocabulary you do not have.
        for (const [fragment, extra] of Object.entries(ALIASES)) {
          if (path.includes(fragment)) hay += ` ${extra}`;
        }
        return words.every((w) => hay.includes(w));
      });
  }, [all.data, q]);

  // Categories come from the spec's tags rather than from a list here.
  // A hand-written taxonomy would be a second opinion about someone
  // else's API, wrong the first time they add a section.
  const groups = useMemo(() => {
    const by = new Map<string, ApiEndpoint[]>();
    for (const e of hitsRaw) {
      const tag = e.tags?.[0]?.trim() || namespaceLabel(e.namespace);
      if (!by.has(tag)) by.set(tag, []);
      by.get(tag)!.push(e);
    }
    for (const list of by.values()) {
      list.sort(
        (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
      );
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [hitsRaw]);


  const detail = useQuery({
    queryKey: ["api-endpoint", picked?.id],
    queryFn: () =>
      apiGet<ApiEndpointDetail>(`/api/verkada/catalog/endpoints/${picked!.id}`),
    enabled: !!picked,
  });

  const params = useMemo(() => paramsOf(detail.data ?? null), [detail.data]);
  const bodyParams = useMemo(() => bodyFields(detail.data ?? null), [detail.data]);
  const pathParams = params.filter((p) => p.in === "path");
  const queryParams = params.filter((p) => p.in === "query");
  const method = (picked?.method ?? "GET").toUpperCase();
  const isWrite = WRITE.has(method);
  const missing = pathParams.filter((p) => !pathValues[p.name]?.trim());

  const run = useMutation({
    mutationFn: () =>
      apiPost<RunResult>("/api/api-runner/run", {
        connection_id: connId || null,
        method,
        path: picked?.path,
        path_params: pathValues,
        query: queryValues,
        json_body: !isWrite
          ? null
          : rawMode
            ? bodyText.trim()
              ? JSON.parse(bodyText)
              : null
            : Object.fromEntries(
                bodyParams
                  .filter((f) => (bodyValues[f.name] ?? "").trim() !== "")
                  .map((f) => [f.name, coerce(bodyValues[f.name]!.trim(), f.type)]),
              ),
      }),
  });

  function choose(e: ApiEndpoint) {
    setPicked(e);
    setPathValues({});
    setQueryValues({});
    setBodyValues({});
    setBodyText("");
    setRawMode(false);
    setBodyError(null);
    setArmed(false);
    run.reset();
  }

  function onRun() {
    setBodyError(null);
    const missingBody = bodyParams.filter(
      (f) => f.required && !(bodyValues[f.name] ?? "").trim(),
    );
    if (isWrite && !rawMode && missingBody.length > 0) {
      setBodyError(
        `Required: ${missingBody.map((f) => f.name).join(", ")}`,
      );
      return;
    }
    if (isWrite && rawMode && bodyText.trim()) {
      try {
        JSON.parse(bodyText);
      } catch (e) {
        setBodyError(`Body is not valid JSON: ${(e as Error).message}`);
        return;
      }
    }
    run.mutate();
  }

  return (
    <div className="flex gap-4 items-start">
      {/* Browse first, search second. Search assumes you already know
          the word; the categories are how you find out what exists —
          which is the same reason Verkada's own docs lead with them. */}
      <div className="w-72 shrink-0 rounded-lg border border-white/15 bg-white/5 flex flex-col max-h-[38rem]">
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
              Nothing crawled yet. Trigger a sync from MCP › Verkada API
              catalog.
            </div>
          )}
          {groups.map(([group, items]) => {
            // A search collapses the tree to what matched, so the
            // categories stop being navigation and start being labels
            // on the results.
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
                      onClick={() => choose(e)}
                      title={e.summary ?? e.path}
                      className={`w-full text-left pl-7 pr-2 py-1 flex items-baseline gap-1.5 hover:bg-white/5 ${
                        picked?.id === e.id ? "bg-sky-900/30" : ""
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
              Nothing matches “{q}”. Verkada names things its own way —
              Helix lives under video_tagging, plates under lpr.
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 space-y-3">
      {!picked && (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-sm text-slate-500">
          Pick an endpoint on the left. Categories come from Verkada&rsquo;s own
          tags, so they match how the API is documented.
        </div>
      )}

      {picked && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-lg border border-white/15 bg-white/5 p-3 space-y-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span
                className={`text-xs font-mono ${METHOD_COLOR[method] ?? "text-slate-300"}`}
              >
                {method}
              </span>
              <span className="font-mono text-xs text-slate-200 break-all">
                {picked.path}
              </span>
            </div>
            {picked.summary && (
              <p className="text-xs text-slate-200">{picked.summary}</p>
            )}
            {detail.data?.description &&
              plain(detail.data.description) !== plain(picked.summary ?? "") && (
                <p className="text-[11px] text-slate-400 whitespace-pre-wrap">
                  {plain(detail.data.description)}
                </p>
              )}
            <div className="flex items-center gap-3 text-[11px]">
              <span className="text-slate-600 font-mono">
                {picked.namespace}
              </span>
              {picked.operation_id && (
                <span className="text-slate-600 font-mono">
                  {picked.operation_id}
                </span>
              )}
              {picked.docs_url && (
                <a
                  href={picked.docs_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-400 hover:text-sky-300 ml-auto"
                >
                  Verkada docs ↗
                </a>
              )}
            </div>
            <Responses detail={detail.data ?? null} />

            {pathParams.map((p) => (
              <Field key={p.name} p={p} required>
                <input
                  value={pathValues[p.name] ?? ""}
                  onChange={(e) =>
                    setPathValues({ ...pathValues, [p.name]: e.target.value })
                  }
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
                />
              </Field>
            ))}

            {queryParams.map((p) => (
              <Field key={p.name} p={p} required={!!p.required}>
                {p.schema?.enum ? (
                  <select
                    value={queryValues[p.name] ?? ""}
                    onChange={(e) =>
                      setQueryValues({ ...queryValues, [p.name]: e.target.value })
                    }
                    className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  >
                    <option value="">— unset —</option>
                    {p.schema.enum.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={queryValues[p.name] ?? ""}
                    onChange={(e) =>
                      setQueryValues({ ...queryValues, [p.name]: e.target.value })
                    }
                    placeholder={p.schema?.type ?? ""}
                    className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
                  />
                )}
              </Field>
            ))}

            {isWrite && bodyParams.length > 0 && !rawMode && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-slate-500">
                    Body
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      // Seed the editor from whatever is filled in, so
                      // switching to raw is a continuation rather than
                      // starting over.
                      setBodyText(
                        JSON.stringify(
                          Object.fromEntries(
                            bodyParams
                              .filter((f) => (bodyValues[f.name] ?? "").trim() !== "")
                              .map((f) => [
                                f.name,
                                coerce(bodyValues[f.name]!.trim(), f.type),
                              ]),
                          ),
                          null,
                          2,
                        ),
                      );
                      setRawMode(true);
                    }}
                    className="text-[11px] text-sky-400 hover:text-sky-300"
                  >
                    edit as JSON
                  </button>
                </div>
                {bodyParams.map((f) => (
                  <label key={f.name} className="block">
                    <div className="text-xs text-slate-300">
                      {f.name}
                      {f.required && <span className="text-rose-400 ml-0.5">*</span>}
                      <span className="text-slate-600 font-mono ml-1.5 text-[10px]">
                        {f.type}
                      </span>
                    </div>
                    {f.enum ? (
                      <select
                        value={bodyValues[f.name] ?? ""}
                        onChange={(e) =>
                          setBodyValues({ ...bodyValues, [f.name]: e.target.value })
                        }
                        className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm mt-0.5"
                      >
                        <option value="">— unset —</option>
                        {f.enum.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={bodyValues[f.name] ?? ""}
                        onChange={(e) =>
                          setBodyValues({ ...bodyValues, [f.name]: e.target.value })
                        }
                        placeholder={f.type}
                        className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono mt-0.5"
                      />
                    )}
                    {f.description && (
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {f.description}
                      </div>
                    )}
                  </label>
                ))}
                {bodyError && (
                  <div className="text-[11px] text-rose-300">{bodyError}</div>
                )}
              </div>
            )}

            {isWrite && (bodyParams.length === 0 || rawMode) && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-slate-300">Body</span>
                  {bodyParams.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setRawMode(false)}
                      className="text-[11px] text-sky-400 hover:text-sky-300"
                    >
                      back to fields
                    </button>
                  )}
                </div>
                <textarea
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder="{ }"
                  className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/15 text-xs font-mono resize-y"
                />
                {bodyError && (
                  <div className="text-[11px] text-rose-300 mt-1">{bodyError}</div>
                )}
              </div>
            )}

            {verkada.length > 1 && (
              <select
                value={connId}
                onChange={(e) => setConnId(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs"
              >
                <option value="">First Verkada connection</option>
                {verkada.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}

            {isWrite && (
              <label className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2">
                <input
                  type="checkbox"
                  checked={armed}
                  onChange={(e) => setArmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-[11px] text-amber-200">
                  A <b>{method}</b> changes something in your org and vFusion
                  cannot undo it.
                </span>
              </label>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onRun}
                disabled={run.isPending || missing.length > 0 || (isWrite && !armed)}
                className="px-4 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white text-sm disabled:opacity-40"
              >
                {run.isPending ? "Running…" : "Run"}
              </button>
              {missing.length > 0 && (
                <span className="text-[11px] text-slate-500">
                  needs {missing.map((p) => p.name).join(", ")}
                </span>
              )}
            </div>
          </div>

          <div>
            {run.error && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">
                {(run.error as Error).message}
              </div>
            )}
            {run.data && (
              <div className="rounded-lg border border-white/15 bg-white/5 overflow-hidden">
                <div className="flex items-center gap-3 px-3 py-2 border-b border-white/10">
                  <span
                    className={`text-sm font-mono px-2 py-0.5 rounded ${
                      run.data.ok
                        ? "bg-emerald-900/50 text-emerald-300"
                        : "bg-rose-900/50 text-rose-300"
                    }`}
                  >
                    {run.data.status_code ?? "—"}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {run.data.elapsed_ms} ms
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void copyToClipboard(
                        JSON.stringify(run.data?.body ?? {}, null, 2),
                      ).then((ok) => setCopied(ok));
                    }}
                    className="ml-auto text-[11px] text-slate-400 hover:text-slate-200"
                  >
                    {copied ? "copied" : "copy JSON"}
                  </button>
                </div>
                {run.data.error ? (
                  <div className="p-3 text-sm text-rose-200">{run.data.error}</div>
                ) : (
                  <div className="p-3 max-h-[30rem] overflow-auto text-xs">
                    <JsonView value={run.data.body} />
                  </div>
                )}
                {run.data.status_code === 403 && (
                  <div className="px-3 pb-3 text-[11px] text-amber-300">
                    Verkada answers 403 both for a key without the scope and for
                    a path it does not serve, so this does not tell you which.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

/** What the endpoint says it can return. A status you did not expect is
 *  worth being able to look up without leaving the page. */
function Responses({ detail }: { detail: ApiEndpointDetail | null }) {
  const raw = detail?.raw as
    | { responses?: Record<string, { description?: string }> }
    | undefined;
  const responses = raw?.responses;
  if (!responses || Object.keys(responses).length === 0) return null;
  return (
    <div className="pt-1">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">
        Responses
      </div>
      <div className="space-y-0.5">
        {Object.entries(responses).map(([code, r]) => (
          <div key={code} className="flex gap-2 text-[11px]">
            <span
              className={`font-mono w-8 shrink-0 ${
                code.startsWith("2") ? "text-emerald-400" : "text-slate-500"
              }`}
            >
              {code}
            </span>
            <span className="text-slate-500">{plain(r.description) || "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({
  p,
  required,
  children,
}: {
  p: Param;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs text-slate-300 mb-0.5">
        {p.name}
        {required && <span className="text-rose-400 ml-0.5">*</span>}
        {p.schema?.type && (
          <span className="text-slate-600 font-mono ml-1.5 text-[10px]">
            {p.schema.type}
          </span>
        )}
      </div>
      {children}
      {p.description && (
        <div className="text-[11px] text-slate-500 mt-0.5">
          {plain(p.description)}
        </div>
      )}
    </label>
  );
}
