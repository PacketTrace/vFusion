import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { apiPost } from "../lib/api";

type McpToolLike = {
  name: string;
  inputSchema?: { required?: string[] };
};

type CallResult = {
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
};

type SkillSummary = { name: string; summary?: string };

// Some servers publish prose playbooks alongside their tools — guidance a
// model is told to read before calling anything, carrying units, defaults
// and gotchas that don't fit in a tool description. There's no protocol
// slot for that, so it arrives as an ordinary pair of read-only tools:
// one that lists them, one that returns a chosen one as markdown. Detect
// that pair by name; if the server doesn't have it, this panel stays out
// of the way.
export function findPlaybookTools(tools: McpToolLike[]) {
  const list = tools.find((t) => /_skills$/.test(t.name));
  const load = tools.find((t) => /^load_.*_skill$/.test(t.name));
  return list && load ? { list, load } : null;
}

// The first text block is the payload for both calls; the list returns
// JSON in it, a loaded playbook returns markdown.
function firstText(r: CallResult): string {
  return r.result?.content?.find((c) => c.type === "text")?.text ?? "";
}

// Fill the arguments a tool declares required. `chat_session_id` is
// bookkeeping every Verkada tool takes — "new" starts one. Any other
// required parameter is the one naming the thing we want.
function argsFor(tool: McpToolLike, value?: string): Record<string, string> {
  const required = tool.inputSchema?.required ?? [];
  const args: Record<string, string> = {};
  for (const key of required) {
    if (key === "chat_session_id") args[key] = "new";
    else if (value !== undefined) args[key] = value;
  }
  return args;
}

export default function McpPlaybooks({ tools }: { tools: McpToolLike[] }) {
  const pair = findPlaybookTools(tools);
  const [open, setOpen] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["mcp-playbooks", pair?.list.name],
    enabled: !!pair,
    retry: false,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const res = await apiPost<CallResult>("/api/mcp/call", {
        name: pair!.list.name,
        arguments: argsFor(pair!.list),
      });
      const parsed = JSON.parse(firstText(res) || "{}");
      return (parsed.skills ?? []) as SkillSummary[];
    },
  });

  const load = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiPost<CallResult>("/api/mcp/call", {
        name: pair!.load.name,
        arguments: argsFor(pair!.load, name),
      });
      return firstText(res);
    },
  });

  if (!pair) {
    return (
      <div className="text-sm text-slate-500">
        This server doesn't publish playbooks.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
      <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
        <div className="px-3 py-2 border-b border-white/10 text-[11px] uppercase tracking-wide text-slate-500">
          {list.data?.length ?? 0} playbooks · via {pair.list.name}
        </div>
        {list.isLoading && (
          <div className="px-3 py-4 text-sm text-slate-500">Loading…</div>
        )}
        {list.isError && (
          <div className="px-3 py-4 text-sm text-rose-300">
            {(list.error as Error).message}
          </div>
        )}
        <div className="max-h-[62vh] overflow-y-auto">
          {(list.data ?? []).map((s) => (
            <button
              key={s.name}
              onClick={() => {
                setOpen(s.name);
                load.mutate(s.name);
              }}
              className={`w-full text-left px-3 py-2 border-b border-white/5 hover:bg-white/5 ${
                open === s.name ? "bg-white/10" : ""
              }`}
            >
              <div className="font-mono text-[12px] text-slate-200">{s.name}</div>
              {s.summary && (
                <div className="text-[11.5px] text-slate-400 mt-0.5 leading-snug">
                  {s.summary}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-4 min-h-[300px]">
        {!open && (
          <div className="text-slate-500 text-sm">
            Pick a playbook. These are the guides the server tells a model to
            read before it calls anything — the units, defaults and traps that
            aren't in the tool descriptions.
          </div>
        )}
        {open && load.isPending && (
          <div className="text-slate-500 text-sm">Loading {open}…</div>
        )}
        {open && load.isError && (
          <div className="text-rose-300 text-sm">
            {(load.error as Error).message}
          </div>
        )}
        {open && load.data && (
          <>
            <div className="font-mono text-sm text-white mb-3">{open}</div>
            <pre className="text-[12.5px] leading-relaxed text-slate-300 whitespace-pre-wrap font-sans">
              {load.data}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
