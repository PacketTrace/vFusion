import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import EndpointPicker from "../components/EndpointPicker";
import JsonView from "../components/JsonView";
import { ApiEndpointDetail, apiGet, apiPost, Connection } from "../lib/api";

/**
 * Run any Verkada endpoint, without leaving vFusion or pasting a key
 * into something else.
 *
 * The form is built from the catalog's own parameter schema rather than
 * written by hand, so it covers every endpoint the crawler has seen and
 * gains new ones the day Verkada ships them. A hand-maintained list
 * would be wrong within a month and wrong silently.
 *
 * Reads and writes look different on purpose. Listing cameras and
 * unlocking a door are one dropdown apart here, and the second one
 * should not be one click.
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
  is_write?: boolean;
}

interface Param {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string; enum?: string[]; default?: unknown };
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const METHOD_COLOR: Record<string, string> = {
  GET: "bg-sky-900/50 text-sky-300 border-sky-800/60",
  POST: "bg-emerald-900/50 text-emerald-300 border-emerald-800/60",
  PUT: "bg-amber-900/50 text-amber-300 border-amber-800/60",
  PATCH: "bg-amber-900/50 text-amber-300 border-amber-800/60",
  DELETE: "bg-rose-900/50 text-rose-300 border-rose-800/60",
};

/** Pull parameters out of the resolved OpenAPI operation. */
function paramsOf(detail: ApiEndpointDetail | null): Param[] {
  const raw = detail?.raw as { parameters?: Param[] } | undefined;
  return Array.isArray(raw?.parameters) ? raw!.parameters! : [];
}

/** The example request body, if the spec carries one. Beats an empty
 *  editor: most of these have required fields you would otherwise learn
 *  about from a 400. */
function bodyExample(detail: ApiEndpointDetail | null): string {
  const raw = detail?.raw as
    | {
        requestBody?: {
          content?: Record<string, { schema?: Record<string, unknown> }>;
        };
      }
    | undefined;
  const schema = raw?.requestBody?.content?.["application/json"]?.schema;
  if (!schema) return "";
  const props = (schema as { properties?: Record<string, { type?: string }> })
    .properties;
  if (!props) return "{\n  \n}";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] =
      v.type === "number" || v.type === "integer"
        ? 0
        : v.type === "boolean"
          ? false
          : v.type === "array"
            ? []
            : "";
  }
  return JSON.stringify(out, null, 2);
}

