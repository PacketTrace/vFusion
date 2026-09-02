import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import Collapse from "../components/Collapse";
import McpPlaybooks from "../components/McpPlaybooks";
import { apiGet } from "../lib/api";

// Shape of one entry in an MCP server's tools/list response.
type McpTool = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  // Added by vFusion, not the server: MCP carries no timestamps, so
  // these come from our own record of when each tool first showed up.
  _is_baseline?: boolean;
  _first_seen_at?: string | null;
  _schema_changed_at?: string | null;
};

type Catalog = {
  url: string;
  server_info: { name?: string; version?: string };
  capabilities: Record<string, unknown>;
  instructions: string;
  protocol_version: string;
  requested_protocol_version: string;
  catalog_bytes: number;
  catalog_tokens_estimate: number;
  tools: McpTool[];
  connection_name: string;
  cached: boolean;
  // Tool history, derived from our own observations over time.
  history_since: string | null;
  last_changed_at: string | null;
  new_tools_30d: number;
  tracked_tools: number;
};

// A server's own annotations are the only machine-readable safety signal
// we get, and they're incomplete: plenty of tools carry
// `destructiveHint: false` without claiming `readOnlyHint`, and "not
// destructive" is not the same as "reads nothing" (creating an event
// writes but destroys nothing). So we render three states honestly
// rather than collapsing the unlabelled ones into "safe".
type Risk = "read" | "destructive" | "write";

function riskOf(t: McpTool): Risk {
  const a = t.annotations ?? {};
  if (a.destructiveHint) return "destructive";
  if (a.readOnlyHint) return "read";
  return "write";
}

