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

const SUGGESTIONS = ["door", "camera", "unlock", "user", "helix", "alarm", "sensor"];

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

  const hits = useMemo(() => {
    const items = all.data?.items ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
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
      })
      .slice(0, 40);
  }, [all.data, q]);

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
    <div className="space-y-3">
      {/* Search is the interface. Everything else appears in response
          to it. */}
      <div className="relative">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          placeholder={
            all.data
              ? `Search ${all.data.total} Verkada endpoints — try "door", "unlock", "what a camera saw"…`
              : all.isLoading
                ? "Loading the catalog…"
                : "The catalog could not be loaded"
          }
          className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm px-2"
          >
            ×
          </button>
        )}
      </div>

      {all.error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">
          Could not load the endpoint catalog: {(all.error as Error).message}
        </div>
      )}

      {all.data && all.data.total === 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
          The catalog is empty — nothing has been crawled from Verkada yet.
          It syncs every four hours, or trigger it now from{" "}
          <b>MCP &rsaquo; Verkada API catalog</b>.
        </div>
      )}

      {!q && !all.error && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500">Try:</span>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setQ(s)}
              className="text-[11px] px-2 py-1 rounded border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {q && (
        <div className="rounded-lg border border-white/15 bg-white/5 divide-y divide-white/5 max-h-64 overflow-y-auto">
          {hits.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">
              Nothing matches “{q}” in {all.data?.total ?? 0} endpoints. Try a
              word from the URL or the summary — Verkada names things its own
              way, so “Helix” lives under video_tagging and plates under lpr.
            </div>
          )}
          {hits.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => choose(e)}
              className={`w-full text-left px-3 py-2 hover:bg-white/5 flex items-baseline gap-2 ${
                picked?.id === e.id ? "bg-sky-900/20" : ""
              }`}
            >
              <span
                className={`text-[10px] font-mono w-14 shrink-0 ${
                  METHOD_COLOR[e.method] ?? "text-slate-400"
                }`}
              >
                {e.method}
              </span>
              <span className="font-mono text-xs text-slate-200 break-all">
                {e.path}
              </span>
              {e.summary && (
                <span className="text-[11px] text-slate-500 truncate ml-auto pl-3 shrink-0 max-w-[45%]">
                  {e.summary}
                </span>
              )}
            </button>
          ))}
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
              <p className="text-[11px] text-slate-400">{picked.summary}</p>
            )}

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