export default function ApiRunner() {
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [bodyText, setBodyText] = useState("");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [connId, setConnId] = useState("");
  const [confirmWrite, setConfirmWrite] = useState(false);

  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const verkada = (conns.data ?? []).filter((c) => c.type === "verkada");

  const detail = useQuery({
    queryKey: ["api-endpoint", endpointId],
    queryFn: () =>
      apiGet<ApiEndpointDetail>(`/api/verkada-catalog/endpoints/${endpointId}`),
    enabled: !!endpointId,
  });

  const params = useMemo(() => paramsOf(detail.data ?? null), [detail.data]);
  const pathParams = params.filter((p) => p.in === "path");
  const queryParams = params.filter((p) => p.in === "query");
  const method = (detail.data?.method ?? "GET").toUpperCase();
  const isWrite = WRITE.has(method);

  const run = useMutation({
    mutationFn: () => {
      let parsed: unknown = null;
      if (isWrite && bodyText.trim()) {
        parsed = JSON.parse(bodyText);
      }
      return apiPost<RunResult>("/api/api-runner/run", {
        connection_id: connId || null,
        method,
        path: detail.data?.path,
        path_params: pathValues,
        query: queryValues,
        json_body: parsed,
      });
    },
  });

  function onRun() {
    setBodyError(null);
    if (isWrite && bodyText.trim()) {
      try {
        JSON.parse(bodyText);
      } catch (e) {
        // Caught here rather than at the server: a JSON typo is the
        // operator's, and round-tripping it just to be told so is slower
        // and less specific.
        setBodyError(`That body is not valid JSON: ${(e as Error).message}`);
        return;
      }
    }
    run.mutate();
  }

  const missing = pathParams.filter((p) => !pathValues[p.name]?.trim());

  return (
    <div className="space-y-4">
      <div className="max-w-4xl">
        <p className="text-slate-400 text-sm">
          Run any endpoint the catalog knows about, against a connection you
          already have. The form is built from Verkada&rsquo;s own schema, so it
          covers everything the crawler has seen.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="rounded-lg border border-white/15 bg-white/5 p-3 space-y-3">
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">Endpoint</div>
              <EndpointPicker
                value={endpointId}
                onChange={(ep) => {
                  setEndpointId(ep?.id ?? null);
                  setPathValues({});
                  setQueryValues({});
                  setBodyText("");
                  setConfirmWrite(false);
                  run.reset();
                }}
              />
            </label>

            {verkada.length > 1 && (
              <label className="block">
                <div className="text-xs text-slate-300 mb-1">Run as</div>
                <select
                  value={connId}
                  onChange={(e) => setConnId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                >
                  <option value="">First Verkada connection</option>
                  {verkada.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {detail.data && (
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`text-[11px] font-mono px-1.5 py-0.5 rounded border ${
                    METHOD_COLOR[method] ?? "bg-white/10 text-slate-300 border-white/20"
                  }`}
                >
                  {method}
                </span>
                <span className="font-mono text-xs text-slate-300 break-all">
                  {detail.data.path}
                </span>
              </div>
            )}
            {detail.data?.summary && (
              <p className="text-xs text-slate-400">{detail.data.summary}</p>
            )}
          </div>

          {pathParams.length > 0 && (
            <Group title="Path">
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
            </Group>
          )}

          {queryParams.length > 0 && (
            <Group title="Query">
              {queryParams.map((p) => (
                <Field key={p.name} p={p} required={!!p.required}>
                  {p.schema?.enum ? (
                    <select
                      value={queryValues[p.name] ?? ""}
                      onChange={(e) =>
                        setQueryValues({
                          ...queryValues,
                          [p.name]: e.target.value,
                        })
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
                        setQueryValues({
                          ...queryValues,
                          [p.name]: e.target.value,
                        })
                      }
                      placeholder={p.schema?.type ?? ""}
                      className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
                    />
                  )}
                </Field>
              ))}
            </Group>
          )}

          {isWrite && detail.data && (
            <Group title="Body">
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={8}
                spellCheck={false}
                placeholder={bodyExample(detail.data) || "{ }"}
                className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/15 text-xs font-mono resize-y"
              />
              {bodyExample(detail.data) && !bodyText && (
                <button
                  type="button"
                  onClick={() => setBodyText(bodyExample(detail.data!))}
                  className="text-[11px] px-2 py-1 rounded border border-white/15 text-slate-300 hover:border-sky-600"
                >
                  Fill from the schema
                </button>
              )}
              {bodyError && (
                <div className="text-xs text-rose-300">{bodyError}</div>
              )}
            </Group>
          )}

          {detail.data && (
            <div className="space-y-2">
              {isWrite && (
                <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                  <input
                    type="checkbox"
                    checked={confirmWrite}
                    onChange={(e) => setConfirmWrite(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-xs text-amber-200">
                    This is a <b>{method}</b> — it changes something in your
                    Verkada org, and vFusion cannot undo it. Run it anyway.
                  </span>
                </label>
              )}
              <button
                type="button"
                onClick={onRun}
                disabled={
                  run.isPending || missing.length > 0 || (isWrite && !confirmWrite)
                }
                className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white text-sm disabled:opacity-40"
              >
                {run.isPending ? "Running…" : "Run"}
              </button>
              {missing.length > 0 && (
                <span className="text-xs text-slate-500 ml-3">
                  Needs {missing.map((p) => p.name).join(", ")}.
                </span>
              )}
            </div>
          )}
        </div>

        <div className="space-y-3">
          {run.error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">
              {(run.error as Error).message}
            </div>
          )}
          {run.data && <Result r={run.data} />}
          {!run.data && !run.error && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-sm text-slate-500">
              The response lands here — status, how long it took, and the body
              rendered as something you can read rather than one long line.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Result({ r }: { r: RunResult }) {
  const good = r.ok;
  return (
    <div className="rounded-lg border border-white/15 bg-white/5 overflow-hidden">
      <div className="flex items-center gap-3 flex-wrap px-3 py-2 border-b border-white/10">
        <span
          className={`text-sm font-mono px-2 py-0.5 rounded ${
            good
              ? "bg-emerald-900/50 text-emerald-300"
              : "bg-rose-900/50 text-rose-300"
          }`}
        >
          {r.status_code ?? "—"}
        </span>
        <span className="text-xs text-slate-400 font-mono break-all">
          {r.method} {r.path}
        </span>
        <span className="text-xs text-slate-500 ml-auto">{r.elapsed_ms} ms</span>
      </div>
      {r.error ? (
        <div className="p-3 text-sm text-rose-200">{r.error}</div>
      ) : (
        <div className="p-3 max-h-[32rem] overflow-auto text-xs">
          <JsonView value={r.body} />
        </div>
      )}
      {/* 403 is what Verkada returns for a path it does not recognise as
          well as one your key cannot reach, so the obvious reading is
          wrong about half the time. */}
      {r.status_code === 403 && (
        <div className="px-3 pb-3 text-[11px] text-amber-300">
          A 403 here can mean the key lacks the scope, or that the path is not
          one Verkada serves. It answers the same way for both.
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/15 bg-white/5 p-3 space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">
        {title}
      </div>
      {children}
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
          <span className="text-slate-600 font-mono ml-1.5">{p.schema.type}</span>
        )}
      </div>
      {children}
      {p.description && (
        <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
          {p.description}
        </div>
      )}
    </label>
  );
}
