import { useRef, useState } from "react";

import { API_BASE, apiGet } from "../lib/api";

type EventKind = {
  family: string | null;
  notification_type: string | null;
  camera_id: string | null;
  camera_name: string | null;
  door_name: string | null;
  objects: string[] | null;
  count: number;
  last_seen: string | null;
  sample_event_id: string;
};

type ProposedNode = {
  id?: string;
  name?: string;
  label?: string;
  kind?: string;
  action_type?: string;
  config?: Record<string, unknown>;
};

type Stage = { stage: string; detail?: string };

type Proposal = {
  intent: string;
  model: string;
  valid: boolean;
  errors: string[];
  gemini_connection: string;
  warnings?: string[];
  run_cost?: {
    per_firing_usd: number;
    unpriced_steps: number;
    steps: { step?: string; action_type?: string; usd: number | null; basis?: string }[];
  };
  draft_cost?: { tokens_in: number; tokens_out: number; usd: number | null };
  replay: {
    scanned: number;
    matched: number;
    span_days: number | null;
    per_day: number | null;
    samples: {
      id: string;
      received_at: string | null;
      family: string | null;
      notification_type: string | null;
    }[];
  } | null;
  template: {
    name?: string;
    tagline?: string;
    explanation?: string;
    assumptions?: string[];
    flow?: {
      trigger_type?: string;
      trigger_config?: Record<string, unknown>;
      nodes?: ProposedNode[];
      edges?: { source?: string; target?: string; branch?: string }[];
      helix_event_types?: {
        event_type_uid?: string;
        name?: string;
        event_schema?: Record<string, string>;
      }[];
    };
  };
};

const EXAMPLES = [
  "I have a fox problem and I want to be notified when one shows up",
  "Check the garage camera every morning and tell me if the door is blocked",
  "When someone badges in after midnight, grab a still and log it",
];

