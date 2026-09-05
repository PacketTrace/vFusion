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
  BuiltinAnalytic,
  SavedAnalytic,
} from "../lib/api";
import AnalyticEditor from "../components/AnalyticEditor";
import ConfirmDialog from "../components/ConfirmDialog";
import HelixBootstrapModal from "../components/HelixBootstrapModal";
import TemplateSummaryStrip from "../components/TemplateSummaryStrip";


// Curated tag colors per product line. Templates whose tags aren't in
// this map fall back to a neutral chip. New tag families can be added
// without touching any other code — anything declared in template
// JSONs but not listed here just gets the default styling.
//
// The taxonomy is product-line oriented (Cameras, Access control,
// Gemini Vision) rather than trigger-axis (Schedule/Webhook) — the
// trigger type already shows up in the action icons + the trigger
// node's filter pills, so duplicating it as a tag was just noise.
const TAG_STYLE: Record<string, string> = {
  Cameras: "bg-sky-900/60 text-sky-200 border-sky-800",
  "Access control": "bg-rose-900/60 text-rose-200 border-rose-800",
  "Gemini Vision": "bg-violet-900/60 text-violet-200 border-violet-800",
  Alarms: "bg-orange-900/60 text-orange-200 border-orange-800",
  Sensors: "bg-amber-900/60 text-amber-200 border-amber-800",
  Intercoms: "bg-pink-900/60 text-pink-200 border-pink-800",
  LPR: "bg-emerald-900/60 text-emerald-200 border-emerald-800",
};

const DEFAULT_TAG_STYLE =
  "bg-white/10 text-slate-300 border-white/15";


export default function Templates({
  embedded = false,
  show = "both",
}: {
  embedded?: boolean;
  // Which kind of starting point to render. Automate gives each its own
  // tab; "both" keeps the standalone page whole.
  show?: "both" | "flows" | "analytics";
}) {
  const flows = show === "both" || show === "flows";
  const analytics = show === "both" || show === "analytics";
  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-semibold text-white">Templates</h1>
          <p className="text-slate-400 text-sm mt-1">
            Starting points you can use as-is: complete flows, pre-wired with a
            trigger and AI analysis, and the analytics you have composed —
            prompts kept with the Helix event type they write into.
          </p>
        </div>
      )}
      {/* A flow template is a whole automation — trigger, analysis,
          Helix write — while an analytic is only the "what to look for"
          half, which you point at a camera in Build or drop into a step
          of your own. Related enough to live together, different enough
          in kind that stacking them read as one long list of unlike
          things. Hence a tab each. */}
      {flows &&
        (embedded ? (
          <FlowTemplatesPanel />
        ) : (
          <Section
            title="Flows"
            blurb="Complete automations. Install one and it becomes a flow you own."
          >
            <FlowTemplatesPanel />
          </Section>
        ))}
      {analytics &&
        (embedded ? (
          <AnalyticsPanel />
        ) : (
          <Section
            title="Analytics"
            blurb="Just a prompt and the Helix event type it writes into — no trigger. Run one in Build, or pick it inside a flow's analysis step."
          >
            <AnalyticsPanel />
          </Section>
        ))}
    </div>
  );
}


function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-white/10 pb-2">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <p className="text-[11px] text-slate-500">{blurb}</p>
      </div>
      {children}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Analytics panel — prompts composed in Build, kept with their pairing
// ---------------------------------------------------------------------------

