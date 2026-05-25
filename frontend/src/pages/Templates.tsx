import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import {
  apiDelete,
  apiGet,
  apiPost,
  FlowTemplateDetail,
  FlowTemplateListItem,
  HelixEventTypeDef,
} from "../lib/api";
import HelixBootstrapModal from "../components/HelixBootstrapModal";


// Display order for category headers. Categories not in this list fall
// through to the end alphabetically so operator-saved templates always
// have a home even if they pick a novel category name.
const CATEGORY_ORDER: string[] = [
  "3rd Party Analytics",
  "Access automation",
  "Scheduled",
  "AI analytics", // legacy; absorbed by 3rd Party Analytics, kept for back-compat
];


export default function Templates() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Templates</h1>
        <p className="text-slate-300 text-sm mt-1">
          Starter flows you can use as-is. Each template ships pre-wired with
          a trigger, AI analysis, and (where relevant) a Helix event type so
          the result lands in Verkada Command without extra plumbing.
        </p>
      </div>
      <FlowTemplatesPanel />
    </div>
  );
}


// ---------------------------------------------------------------------------
// Flow templates panel — built-in starter flows
// ---------------------------------------------------------------------------

function FlowTemplatesPanel() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["flow-templates"],
    queryFn: () => apiGet<FlowTemplateListItem[]>("/api/flow-templates"),
  });

  // When the picked template embeds Helix type defs, we hold its id +
  // defs here and let the modal collect a uid_map before the actual
  // /apply POST runs. ``null`` means no modal is open.
  const [pendingApply, setPendingApply] = useState<
    { id: string; defs: HelixEventTypeDef[] } | null
  >(null);

  const finalizeApply = async (id: string, uidMap: Record<string, string>) => {
    setBusyId(id);
    setErr(null);
    try {
      // apply strips positions + auto-rebinds obvious connection slots
      // server-side, so the frontend stays a thin shell. Imported /
      // template-applied flows start disabled — the user reviews +
      // enables once they've wired everything up.
      const created = await apiPost<{ id: string }>(
        `/api/flow-templates/${id}/apply`,
        { helix_uid_map: uidMap },
      );
      navigate(`/flows/${created.id}/edit`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setPendingApply(null);
    }
  };

  const useTemplate = async (id: string) => {
    setErr(null);
    // Peek at the template body first. If it embeds Helix event-type
    // defs, route through the bootstrap modal so the operator can
    // recreate any missing ones on their Verkada org before apply.
    setBusyId(id);
    try {
      const detail = await apiGet<FlowTemplateDetail>(`/api/flow-templates/${id}`);
      const defs = detail.flow.helix_event_types ?? [];
      if (defs.length > 0) {
        setBusyId(null);
        setPendingApply({ id, defs });
        return;
      }
    } catch (e) {
      // Detail lookup failed — fall through to a plain apply so we
      // don't block on a transient fetch error. The apply call will
      // surface a clearer message if anything's actually broken.
      console.warn("template detail fetch failed; applying without bootstrap", e);
    }
    await finalizeApply(id, {});
  };

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/flow-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow-templates"] }),
  });

  if (list.isLoading) {
    return <div className="text-sm text-slate-400">Loading…</div>;
  }
  if (!list.data || list.data.length === 0) {
    return (
      <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-6 text-sm text-slate-400">
        No flow templates available. Drop new JSON files into
        <code className="font-mono mx-1 text-slate-300">backend/app/data/flow_templates/</code>
        and reload.
      </div>
    );
  }

  // Group templates by category so the page reads like a catalog
  // instead of a flat dump. Categories sort by ``CATEGORY_ORDER`` first
  // (so curated buckets like "3rd Party Analytics" lead the page), then
  // alphabetically for anything novel. Built-in templates always come
  // first within a category; user-saved templates land at the end.
  const groups: { category: string; items: FlowTemplateListItem[] }[] = (() => {
    const byCategory = new Map<string, FlowTemplateListItem[]>();
    for (const t of list.data) {
      const cat = t.category || "Other";
      const arr = byCategory.get(cat) ?? [];
      arr.push(t);
      byCategory.set(cat, arr);
    }
    const ordered: { category: string; items: FlowTemplateListItem[] }[] = [];
    const seen = new Set<string>();
    for (const cat of CATEGORY_ORDER) {
      if (byCategory.has(cat)) {
        ordered.push({ category: cat, items: byCategory.get(cat)! });
        seen.add(cat);
      }
    }
    for (const [cat, items] of Array.from(byCategory.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      if (!seen.has(cat)) {
        ordered.push({ category: cat, items });
      }
    }
    return ordered;
  })();

  return (
    <div className="space-y-6">
      <p className="text-xs text-slate-500 leading-relaxed">
        Each template creates a new flow pre-wired with the right trigger,
        actions, and conditions. Connections (Verkada org, Gemini key, Helix
        event type) start empty — pick them in the editor, then enable.
      </p>
      {err && (
        <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
          {err}
        </div>
      )}
      {groups.map((g) => (
        <section key={g.category} className="space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-slate-400 font-semibold border-b border-white/10 pb-1.5">
            {g.category}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {g.items.map((tpl) => (
              <div
                key={tpl.id}
                className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4 flex flex-col gap-3"
              >
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-sm font-medium text-slate-100">
                      {tpl.name}
                    </div>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-300">
                      {tpl.trigger_type === "schedule" ? "schedule" : "webhook"}
                    </span>
                    {tpl.source === "user" && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-200">
                        yours
                      </span>
                    )}
                  </div>
                  {tpl.description && (
                    <div className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                      {tpl.description}
                    </div>
                  )}
                  {tpl.summary && (
                    <div className="mt-2 text-[11px] font-mono text-slate-500 bg-slate-950/60 rounded px-2 py-1 border border-white/5">
                      {tpl.summary}
                    </div>
                  )}
                </div>
                <div className="mt-auto flex items-center gap-2">
                  <button
                    onClick={() => useTemplate(tpl.id)}
                    disabled={busyId !== null}
                    className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
                  >
                    {busyId === tpl.id ? "Creating…" : "Use this template"}
                  </button>
                  {tpl.source === "user" && (
                    <button
                      onClick={() => {
                        if (confirm(`Delete template "${tpl.name}"?`)) {
                          deleteTemplate.mutate(tpl.id);
                        }
                      }}
                      disabled={deleteTemplate.isPending}
                      className="text-xs px-2 py-1.5 rounded border border-white/15 text-slate-300 hover:text-rose-300 hover:border-rose-700 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {pendingApply && (
        <HelixBootstrapModal
          defs={pendingApply.defs}
          onCancel={() => setPendingApply(null)}
          onConfirm={(uidMap) => finalizeApply(pendingApply.id, uidMap)}
        />
      )}
    </div>
  );
}