export default function FlowBuilder() {
  const [intent, setIntent] = useState("");
  // Answers to the questions asked before drafting.
  const [runMode, setRunMode] = useState<"webhook" | "schedule" | null>(null);
  const [eventSource, setEventSource] = useState<
    "browse" | "epoch" | "never" | null
  >(null);
  const [pickedKind, setPickedKind] = useState<EventKind | null>(null);
  const [epochInput, setEpochInput] = useState("");
  const [kinds, setKinds] = useState<EventKind[] | null>(null);
  const [kindsLoading, setKindsLoading] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Reads the newline-delimited progress stream. Building runs two model
  // calls and takes several seconds; showing the stages as they land is the
  // difference between "working" and "hung".
  async function loadKinds() {
    if (kinds || kindsLoading) return;
    setKindsLoading(true);
    try {
      const r = await apiGet<{ kinds: EventKind[] }>(
        "/api/flow-builder/event-kinds",
      );
      setKinds(r.kinds);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setKindsLoading(false);
    }
  }

  async function run(text: string) {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    setError(null);
    setStages([]);
    setProposal(null);
    try {
      const res = await fetch(`${API_BASE}/api/flow-builder/propose`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: text,
          run_mode: runMode,
          example_event_id:
            eventSource === "browse" ? pickedKind?.sample_event_id ?? null : null,
          example_epoch:
            eventSource === "epoch" && epochInput.trim()
              ? Number(epochInput.trim())
              : null,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let detail = `Draft failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.detail) detail = j.detail;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Keep the trailing partial line in the buffer for the next chunk.
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          if (!raw.trim()) continue;
          const msg = JSON.parse(raw);
          if (msg.stage === "done") setProposal(msg.result as Proposal);
          else setStages((prev) => [...prev, msg as Stage]);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  // Don't let them draft until the questions are answered — an ungrounded
  // trigger is what produced a flow that fired on every camera in the org.
  const ready =
    runMode === "schedule" ||
    (runMode === "webhook" &&
      (eventSource === "never" ||
        (eventSource === "browse" && !!pickedKind) ||
        (eventSource === "epoch" && !!epochInput.trim())));

  const flow = proposal?.template?.flow;
  const nodes = flow?.nodes ?? [];

  return (
    <div className="max-w-[1100px]">
      <h1 className="text-2xl font-semibold text-white">Build a flow</h1>
      <p className="text-slate-400 text-sm mt-1 max-w-3xl">
        Describe what you want to happen and this drafts a flow for it —
        trigger, steps, and any Helix event type it needs. Nothing is saved;
        this is a proposal you read before deciding.
      </p>

      <form
        className="mt-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (intent.trim()) run(intent.trim());
        }}
      >
        <textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          rows={3}
          placeholder="e.g. I have a fox problem and I want to be notified when one shows up"
          className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/15 text-sm resize-y focus:outline-none focus:border-sky-600"
        />
        <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-3 space-y-3">
          <div>
            <div className="text-[12px] text-slate-300 font-medium">
              How should it run?
            </div>
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {(
                [
                  ["webhook", "When something happens", "Reacts to a Verkada event"],
                  ["schedule", "On a schedule", "Checks every so often"],
                ] as const
              ).map(([val, label, hint]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setRunMode(val)}
                  className={`text-left px-3 py-2 rounded border transition-colors ${
                    runMode === val
                      ? "border-sky-500/50 bg-sky-950/40 text-white"
                      : "border-white/10 text-slate-300 hover:bg-white/5"
                  }`}
                >
                  <div className="text-[12px]">{label}</div>
                  <div className="text-[11px] text-slate-500">{hint}</div>
                </button>
              ))}
            </div>
          </div>

          {runMode === "webhook" && (
            <div>
              <div className="text-[12px] text-slate-300 font-medium">
                Point at an example of the event
              </div>
              <div className="text-[11px] text-slate-500 mb-1.5">
                A real event pins down the trigger. Without one it has to guess,
                and a guess tends to fire on everything.
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {(
                  [
                    ["browse", "Browse what's come in"],
                    ["epoch", "I know roughly when"],
                    ["never", "It hasn't happened yet"],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => {
                      setEventSource(val);
                      if (val === "browse") loadKinds();
                    }}
                    className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                      eventSource === val
                        ? "border-sky-500/50 bg-sky-950/40 text-white"
                        : "border-white/10 text-slate-400 hover:bg-white/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {eventSource === "browse" && (
                <div className="mt-2 max-h-56 overflow-y-auto rounded border border-white/10">
                  {kindsLoading && (
                    <div className="px-3 py-3 text-[12px] text-slate-500">
                      Reading your webhook history…
                    </div>
                  )}
                  {kinds?.length === 0 && (
                    <div className="px-3 py-3 text-[12px] text-slate-500">
                      No webhook events captured yet.
                    </div>
                  )}
                  {kinds?.map((k) => (
                    <button
                      key={k.sample_event_id}
                      type="button"
                      onClick={() => setPickedKind(k)}
                      className={`w-full text-left px-3 py-2 border-b border-white/5 hover:bg-white/5 ${
                        pickedKind?.sample_event_id === k.sample_event_id
                          ? "bg-sky-950/40"
                          : ""
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-[12px] text-slate-200">
                          {k.notification_type}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {k.count}×
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {k.camera_name ?? k.door_name ?? k.family}
                        {k.objects?.length ? ` · ${k.objects.join(", ")}` : ""}
                        {k.last_seen
                          ? ` · last ${k.last_seen.replace("T", " ").slice(0, 16)}`
                          : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {eventSource === "epoch" && (
                <input
                  value={epochInput}
                  onChange={(e) => setEpochInput(e.target.value)}
                  inputMode="numeric"
                  placeholder="Unix epoch seconds, e.g. 1788370089 — we'll use the closest event"
                  className="mt-2 w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
                />
              )}

              {eventSource === "never" && (
                <div className="mt-2 text-[11px] text-amber-200/80">
                  It'll pick a trigger from the taxonomy and flag it as unverified
                  — the replay check below will show whether anything matches.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
          <div className="flex gap-1.5 flex-wrap">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setIntent(ex)}
                className="text-[11px] px-2 py-1 rounded border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200"
              >
                {ex.length > 46 ? ex.slice(0, 46) + "…" : ex}
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={!intent.trim() || running || !ready}
            className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white text-sm disabled:opacity-40"
          >
            {running ? "Working…" : "Draft it"}
          </button>
        </div>
      </form>

      {stages.length > 0 && (
        <div className="mt-5 rounded-lg border border-white/10 bg-black/25 p-3 font-mono text-[11.5px] space-y-0.5">
          {stages.map((s2, i) => (
            <div key={i} className="flex gap-2">
              <span
                className={
                  s2.stage === "error" || s2.stage === "invalid"
                    ? "text-amber-300 w-24 shrink-0"
                    : "text-sky-300/80 w-24 shrink-0"
                }
              >
                {s2.stage}
              </span>
              <span className="text-slate-400">{s2.detail}</span>
            </div>
          ))}
          {running && (
            <div className="flex gap-2">
              <span className="text-slate-500 w-24 shrink-0">…</span>
              <span className="text-slate-500">working</span>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-5 rounded-lg border border-rose-500/30 bg-rose-950/30 p-4 text-sm text-rose-200">
          {error}
        </div>
      )}

      {proposal && (
        <div className="mt-6 space-y-3">
          {/* Whether it fires is the question that matters, so it goes first
           * — and it's answered with real traffic rather than an opinion. */}
          {proposal.replay && (
            <div
              className={`rounded-lg border p-4 ${
                proposal.replay.matched > 0
                  ? "border-emerald-500/30 bg-emerald-950/20"
                  : "border-amber-500/30 bg-amber-950/20"
              }`}
            >
              <div className="text-sm text-slate-100">
                {proposal.replay.matched > 0 ? (
                  <>
                    This trigger would have fired{" "}
                    <span className="font-semibold text-emerald-300">
                      {proposal.replay.matched} times
                    </span>{" "}
                    across your last {proposal.replay.scanned} webhook events
                    {proposal.replay.span_days
                      ? ` (${proposal.replay.span_days.toFixed(1)} days)`
                      : ""}
                    .
                  </>
                ) : (
                  <>
                    This trigger matched{" "}
                    <span className="font-semibold text-amber-300">nothing</span>{" "}
                    in your last {proposal.replay.scanned} webhook events — it
                    may be watching for something that doesn't happen here.
                  </>
                )}
              </div>
              {proposal.replay.samples.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {proposal.replay.samples.map((s) => (
                    <div key={s.id} className="text-[11px] text-slate-400">
                      {s.received_at?.replace("T", " ").slice(0, 19)} ·{" "}
                      <span className="font-mono">{s.notification_type}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {proposal.run_cost && (
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">
                What this would cost to run
              </div>
              <div className="text-slate-100 text-sm mt-1">
                {proposal.run_cost.per_firing_usd > 0 ? (
                  <>
                    <span className="font-semibold">
                      ${proposal.run_cost.per_firing_usd.toFixed(4)}
                    </span>{" "}
                    per firing
                    {proposal.replay?.per_day ? (
                      <>
                        {" · at "}
                        {Math.round(proposal.replay.per_day)} firings/day that's{" "}
                        <span className="font-semibold text-amber-200">
                          ${(
                            proposal.run_cost.per_firing_usd *
                            proposal.replay.per_day *
                            30
                          ).toFixed(2)}
                          /month
                        </span>
                      </>
                    ) : null}
                  </>
                ) : (
                  <span className="text-slate-400">
                    No priced model steps — nothing here bills Gemini.
                  </span>
                )}
              </div>
              {proposal.run_cost.steps.map((st, i) => (
                <div key={i} className="text-[11px] text-slate-500 mt-1">
                  <span className="font-mono">{st.step}</span> ·{" "}
                  {st.usd === null ? (
                    <span className="text-amber-300">
                      no past runs to price this from
                    </span>
                  ) : (
                    <>
                      ${st.usd.toFixed(4)}
                      {st.basis ? ` — averaged from ${st.basis}` : ""}
                    </>
                  )}
                </div>
              ))}
              {proposal.draft_cost && (
                <div className="text-[12px] text-slate-300 mt-2 pt-2 border-t border-white/5">
                  This draft cost{" "}
                  <span className="font-semibold text-slate-100">
                  {proposal.draft_cost.usd !== null
                    ? "$" + proposal.draft_cost.usd.toFixed(4)
                    : "—"}
                  </span>{" "}
                  to generate on {proposal.model} —{" "}
                  {proposal.draft_cost.tokens_in.toLocaleString()} tokens in,{" "}
                  {proposal.draft_cost.tokens_out.toLocaleString()} out
                </div>
              )}
            </div>
          )}

          {(proposal.warnings?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/25 p-4">
              <div className="text-sm font-semibold text-amber-200">
                Worth a look before you build this
              </div>
              <ul className="mt-1.5 space-y-1.5">
                {proposal.warnings!.map((w, i) => (
                  <li key={i} className="text-[12px] text-amber-100/90">
                    • {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!proposal.valid && proposal.errors.length > 0 && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-950/25 p-4">
              <div className="text-sm font-semibold text-rose-200">
                This draft didn't validate
              </div>
              <ul className="mt-1.5 space-y-1">
                {proposal.errors.map((e, i) => (
                  <li key={i} className="text-[12px] text-rose-200/90">
                    • {e}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <h2 className="text-lg font-semibold text-white">
              {proposal.template.name ?? "Proposed flow"}
            </h2>
            {proposal.template.explanation && (
              <p className="text-sm text-slate-300 mt-1">
                {proposal.template.explanation}
              </p>
            )}

            <div className="mt-4 text-[11px] uppercase tracking-wide text-slate-500">
              Trigger
            </div>
            <div className="mt-1 rounded border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-[13px] text-slate-100">
                {flow?.trigger_type === "schedule"
                  ? "On a schedule"
                  : "Verkada webhook"}
              </div>
              <pre className="text-[11px] text-slate-400 mt-1 whitespace-pre-wrap font-mono">
                {JSON.stringify(flow?.trigger_config ?? {}, null, 1)}
              </pre>
            </div>

            <div className="mt-4 text-[11px] uppercase tracking-wide text-slate-500">
              Steps
            </div>
            <ol className="mt-1 space-y-1.5">
              {nodes.map((n, i) => (
                <li
                  key={n.id ?? i}
                  className="rounded border border-white/10 bg-black/20 px-3 py-2"
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-slate-500 text-[11px]">{i + 1}</span>
                    <span className="text-[13px] text-slate-100">
                      {n.label ?? n.name}
                    </span>
                    <span className="font-mono text-[11px] text-sky-300/80">
                      {n.kind === "condition" ? "condition" : n.action_type}
                    </span>
                  </div>
                  {n.config && Object.keys(n.config).length > 0 && (
                    <pre className="text-[11px] text-slate-400 mt-1 whitespace-pre-wrap font-mono">
                      {JSON.stringify(n.config, null, 1)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>

            {(flow?.helix_event_types?.length ?? 0) > 0 && (
              <>
                <div className="mt-4 text-[11px] uppercase tracking-wide text-slate-500">
                  Helix event types it would create
                </div>
                {flow!.helix_event_types!.map((h) => (
                  <div
                    key={h.event_type_uid}
                    className="mt-1 rounded border border-white/10 bg-black/20 px-3 py-2"
                  >
                    <div className="text-[13px] text-slate-100">{h.name}</div>
                    <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                      {Object.entries(h.event_schema ?? {})
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                    </div>
                  </div>
                ))}
              </>
            )}

            {(proposal.template.assumptions?.length ?? 0) > 0 && (
              <>
                <div className="mt-4 text-[11px] uppercase tracking-wide text-slate-500">
                  What it assumed — read this bit
                </div>
                <ul className="mt-1 space-y-1">
                  {proposal.template.assumptions!.map((a, i) => (
                    <li key={i} className="text-[12px] text-amber-200/90">
                      • {a}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <details className="rounded-lg border border-white/10 bg-white/5">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm text-slate-300">
              Raw template JSON
              <span className="text-slate-500">
                {" "}
                — {proposal.model || "gemini"} via {proposal.gemini_connection}
              </span>
            </summary>
            <pre className="px-3 pb-3 text-[11px] text-slate-400 whitespace-pre-wrap font-mono">
              {JSON.stringify(proposal.template, null, 2)}
            </pre>
          </details>

          <p className="text-[12px] text-slate-500">
            Nothing here has been saved. Installing a proposal — binding
            connections and provisioning the Helix types — is the next piece to
            build.
          </p>
        </div>
      )}
    </div>
  );
}