function AnalyticsPanel() {
  const navigate = useNavigate();
  // Editing happens here rather than on the bench. Changing a name or a
  // line of prompt should not cost you the list you were working
  // through and the trip back to it.
  const [editing, setEditing] = useState<SavedAnalytic | null>(null);
  const [editingBuiltin, setEditingBuiltin] = useState<BuiltinAnalytic | null>(
    null,
  );
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<SavedAnalytic | null>(null);

  const list = useQuery({
    queryKey: ["byoa-analytics"],
    queryFn: () => apiGet<SavedAnalytic[]>("/api/byoa/analytics"),
  });
  // The prompts that ship with the product. The endpoint has always
  // described these as "shown on the Templates page as read-only
  // starting points" — this page just never asked for them, so a fresh
  // install showed "no saved analytics yet" while five perfectly good
  // ones sat in the code.
  const builtins = useQuery({
    queryKey: ["prompt-template-builtins"],
    queryFn: () => apiGet<BuiltinAnalytic[]>("/api/prompt-templates/builtins"),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/byoa/analytics/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["byoa-analytics"] }),
  });

  if (list.isLoading || builtins.isLoading) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }
  const saved = list.data ?? [];
  const shipped = builtins.data ?? [];

  return (
    <>
      {editing && (
        <AnalyticEditor
          analytic={editing}
          onClose={() => setEditing(null)}
          onOpenInBuild={() =>
            navigate(`/workbench?tab=analytics&analytic=${editing.id}`)
          }
        />
      )}
      {editingBuiltin && (
        <AnalyticEditor
          builtin={editingBuiltin}
          onClose={() => setEditingBuiltin(null)}
          onOpenInBuild={() =>
            navigate(
              `/workbench?tab=analytics&builtin=${encodeURIComponent(editingBuiltin.name)}`,
            )
          }
        />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete "${pendingDelete?.name ?? ""}"?`}
        body="The prompt and its Helix pairing go. Flows already using it keep their own copy, and the event type stays on your Verkada org."
        busy={del.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) del.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
      {shipped.length > 0 && (
        <div className="mb-5">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
            Built in
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {shipped.map((b) => (
              <div
                key={b.name}
                className="border border-white/10 rounded-lg bg-white/[0.03] p-3 flex flex-col gap-2"
              >
                <div className="text-sm font-medium text-slate-100 leading-tight">
                  {b.name}
                </div>
                {b.helix_event_type?.name && (
                  <div className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60 self-start">
                    🧬 {b.helix_event_type.name}
                  </div>
                )}
                <p className="text-[11px] text-slate-500 font-mono line-clamp-3 whitespace-pre-wrap">
                  {b.value}
                </p>
                {/* No delete — these live in the code. Opening one in
                    Build is the way to make it yours: edit it there and
                    save, and the copy lands below as your own. */}
                <button
                  type="button"
                  onClick={() => setEditingBuiltin(b)}
                  className="text-xs px-2 py-1 rounded border border-white/15 text-slate-200 hover:border-sky-600 self-start mt-auto"
                >
                  Edit
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
        Yours
      </div>
      {saved.length === 0 && (
        <div className="border border-white/15 rounded-lg bg-white/5 p-6 text-sm text-slate-400">
          <p className="font-medium text-slate-200 mb-1">
            None of your own yet.
          </p>
          <p>
            Describe what you want spotted on{" "}
            <button
              type="button"
              onClick={() => navigate("/workbench?tab=byoa")}
              className="text-sky-400 hover:underline"
            >
              Build
            </button>{" "}
            and save the result — it lands here. Or open one above and edit it.
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {saved.map((a) => (
          <div
            key={a.id}
            className="border border-white/15 rounded-lg bg-white/5 p-3 flex flex-col gap-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-100 leading-tight">
                  {a.name}
                </div>
                {a.summary && (
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {a.summary}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPendingDelete(a)}
                title="Delete this analytic"
                className="text-xs px-2 py-1 rounded border border-white/15 text-slate-400 hover:text-rose-300 hover:border-rose-800 shrink-0"
              >
                Delete
              </button>
            </div>
            {a.helix_event_type?.name && (
              <div className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60 self-start">
                🧬 {a.helix_event_type.name}
              </div>
            )}
            {/* The prompt is the analytic. A few lines of it separate two
                similarly-named entries in a way the name alone cannot. */}
            <p className="text-[11px] text-slate-500 font-mono line-clamp-3 whitespace-pre-wrap">
              {a.prompt}
            </p>
            <button
              type="button"
              onClick={() => setEditing(a)}
              className="text-xs px-2 py-1 rounded border border-white/15 text-slate-200 hover:border-sky-600 self-start mt-auto"
            >
              Edit
            </button>
          </div>
        ))}
      </div>
    </>
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

  const finalizeApply = async (
    id: string,
    uidMap: Record<string, string>,
    verkadaConnectionId: string,
  ) => {
    setBusyId(id);
    setErr(null);
    try {
      // apply strips positions + auto-rebinds connection slots
      // server-side. We forward the Verkada connection the operator
      // picked in the bootstrap modal so every verkada-typed
      // connection_id in the template is wired to *that* org rather
      // than left null (or, on a deploy with one Verkada conn,
      // silently rebound to it). Imported / template-applied flows
      // start disabled — the user reviews + enables once they've
      // wired everything up.
      const created = await apiPost<{ id: string }>(
        `/api/flow-templates/${id}/apply`,
        {
          helix_uid_map: uidMap,
          verkada_connection_id: verkadaConnectionId || null,
        },
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
    // No-bootstrap fallback path — template doesn't ship Helix defs
    // (or the peek lookup blew up). We can't ask the operator to
    // pick a Verkada connection without the modal, so pass "" and
    // let the backend fall back to the legacy single-connection
    // heuristic. Multi-connection deploys see a null slot; same
    // behavior as before this fix.
    await finalizeApply(id, {}, "");
  };

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/flow-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow-templates"] }),
  });

  // Tag filter — empty Set means "show everything". When the operator
  // clicks a tag chip in the filter bar we toggle membership; templates
  // are visible only if they carry *every* selected tag (AND semantics),
  // so two filters narrow the list together rather than expanding it.
  //
  // ALL hooks must run on every render — keep this above the early
  // returns below or React's hook-order rules trip.
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

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

  // Collect every tag that appears on any template so the filter bar
  // shows real options (not a hardcoded list that can drift from
  // template JSONs). Sorted alphabetically for stable order.
  const allTags = Array.from(
    new Set(list.data.flatMap((t) => t.tags ?? [])),
  ).sort();

  const visible = list.data.filter((t) => {
    if (activeTags.size === 0) return true;
    const tagSet = new Set(t.tags ?? []);
    for (const wanted of activeTags) {
      if (!tagSet.has(wanted)) return false;
    }
    return true;
  });

  const toggleTag = (tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  return (
    <div className="space-y-4">
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

      {allTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-slate-500">Filter:</span>
          {allTags.map((tag) => {
            const active = activeTags.has(tag);
            const baseStyle = TAG_STYLE[tag] ?? DEFAULT_TAG_STYLE;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                className={`px-2 py-0.5 rounded border transition-opacity ${baseStyle} ${active ? "ring-2 ring-white/40" : "opacity-60 hover:opacity-100"}`}
              >
                {tag}
              </button>
            );
          })}
          {activeTags.size > 0 && (
            <button
              type="button"
              onClick={() => setActiveTags(new Set())}
              className="text-slate-400 hover:text-slate-200 underline underline-offset-2 text-[11px]"
            >
              clear
            </button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4">
          No templates match the selected tags. Clear filters to see everything.
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {visible.map((tpl) => (
            <div
              key={tpl.id}
              className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-3 flex flex-col gap-2"
            >
              <div>
                {/* Title row: name, "yours" badge, and tag chips share
                    one wrapping line so a short-name template doesn't
                    waste two rows. */}
                {/* Title row carries the name, "yours" badge, tag
                    chips, AND the primary "Use" / Delete actions —
                    pulling them up here reclaims the entire bottom
                    row that used to sit empty between the summary
                    strip and the buttons. ``ml-auto`` pushes the
                    action cluster to the right edge so the title
                    stays at the leading edge. */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="text-sm font-medium text-slate-100">
                    {tpl.name}
                  </div>
                  {tpl.source === "user" && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-200">
                      yours
                    </span>
                  )}
                  {tpl.tags?.map((tag) => (
                    <span
                      key={tag}
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${TAG_STYLE[tag] ?? DEFAULT_TAG_STYLE}`}
                    >
                      {tag}
                    </span>
                  ))}
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={() => useTemplate(tpl.id)}
                      disabled={busyId !== null}
                      className="text-xs px-2.5 py-1 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
                    >
                      {busyId === tpl.id ? "Creating…" : "Use"}
                    </button>
                    {tpl.source === "user" && (
                      <button
                        onClick={() => {
                          if (confirm(`Delete template "${tpl.name}"?`)) {
                            deleteTemplate.mutate(tpl.id);
                          }
                        }}
                        disabled={deleteTemplate.isPending}
                        className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-rose-300 hover:border-rose-700 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
                {/* Tagline + a tiny inline Details disclosure. The
                    long description lives behind the disclosure so
                    the card stays scannable on a demo. */}
                {tpl.tagline ? (
                  <div className="text-[13px] text-slate-200 mt-1.5 leading-snug">
                    {tpl.tagline}
                    {tpl.description && tpl.description !== tpl.tagline && (
                      <details className="inline ml-1.5 text-[11px] text-slate-400 align-baseline">
                        <summary className="cursor-pointer inline text-slate-500 hover:text-slate-300 select-none">
                          Details
                        </summary>
                        <div className="mt-1 leading-relaxed">{tpl.description}</div>
                      </details>
                    )}
                  </div>
                ) : (
                  tpl.description && (
                    <div className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                      {tpl.description}
                    </div>
                  )
                )}
                {tpl.summary_steps && tpl.summary_steps.length > 0 ? (
                  // No wrapper background — the strip sits directly
                  // on the card surface so the animated chain reads
                  // as part of the card, not a framed sub-panel.
                  // ``-mx-1`` lets the spotlight glow on the first
                  // / last pill peek into the card's own padding.
                  <div className="mt-1 -mx-1" title={tpl.summary ?? undefined}>
                    <TemplateSummaryStrip steps={tpl.summary_steps} />
                  </div>
                ) : (
                  tpl.summary && (
                    <div className="mt-1.5 text-[11px] font-mono text-slate-500 bg-black/30/60 rounded px-2 py-1 border border-white/5">
                      {tpl.summary}
                    </div>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {pendingApply && (
        <HelixBootstrapModal
          defs={pendingApply.defs}
          intent="apply"
          onCancel={() => setPendingApply(null)}
          onConfirm={(uidMap, connId) =>
            finalizeApply(pendingApply.id, uidMap, connId)
          }
        />
      )}
    </div>
  );
}