const RISK_STYLE: Record<Risk, string> = {
  read: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  write: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  destructive: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

const RISK_LABEL: Record<Risk, string> = {
  read: "read-only",
  write: "writes",
  destructive: "destructive",
};

function RiskBadge({ risk }: { risk: Risk }) {
  return (
    <span
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${RISK_STYLE[risk]}`}
    >
      {RISK_LABEL[risk]}
    </span>
  );
}

// Tools are named verb_subject (list_cameras, delete_access_card), so the
// leading verb groups them into something browsable without us having to
// hand-maintain a taxonomy per server.
function familyOf(name: string): string {
  return name.split("_")[0] ?? "other";
}

const fmtDate = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

const isNew30d = (t: McpTool) =>
  !t._is_baseline &&
  !!t._first_seen_at &&
  Date.now() - new Date(t._first_seen_at).getTime() < 30 * 864e5;

/** A titled group of related facts. Three of these beat seven loose cards:
 *  the reader gets "where it connects / what it exposes / what changed"
 *  rather than a flat wall of equally-weighted boxes. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 pb-2 mb-1 border-b border-white/5">
        {title}
      </div>
      <dl className="space-y-2.5">{children}</dl>
    </div>
  );
}

function Fact({
  label,
  children,
  hint,
  title,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="text-slate-100 text-[13px] mt-0.5 break-words">
        {children}
      </dd>
      {hint && (
        <dd className="text-[11px] text-slate-500 mt-0.5">{hint}</dd>
      )}
    </div>
  );
}

export default function Mcp() {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState<Risk | "all">("all");
  const [newOnly, setNewOnly] = useState(false);

  // Refresh has to bypass the backend's 15-minute response cache,
  // otherwise the button re-renders the same catalog and looks broken.
  const force = useRef(false);
  const catalog = useQuery({
    queryKey: ["mcp-catalog"],
    queryFn: () => {
      const bypass = force.current;
      force.current = false;
      return apiGet<Catalog>(
        `/api/mcp/catalog${bypass ? "?refresh=true" : ""}`,
      );
    },
    // The catalog is a remote round-trip through the MCP handshake;
    // don't re-run it on every window focus.
    staleTime: 5 * 60_000,
    retry: false,
  });

  const tools = catalog.data?.tools ?? [];

  const counts = useMemo(() => {
    const c = { read: 0, write: 0, destructive: 0 };
    for (const t of tools) c[riskOf(t)] += 1;
    return c;
  }, [tools]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return tools
      .filter((t) => (riskFilter === "all" ? true : riskOf(t) === riskFilter))
      .filter((t) => (newOnly ? isNew30d(t) : true))
      .filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tools, filter, riskFilter, newOnly]);

  const grouped = useMemo(() => {
    const g = new Map<string, McpTool[]>();
    for (const t of shown) {
      const k = familyOf(t.name);
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(t);
    }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [shown]);

  const active = tools.find((t) => t.name === selected) ?? null;
  const data = catalog.data;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">MCP</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-3xl">
            Browse the tools a Model Context Protocol server exposes — what it
            can do, what each call takes, and what the server tells a model
            about itself. Signs in with your existing Verkada connection; no AI
            credential needed.
          </p>
        </div>
        <button
          onClick={() => {
            force.current = true;
            catalog.refetch();
          }}
          disabled={catalog.isFetching}
          className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 text-sm text-slate-200 disabled:opacity-50 whitespace-nowrap"
        >
          {catalog.isFetching ? "Checking…" : "Check now"}
        </button>
      </div>

      {catalog.isError && (
        <div className="mt-6 rounded-lg border border-rose-500/30 bg-rose-950/30 p-4 text-sm text-rose-200">
          {(catalog.error as Error).message}
        </div>
      )}

      {data && (
        <div className="mt-5 space-y-2">
          <Collapse
            defaultOpen
            title="Server"
            summary={`${data.server_info?.name ?? "unknown"} ${
              data.server_info?.version ?? ""
            } · ${tools.length} tools · protocol ${data.protocol_version || "—"}`}
          >
            <div className="grid gap-3 md:grid-cols-3">
              <Group title="Connection">
                <Fact label="Endpoint">
                  <span className="font-mono text-[12px]">{data.url}</span>
                </Fact>
                <Fact
                  label="Protocol revision"
                  hint="spec version, not a release date"
                  title="MCP protocol revisions are spec version dates. We send the newest we implement; the server answers with one it supports."
                >
                  {data.protocol_version || "—"}
                  {data.requested_protocol_version &&
                    data.requested_protocol_version !==
                      data.protocol_version && (
                      <span className="text-slate-500">
                        {" "}
                        (we asked {data.requested_protocol_version})
                      </span>
                    )}
                </Fact>
                <Fact
                  label="Authenticated as"
                  hint="that connection's key, sent as a bearer token"
                >
                  {data.connection_name}
                </Fact>
                <Fact label="Declared capabilities">
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {Object.keys(data.capabilities ?? {}).length === 0 && (
                      <span className="text-slate-500">none declared</span>
                    )}
                    {Object.entries(data.capabilities ?? {}).map(([k, v]) => {
                      const sub = Object.entries(
                        (v ?? {}) as Record<string, unknown>,
                      )
                        .filter(([, on]) => on === true)
                        .map(([n]) => n);
                      return (
                        <span
                          key={k}
                          className="text-[11px] px-1.5 py-0.5 rounded border border-white/15 text-slate-300"
                        >
                          {k}
                          {sub.length > 0 && (
                            <span className="text-slate-500">
                              {" "}
                              · {sub.join(", ")}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </Fact>
              </Group>

              <Group title="Surface">
                <Fact label="Tools">
                  {tools.length} total
                </Fact>
                <Fact label="By risk">
                  <span className="text-emerald-300">
                    {counts.read} read-only
                  </span>
                  <span className="text-slate-600"> · </span>
                  <span className="text-amber-300">{counts.write} write</span>
                  <span className="text-slate-600"> · </span>
                  <span className="text-rose-300">
                    {counts.destructive} destructive
                  </span>
                </Fact>
                <Fact
                  label="Catalog weight"
                  hint="what it costs per turn to hand every tool to a model"
                  title="Estimated at ~4 characters per token."
                >
                  {(data.catalog_bytes / 1024).toFixed(0)} KB ·{" "}
                  {(data.catalog_tokens_estimate / 1000).toFixed(1)}k tokens
                  <span className="text-slate-500"> (est.)</span>
                </Fact>
              </Group>

              <Group title="Changes">
                <Fact
                  label="Last updated"
                  hint={
                    data.last_changed_at
                      ? "a tool was added, removed or edited"
                      : "nothing has moved since we started watching"
                  }
                  title="MCP publishes no timestamps, so this comes from vFusion's own record of the catalog. It can only reflect changes since we first looked."
                >
                  {fmtDate(data.last_changed_at) ?? "no changes yet"}
                </Fact>
                <Fact label="New in last 30 days">
                  {data.new_tools_30d}
                  {data.new_tools_30d === 0 && (
                    <span className="text-slate-500"> tools</span>
                  )}
                </Fact>
                <Fact
                  label="Watching since"
                  hint={`${data.tracked_tools} tools tracked`}
                >
                  {fmtDate(data.history_since) ?? "—"}
                </Fact>
              </Group>
            </div>
          </Collapse>

          {data.instructions && (
            <Collapse
              title="Server instructions"
              summary={`${data.instructions.length} characters — what this server tells a model on connect`}
            >
              <pre className="text-[12px] leading-relaxed text-slate-300 whitespace-pre-wrap font-mono">
                {data.instructions}
              </pre>
            </Collapse>
          )}

          <Collapse
            title="Tools"
            summary={`${tools.length} · ${counts.read} read-only · ${counts.write} write · ${counts.destructive} destructive${
              data.new_tools_30d ? ` · ${data.new_tools_30d} new in 30d` : ""
            }`}
          >
            <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
              <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
                <div className="p-2.5 border-b border-white/10 space-y-2">
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter tools…"
                    className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  />
                  <div className="flex gap-1.5 text-[11px]">
                    {(["all", "read", "write", "destructive"] as const).map(
                      (r) => (
                        <button
                          key={r}
                          onClick={() => setRiskFilter(r)}
                          className={`px-2 py-1 rounded border transition-colors ${
                            riskFilter === r
                              ? "bg-white/15 border-white/25 text-white"
                              : "bg-transparent border-white/10 text-slate-400 hover:bg-white/5"
                          }`}
                        >
                          {r === "all" ? "all" : RISK_LABEL[r]}
                        </button>
                      ),
                    )}
                    <button
                      onClick={() => setNewOnly((v) => !v)}
                      title="Tools first seen in the last 30 days"
                      className={`px-2 py-1 rounded border transition-colors ${
                        newOnly
                          ? "bg-sky-500/20 border-sky-500/40 text-sky-200"
                          : "bg-transparent border-white/10 text-slate-400 hover:bg-white/5"
                      }`}
                    >
                      new
                    </button>
                  </div>
                </div>
                <div className="max-h-[55vh] overflow-y-auto">
                  {grouped.map(([family, list]) => (
                    <div key={family}>
                      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-slate-500 bg-white/5 sticky top-0">
                        {family} · {list.length}
                      </div>
                      {list.map((t) => (
                        <button
                          key={t.name}
                          onClick={() => setSelected(t.name)}
                          className={`w-full text-left px-3 py-2 border-b border-white/5 hover:bg-white/5 ${
                            selected === t.name ? "bg-white/10" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[12px] text-slate-200 truncate">
                              {t.name}
                            </span>
                            <RiskBadge risk={riskOf(t)} />
                          </div>
                          <div
                            className={`text-[10px] mt-0.5 ${
                              t._is_baseline
                                ? "text-slate-600"
                                : "text-sky-300/80"
                            }`}
                          >
                            {t._is_baseline
                              ? "original"
                              : `added ${fmtDate(t._first_seen_at) ?? "—"}`}
                            {isNew30d(t) && " · new"}
                          </div>
                        </button>
                      ))}
                    </div>
                  ))}
                  {shown.length === 0 && (
                    <div className="px-3 py-6 text-sm text-slate-500 text-center">
                      No tools match.
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/5 p-4 min-h-[300px]">
                {!active && (
                  <div className="text-slate-500 text-sm">
                    Select a tool to see what it does and what it takes.
                  </div>
                )}
                {active && (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="font-mono text-lg text-white">
                        {active.name}
                      </h2>
                      <RiskBadge risk={riskOf(active)} />
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          active._is_baseline
                            ? "border-white/15 text-slate-400"
                            : "border-sky-500/30 bg-sky-500/15 text-sky-300"
                        }`}
                        title={
                          active._is_baseline
                            ? "Present the first time vFusion looked at this server — its real add date predates our records."
                            : "First seen by vFusion on this date."
                        }
                      >
                        {active._is_baseline
                          ? "original"
                          : `added ${fmtDate(active._first_seen_at) ?? "—"}`}
                      </span>
                      {active._schema_changed_at && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded border border-white/15 text-slate-400"
                          title="Description, schema or annotations changed since we first recorded this tool."
                        >
                          edited {fmtDate(active._schema_changed_at)}
                        </span>
                      )}
                      {active.annotations?.idempotentHint && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/15 text-slate-400">
                          idempotent
                        </span>
                      )}
                    </div>
                    {active.description && (
                      <pre className="mt-3 text-[12.5px] leading-relaxed text-slate-300 whitespace-pre-wrap font-sans">
                        {active.description}
                      </pre>
                    )}
                    <div className="mt-4">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">
                        Parameters
                      </div>
                      {(() => {
                        const props = active.inputSchema?.properties ?? {};
                        const required = new Set(
                          active.inputSchema?.required ?? [],
                        );
                        const names = Object.keys(props);
                        if (names.length === 0) {
                          return (
                            <div className="text-sm text-slate-500">
                              Takes no arguments.
                            </div>
                          );
                        }
                        return (
                          <div className="divide-y divide-white/5 border border-white/10 rounded">
                            {names.map((n) => (
                              <div key={n} className="px-3 py-2">
                                <div className="flex items-baseline gap-2">
                                  <span className="font-mono text-[12px] text-slate-200">
                                    {n}
                                  </span>
                                  <span className="text-[11px] text-slate-500">
                                    {props[n]?.type ?? "any"}
                                  </span>
                                  {required.has(n) && (
                                    <span className="text-[10px] text-amber-300">
                                      required
                                    </span>
                                  )}
                                </div>
                                {props[n]?.description && (
                                  <div className="text-[12px] text-slate-400 mt-0.5 whitespace-pre-wrap">
                                    {props[n].description}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  </>
                )}
              </div>
            </div>
          </Collapse>

          <Collapse
            title="Playbooks"
            summary="prose guides the server tells a model to read before it calls anything"
          >
            <McpPlaybooks tools={tools} />
          </Collapse>
        </div>
      )}
    </div>
  );
}
