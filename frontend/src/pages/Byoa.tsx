import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  API_BASE,
  apiGet,
  apiPost,
  Connection,
  HelixEventType,
  PromptTemplate,
  RunDetail,
  VerkadaCamera,
  WebhookEvent,
} from "../lib/api";
import EpochPicker from "../components/EpochPicker";
import HelixEventTypeEditor from "../components/HelixEventTypeEditor";
import { BetaChip, CostChip } from "../components/StepConfigForm";


// Mirror the model list the action editor uses so the dropdown stays in
// sync with what's actually supported. Kept inline here (not imported from
// the action schema) because this page hits a different endpoint shape.
interface ModelChoice {
  value: string;
  label: string;
  tier: "$" | "$$" | "$$$";
  preview: boolean;
  tagline: string;
}


// Mirrors backend GEMINI_MODELS in gemini_analyze_camera.py. Kept inline
// because BYOA hits a different endpoint and isn't driven by the
// action-schema dropdown.
const GEMINI_MODELS: ModelChoice[] = [
  {
    value: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    tier: "$",
    preview: false,
    tagline: "cheapest, fast — great for simple OCR / yes-no checks",
  },
  {
    value: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    tier: "$",
    preview: false,
    tagline: "balanced default — solid quality for most camera prompts",
  },
  {
    value: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    tier: "$$$",
    preview: false,
    tagline: "highest-quality stable Pro — best for nuanced / complex prompts",
  },
  {
    value: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    tier: "$$",
    preview: true,
    tagline: "newer Flash variant, BETA — quality / speed may vary",
  },
  {
    value: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    tier: "$$$",
    preview: true,
    tagline: "newest Pro variant, BETA — even pricier than 2.5 Pro",
  },
];



// Starting prompt is empty so the textarea reads as a clean
// invitation ("write your own analytic"). The old auto-filled
// safety-description prompt has been demoted to a placeholder
// example so operators see *one* concrete prompt without having
// to clear it before typing their own.
const DEFAULT_PROMPT = "";
const PROMPT_PLACEHOLDER = "Do you see a spill on the ground?";


export default function Byoa() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fromRunId = searchParams.get("from_run");
  // ``?from_event=<id>`` arrives from the WebhookInbox "Open in
  // Workbench" button. We resolve the event below and seed camera_id
  // + start_epoch + historical mode so the operator lands ready to
  // hit Brew. Cleared from the URL after first read so subsequent
  // edits don't keep re-seeding state.
  const fromEventId = searchParams.get("from_event");
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const verkadaConns = (connections.data ?? []).filter(
    (c) => c.type === "verkada" && c.setup_complete,
  );
  const geminiConns = (connections.data ?? []).filter(
    (c) => c.type === "gemini" && c.setup_complete,
  );

  const [verkadaConnId, setVerkadaConnId] = useState<string>("");
  const [geminiConnId, setGeminiConnId] = useState<string>("");

  useEffect(() => {
    if (!verkadaConnId && verkadaConns.length > 0) setVerkadaConnId(verkadaConns[0].id);
    if (!geminiConnId && geminiConns.length > 0) setGeminiConnId(geminiConns[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verkadaConns.length, geminiConns.length]);

  const cameras = useQuery({
    queryKey: ["verkada-cameras", verkadaConnId],
    queryFn: () =>
      apiGet<VerkadaCamera[]>(
        `/api/verkada/cameras?connection_id=${verkadaConnId}`,
      ),
    enabled: !!verkadaConnId,
  });
  const userTemplates = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: () => apiGet<PromptTemplate[]>("/api/prompt-templates"),
  });
  interface BuiltinTemplate {
    name: string;
    value: string;
    // Optional Helix pairing — see /api/prompt-templates/builtins.
    // When present, picking the template auto-toggles "Post to Helix",
    // selects the matching event type by name (if one exists on the
    // current connection), and shows a banner explaining the pairing.
    helix_event_type?: {
      event_type_uid: string;
      name: string;
      event_schema: Record<string, string>;
    };
    helix_attribute_mapping?: Record<string, string>;
  }
  const builtinTemplates = useQuery({
    queryKey: ["prompt-templates-builtins"],
    queryFn: () =>
      apiGet<BuiltinTemplate[]>("/api/prompt-templates/builtins"),
    staleTime: 60_000,
  });

  // Per-model pricing for the cost estimate. Backend re-seeds these
  // from the published Google rates on every boot, so the data rarely
  // changes mid-session — long staleTime keeps the form snappy and
  // avoids polling.
  const pricing = useQuery({
    queryKey: ["gemini-pricing"],
    queryFn: () =>
      apiGet<
        { model: string; input_per_1m_usd: number; output_per_1m_usd: number }[]
      >("/api/byoa/pricing"),
    staleTime: 5 * 60_000,
  });

  // ``source`` toggles the top-level input: a real Verkada camera
  // (default, full BYOA flow with a Run row) vs an uploaded MP4 / image
  // (dry-run only, no Run row, no Helix POST). The two modes share the
  // prompt + Gemini connection + model picker but otherwise have
  // disjoint inputs and disjoint output panels.
  const [source, setSource] = useState<"camera" | "upload">("camera");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  // Duration of the uploaded video in seconds, probed client-side via
  // an HTML5 <video> ``loadedmetadata`` event. Drives the cost
  // estimate (Gemini bills per second of video tokens, not per byte).
  // Null while we don't know yet; 0 for image uploads (handled by the
  // estimate as a fixed-per-image cost).
  const [uploadDurationSec, setUploadDurationSec] = useState<number | null>(
    null,
  );
  const [cameraId, setCameraId] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(true);
  const [mode, setMode] = useState<"live" | "historical">("live");
  const [postToHelix, setPostToHelix] = useState(false);
  const [helixEventTypeUid, setHelixEventTypeUid] = useState<string>("");
  const [helixAttribute, setHelixAttribute] = useState<string>("");
  // Survives the "Run it back" round trip when ``pickedTemplate``
  // can't be matched (the prior run came from a builtin that's since
  // been edited, etc.). The body builder prefers pickedTemplate's
  // mapping but falls back to this on replay.
  const [restoredMapping, setRestoredMapping] = useState<Record<
    string,
    string
  > | null>(null);
  // Inline "+ New type" editor toggle. When opened with a paired
  // prompt selected we seed the form from the paired definition so
  // the operator clicks once and gets the schema pre-filled.
  const [creatingHelixType, setCreatingHelixType] = useState(false);

  // Helix event types for the picked Verkada connection — feeds both
  // dropdowns below the "Post to Helix" toggle. Same endpoint the action
  // editor uses.
  const helixTypes = useQuery({
    queryKey: ["helix-event-types", verkadaConnId],
    queryFn: () =>
      apiGet<HelixEventType[]>(
        `/api/connections/${verkadaConnId}/helix-event-types`,
      ),
    enabled: !!verkadaConnId && postToHelix,
    staleTime: 30_000,
  });
  // Whenever the picked event type changes, default the attribute to
  // "Summary" if that key exists, otherwise the first string field —
  // matches the most common Helix shape ("Summary": "AI text here").
  // Lives AFTER the helixTypes query so it can reference helixTypes.data
  // without a temporal-dead-zone access.
  const pickedHelixEvent = (helixTypes.data ?? []).find(
    (e) => e.event_type_uid === helixEventTypeUid,
  );
  const helixAttrOptions = useMemo(() => {
    if (!pickedHelixEvent?.event_schema) return [];
    return Object.entries(pickedHelixEvent.event_schema).map(([k, t]) => ({
      key: k,
      type: t,
    }));
  }, [pickedHelixEvent]);
  useEffect(() => {
    if (!pickedHelixEvent) {
      setHelixAttribute("");
      return;
    }
    const keys = Object.keys(pickedHelixEvent.event_schema ?? {});
    if (helixAttribute && keys.includes(helixAttribute)) return;
    const preferred =
      keys.find((k) => k.toLowerCase() === "summary") ?? keys[0] ?? "";
    setHelixAttribute(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedHelixEvent]);
  const [model, setModel] = useState(GEMINI_MODELS[0].value);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  // Historical inputs. ``startEpoch`` is owned directly by EpochPicker
  // (canonical unix seconds); duration + pre-roll are local.
  const [startEpoch, setStartEpoch] = useState<number | null>(null);
  const [durationSec, setDurationSec] = useState<number>(10);
  const [preRollSec, setPreRollSec] = useState<number>(2);

  // "Run it back" hydration. Lives AFTER all state declarations so the
  // effect's closure captures fully-initialized setX bindings — keeps
  // bundlers / React strict-mode double-invoke from racing the TDZ.
  // Pulls the run once on mount, overwrites every local field, then
  // clears the search param so subsequent edits don't get reset.
  useEffect(() => {
    if (!fromRunId) return;
    let cancelled = false;
    apiGet<RunDetail>(`/api/runs/${fromRunId}`)
      .then((run) => {
        if (cancelled) return;
        const inp = run.input as Record<string, unknown> | null;
        if (!inp || !inp.byoa) return;
        if (typeof inp.connection_id === "string") setVerkadaConnId(inp.connection_id);
        if (typeof inp.gemini_connection_id === "string")
          setGeminiConnId(inp.gemini_connection_id);
        if (typeof inp.camera_id === "string") setCameraId(inp.camera_id);
        if (inp.mode === "live" || inp.mode === "historical") setMode(inp.mode);
        if (typeof inp.model === "string") setModel(inp.model);
        if (typeof inp.prompt === "string") setPrompt(inp.prompt);
        if (typeof inp.start_epoch === "number") setStartEpoch(inp.start_epoch);
        if (typeof inp.duration_sec === "number")
          setDurationSec(inp.duration_sec);
        if (typeof inp.pre_roll_sec === "number")
          setPreRollSec(inp.pre_roll_sec);
        if (inp.post_to_helix) {
          setPostToHelix(true);
          if (typeof inp.helix_event_type_uid === "string")
            setHelixEventTypeUid(inp.helix_event_type_uid);
          if (typeof inp.helix_attribute === "string")
            setHelixAttribute(inp.helix_attribute);
          // Restore the paired-prompt mapping too. Without this, "Run
          // it back" lost the multi-attribute mapping and the worker
          // fell through to the legacy single-field path — every
          // replayed run quietly posted the whole JSON blob into a
          // ``Summary`` attribute that doesn't exist on the paired
          // event type, and Helix 400'd.
          if (
            inp.helix_attribute_mapping &&
            typeof inp.helix_attribute_mapping === "object" &&
            !Array.isArray(inp.helix_attribute_mapping)
          ) {
            setRestoredMapping(
              inp.helix_attribute_mapping as Record<string, string>,
            );
          }
        }
        setSearchParams({}, { replace: true });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromRunId]);

  // "Open in Workbench" hydration. Same pattern as the run-it-back
  // effect but seeded from a webhook event: pull camera_id +
  // event timestamp out of the event's body and switch to historical
  // mode so the operator can re-analyze exactly the frame Verkada
  // sent. Verkada connection is matched by org_id when possible.
  useEffect(() => {
    if (!fromEventId) return;
    let cancelled = false;
    apiGet<WebhookEvent>(`/api/webhook-events/${fromEventId}`)
      .then((event) => {
        if (cancelled) return;
        const body = (event.body_json ?? {}) as Record<string, unknown>;
        const data =
          body && typeof body === "object"
            ? ((body as Record<string, unknown>).data as
                | Record<string, unknown>
                | undefined)
            : undefined;
        const camId =
          typeof data?.camera_id === "string" ? data.camera_id : null;
        // Verkada sends ``created`` as unix-seconds — perfect for our
        // historical start_epoch field. Some event types use other
        // names ("timestamp", "time"); fall through them in order.
        const createdRaw =
          (typeof data?.created === "number" && data.created) ||
          (typeof data?.timestamp === "number" && data.timestamp) ||
          (typeof data?.time === "number" && data.time) ||
          null;
        if (camId) setCameraId(camId);
        if (typeof createdRaw === "number" && createdRaw > 0) {
          setStartEpoch(createdRaw);
          setMode("historical");
        }
        // Match the Verkada connection by org if we can — when an
        // operator has multiple Verkada connections, the event tells
        // us which one this came from.
        if (event.org_id) {
          const match = verkadaConns.find((c) => c.external_id === event.org_id);
          if (match) setVerkadaConnId(match.id);
        }
        setSearchParams({}, { replace: true });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromEventId, verkadaConns.length]);

  // Merge templates: user entries first, then built-ins. User templates
  // never carry Helix pairing (no UI for setting it yet) so they coerce
  // to the same BuiltinTemplate shape with the optional fields absent.
  // Analytics composed from a description. Stored with their Helix
  // pairing intact, so they enter the picker as paired templates and
  // get the same "create the event type" treatment as the built-ins.
  const savedAnalytics = useQuery({
    queryKey: ["byoa-analytics"],
    queryFn: () => apiGet<SavedAnalytic[]>("/api/byoa/analytics"),
  });

  const allTemplates = useMemo<BuiltinTemplate[]>(
    () => [
      ...(savedAnalytics.data ?? []).map((a) => ({
        name: a.name,
        value: a.prompt,
        helix_event_type: a.helix_event_type,
        helix_attribute_mapping: a.helix_attribute_mapping,
      })),
      ...(userTemplates.data ?? []).map((t) => ({ name: t.name, value: t.value })),
      ...(builtinTemplates.data ?? []),
    ],
    [savedAnalytics.data, userTemplates.data, builtinTemplates.data],
  );

  // The template the operator picked most recently. Held in local state
  // so we can render the "Pairs with X" hint and react to changes in
  // the picked Verkada connection (re-resolve the matching Helix type).
  const [pickedTemplate, setPickedTemplate] = useState<BuiltinTemplate | null>(null);
  const [pasteId, setPasteId] = useState(false);
  // The prompt box only appears once there is a prompt — generated,
  // picked from a template, or explicitly asked for.
  const [promptOpen, setPromptOpen] = useState(false);

  // "Use it" fills the prompt and pairs Helix, both of which live well
  // below the composer — so pressing it looked like nothing happened.
  // Move the eye to the change and mark it briefly, rather than leaving
  // the reader to discover it by scrolling.
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [promptFlash, setPromptFlash] = useState(false);
  const revealPrompt = () => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    promptRef.current?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "center",
    });
    setPromptFlash(true);
    window.setTimeout(() => setPromptFlash(false), 1400);
  };

  // When a paired template is selected, auto-toggle "Post to Helix" and
  // try to select the matching event type by name on the current
  // Verkada connection. If the type doesn't exist on the org yet, the
  // toggle still flips on so the UI surfaces the "Create" affordance.
  useEffect(() => {
    if (!pickedTemplate?.helix_event_type) return;
    setPostToHelix(true);
    if (!helixTypes.data) return;
    const wantedName = pickedTemplate.helix_event_type.name.trim().toLowerCase();
    const match = helixTypes.data.find(
      (h) => (h.name ?? "").trim().toLowerCase() === wantedName,
    );
    if (match) setHelixEventTypeUid(match.event_type_uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedTemplate, helixTypes.data]);

  const [err, setErr] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        connection_id: verkadaConnId,
        gemini_connection_id: geminiConnId,
        camera_id: cameraId.trim(),
        mode,
        prompt,
        model,
      };
      if (mode === "historical") {
        body.start_epoch = startEpoch;
        body.duration_sec = durationSec;
        body.pre_roll_sec = preRollSec;
      }
      if (postToHelix) {
        body.post_to_helix = true;
        body.helix_event_type_uid = helixEventTypeUid;
        // When a paired prompt is selected we send its multi-attribute
        // mapping straight through to the worker — every Helix field
        // declared by the paired type gets its own value (Issue,
        // Severity, Reasoning, etc.) instead of stuffing the entire
        // JSON blob into one. The legacy single-attribute path stays
        // for unpaired prompts where the operator picks an attribute
        // manually.
        const effectiveMapping =
          pickedTemplate?.helix_attribute_mapping ?? restoredMapping;
        if (effectiveMapping) {
          body.helix_attribute_mapping = effectiveMapping;
        } else {
          body.helix_attribute = helixAttribute;
        }
      }
      return apiPost<{ run_id: string }>("/api/byoa/run-once", body);
    },
    onSuccess: (res) => navigate(`/runs?selected=${res.run_id}`),
    onError: (e: Error) => setErr(e.message),
  });

  /**
   * Upload-mode dispatch — sends the file + prompt to ``/api/byoa/dry-run``.
   * The backend streams the file to a shared volume, creates a Run row,
   * and enqueues the worker job; this returns the new run_id and we
   * navigate to /runs so the operator watches progress (Gemini upload
   * → analyze → optional Helix preview) on the same Runs page that
   * already renders camera-mode flows.
   *
   * Uses raw ``fetch`` rather than ``apiPost`` because the latter sets
   * ``Content-Type: application/json``, which would break the multipart
   * upload by mis-encoding the boundary. Goes through ``API_BASE`` so
   * the request hits the backend on :18080 in dev (Vite has no proxy).
   */
  const dryRun = useMutation({
    mutationFn: async (): Promise<{ run_id: string }> => {
      if (!uploadFile) throw new Error("Pick a file first.");
      if (!geminiConnId) throw new Error("Pick a Gemini connection.");
      if (!prompt.trim()) throw new Error("Prompt is required.");
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("gemini_connection_id", geminiConnId);
      fd.append("prompt", prompt);
      fd.append("model", model);
      // Only send Helix-preview params when a paired template is
      // picked — the user-facing rule is "templates show preview,
      // custom prompts don't" (see Workbench training spec).
      if (pickedTemplate?.helix_event_type && verkadaConnId) {
        fd.append("connection_id", verkadaConnId);
        // Prefer the resolved-on-this-org uid (when the type already
        // exists on the connection) — that path lets the backend pull
        // the canonical schema from the DB. Fall back to the
        // template's embedded uid for the first-time-paired case,
        // where the backend uses the schema we also ship inline.
        fd.append(
          "helix_event_type_uid",
          helixEventTypeUid || pickedTemplate.helix_event_type.event_type_uid,
        );
        const mapping =
          pickedTemplate.helix_attribute_mapping ?? restoredMapping;
        if (mapping) {
          fd.append("helix_attribute_mapping_json", JSON.stringify(mapping));
        }
        if (pickedTemplate.helix_event_type.event_schema) {
          fd.append(
            "helix_event_schema_json",
            JSON.stringify(pickedTemplate.helix_event_type.event_schema),
          );
        }
      }
      // Use the absolute backend base (same as apiPost/apiGet do) — the
      // Vite dev server has no proxy config, so a relative ``/api/...``
      // URL would 404 against Vite itself instead of reaching the
      // backend on :18080.
      const res = await fetch(`${API_BASE}/api/byoa/dry-run`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        // Read the body once as text — calling res.json() then
        // res.text() in a catch hits "body stream already read"
        // because a Response body can only be consumed once. Parse the
        // text as JSON afterwards so we still surface FastAPI's
        // ``{detail: "..."}`` cleanly, falling back to the raw text
        // (or a generic status message) when the body isn't JSON.
        const raw = await res.text().catch(() => "");
        let detail = raw;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { detail?: unknown };
            if (typeof parsed.detail === "string" && parsed.detail.trim()) {
              detail = parsed.detail;
            }
          } catch {
            /* raw text is the detail */
          }
        }
        throw new Error(detail || `Dry-run failed (${res.status})`);
      }
      return (await res.json()) as { run_id: string };
    },
    onSuccess: (res) => {
      setErr(null);
      navigate(`/runs?selected=${res.run_id}`);
    },
    onError: (e: Error) => setErr(e.message),
  });

  const noConnections = verkadaConns.length === 0 || geminiConns.length === 0;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {noConnections && (
        <Card>
          <div className="text-sm text-amber-200">
            You need at least one ready Verkada org and one ready Gemini API key
            in <a href="/connections" className="text-sky-300 hover:underline">Connections</a>{" "}
            before Workbench can run.
          </div>
        </Card>
      )}

      <Card>
        {/* Intent first. Everything below this — connections, camera,
            footage, model — exists to serve the analytic, so asking
            for them before asking what the analytic is put the
            plumbing ahead of the subject. */}
        <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">
          What should it look for
        </div>
        <AnalyticComposer
          defaultOpen={!prompt.trim()}
          geminiConnectionId={geminiConnId}
          onUse={(a) => {
            setPrompt(a.prompt);
            setPickedTemplate({
              name: a.name,
              value: a.prompt,
              helix_event_type: a.helix_event_type,
              helix_attribute_mapping: a.helix_attribute_mapping,
            });
            setPostToHelix(true);
            revealPrompt();
          }}
          onSaved={() => savedAnalytics.refetch()}
        />

        <Field label="Prompt" required>
          {allTemplates.length > 0 && (
            <>
              <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
                Pick a template
              </div>
              {/* Picker grid — replaces the old <select> so the demo /
                  video story reads as "pick the analytic" instead of
                  "scroll a tiny dropdown." Each card shows the
                  template name + paired Helix type emoji (when the
                  template ships one) + a Helix-paired chip so
                  operators can see the pairing at a glance. The
                  active card gets a sky border + scale-up so the
                  current pick is unmistakable. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 mb-3">
                {allTemplates.map((t) => {
                  const active = pickedTemplate?.name === t.name;
                  // Paired templates carry an emoji in their helix
                  // event type name (e.g. "🦌 Animal Watch"). Pull
                  // the first non-space cluster off the front and
                  // use it as the card icon; falls back to ✨ when
                  // the template has no pairing.
                  const helixName = t.helix_event_type?.name ?? "";
                  const iconMatch = helixName.match(/^\s*(\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*)/u);
                  const icon = iconMatch?.[1] ?? "✨";
                  return (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => {
                        setPrompt(t.value);
                        setPickedTemplate(t);
                        // A fresh template selection invalidates
                        // whatever replay state we restored — its
                        // mapping is the new source of truth.
                        setRestoredMapping(null);
                      }}
                      className={`text-left p-3 rounded-md border transition duration-200 ease-out-strong ${
                        active
                          ? "border-sky-400/80 bg-sky-950/40 scale-[1.02] shadow-[0_0_14px_rgba(56,189,248,0.35)]"
                          : "border-white/15 bg-white/5 hover:border-sky-700/60 hover:bg-sky-950/20"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-2xl leading-none mt-0.5" aria-hidden>
                          {icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-slate-100 leading-tight">
                            {t.name}
                          </div>
                          {t.helix_event_type && (
                            <div className="mt-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60">
                              🧬 Helix-paired
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              {pickedTemplate?.helix_event_type && (
                <div className="text-[11px] bg-emerald-950/30 border border-emerald-900/60 rounded px-2 py-1.5 mb-2">
                  <div className="text-slate-300">
                    <span className="text-emerald-300">Pairs with Helix:</span>{" "}
                    <span className="text-slate-100 font-medium">
                      {pickedTemplate.helix_event_type.name}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                    {Object.entries(pickedTemplate.helix_event_type.event_schema)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ")}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    Post to Helix has been toggled on with this event type pre-selected. If it's not yet on your Verkada org, create it on the Helixr tab.
                  </div>
                </div>
              )}
            </>
          )}
          {/* "Custom prompt" header tells operators this is the
              free-form path — write your own analytic instead of
              picking a card. Sits with a hairline divider above so
              the visual break between "templates" and "custom" is
              obvious without taking much vertical space. */}
          {allTemplates.length > 0 && (promptOpen || prompt.trim()) && (
            <div className="border-t border-white/10 mt-3 pt-3">
              <div className="flex items-baseline gap-2 mb-1.5">
                <div className="text-[11px] uppercase tracking-wider text-slate-400">
                  Prompt
                </div>
                <div className="text-[10px] text-slate-500">
                  {prompt.trim()
                    ? "edit it before running, if you like"
                    : "write your own analytic"}
                </div>
              </div>
            </div>
          )}
          {allTemplates.length > 0 && !promptOpen && !prompt.trim() && (
            <div className="border-t border-white/10 mt-3 pt-3">
              <button
                type="button"
                onClick={() => setPromptOpen(true)}
                className="text-[11px] text-slate-500 hover:text-slate-300 underline underline-offset-2"
              >
                or write a prompt yourself
              </button>
            </div>
          )}
          {(promptOpen || prompt.trim()) && (
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={PROMPT_PLACEHOLDER}
            rows={6}
            spellCheck={false}
            className={`w-full px-2 py-1.5 rounded bg-white/5 border text-sm placeholder:text-slate-500 placeholder:italic transition-[border-color,box-shadow] duration-300 ease-out-strong ${
              promptFlash
                ? "border-sky-500/80 shadow-[0_0_0_3px_rgba(56,189,248,0.18)]"
                : "border-white/15"
            }`}
          />
          )}
        </Field>
        <div className="border-t border-white/10 my-5" />

        <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">
          Where it runs
        </div>
        <Row>
          <Field label="Verkada connection" required>
            <select
              value={verkadaConnId}
              onChange={(e) => {
                setVerkadaConnId(e.target.value);
                setCameraId("");
              }}
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            >
              <option value="">— pick —</option>
              {verkadaConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Gemini connection" required>
            <select
              value={geminiConnId}
              onChange={(e) => setGeminiConnId(e.target.value)}
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            >
              <option value="">— pick —</option>
              {geminiConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </Row>

        {/* Source picker — primary mode-switch for the whole form, so it
            gets dedicated card styling instead of the smaller pill-style
            ``ModeBtn`` used for in-form sub-toggles (Live/Historical
            etc.). Each card carries an icon + a tagline so the
            difference between "real pipeline" and "dry-run" is
            unmistakable at a glance — important because flipping the
            wrong way silently changes whether anything posts to Helix. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 -mt-1">
          <SourceCard
            active={source === "camera"}
            icon="🎥"
            title="Verkada camera"
            tagline="Pull a clip or live frame from a real camera. Posts to Helix when configured."
            onClick={() => {
              setSource("camera");
            }}
          />
          <SourceCard
            active={source === "upload"}
            icon="📤"
            title="Upload media"
            tagline="Test a prompt against your own MP4 or image. Nothing posts — dry-run only."
            badge="DRY RUN"
            onClick={() => {
              setSource("upload");
            }}
          />
        </div>

        {source === "upload" && (
          <Field
            label="Upload file"
            required
            help="MP4 / MOV / WebM video or JPG / PNG / WebP image. 200 MB max. The file is sent to Gemini and discarded — nothing is stored, nothing is posted to Helix."
          >
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setUploadFile(f);
                setUploadDurationSec(null);
                if (f && f.type.startsWith("video/")) {
                  // Probe video duration so the cost estimate is real
                  // (Gemini bills per second of video tokens, not per
                  // byte). HTMLVideoElement.duration becomes available
                  // once metadata loads — usually within a few hundred
                  // ms for any well-formed MP4 / MOV. We never render
                  // the <video> itself; it's just a metadata sniffer.
                  const url = URL.createObjectURL(f);
                  const v = document.createElement("video");
                  v.preload = "metadata";
                  v.onloadedmetadata = () => {
                    setUploadDurationSec(
                      Number.isFinite(v.duration) ? v.duration : null,
                    );
                    URL.revokeObjectURL(url);
                  };
                  v.onerror = () => {
                    URL.revokeObjectURL(url);
                  };
                  v.src = url;
                } else if (f) {
                  // Image upload — bills as a single frame, no
                  // duration involved. Tell the estimate to use its
                  // image branch by setting 0.
                  setUploadDurationSec(0);
                }
              }}
              className="block w-full text-sm text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-sky-700 file:hover:bg-sky-600 file:text-white file:text-sm file:cursor-pointer"
            />
            {uploadFile && (
              <div className="text-[11px] text-slate-400 mt-1.5">
                {uploadFile.name} — {(uploadFile.size / (1024 * 1024)).toFixed(1)} MB
                {uploadDurationSec != null && uploadDurationSec > 0 && (
                  <> · {formatDuration(uploadDurationSec)} of video</>
                )}
              </div>
            )}
          </Field>
        )}

        {source === "camera" && (
        <>
        <Field
          label="Camera"
          required
          help={
            verkadaConnId && (cameras.data?.length ?? 0) === 0
              ? "No cameras synced yet. Click 'Sync cameras' on the Connections page."
              : undefined
          }
        >
          {(() => {
            // Verkada's GET /cameras/v1/devices returns a status string
            // per camera ("Live" / "Offline" / a couple of transient states).
            // We treat anything not literally "Offline" as currently online
            // — that catches "Live" plus any future status the API adds for
            // healthy cameras without us having to chase the enum.
            const all = cameras.data ?? [];
            const isOnline = (s: string | null | undefined) =>
              !!s && s.toLowerCase() !== "offline";
            const online = all.filter((c) => isOnline(c.status));
            const list = onlineOnly ? online : all;
            const sorted = [...list].sort((a, b) =>
              (a.name ?? "").localeCompare(b.name ?? ""),
            );
            return (
              <>
                <div className="flex items-center gap-3 mb-1.5">
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={onlineOnly}
                      onChange={(e) => setOnlineOnly(e.target.checked)}
                    />
                    Online cameras only
                  </label>
                  {all.length > 0 && (
                    <span className="text-[11px] text-slate-500">
                      {onlineOnly
                        ? `${online.length} online · ${all.length - online.length} offline hidden`
                        : `${online.length} online · ${all.length - online.length} offline · ${all.length} total`}
                    </span>
                  )}
                </div>
                <select
                  value={cameraId}
                  onChange={(e) => setCameraId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  disabled={!verkadaConnId}
                >
                  <option value="">— pick a camera —</option>
                  {sorted.map((c) => {
                    const offline = !isOnline(c.status);
                    return (
                      <option key={c.camera_id} value={c.camera_id}>
                        {c.name ?? "(unnamed)"}
                        {c.site ? ` — ${c.site}` : ""}
                        {offline ? " · OFFLINE" : ""}
                      </option>
                    );
                  })}
                </select>
                {pasteId ? (
                  <input
                    autoFocus
                    value={cameraId}
                    onChange={(e) => setCameraId(e.target.value)}
                    placeholder="camera_id UUID"
                    className="w-full px-2 py-1.5 mt-1.5 rounded bg-white/5 border border-white/15 text-xs font-mono"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setPasteId(true)}
                    className="mt-1.5 text-[11px] text-slate-500 hover:text-slate-300 underline underline-offset-2"
                  >
                    paste an ID instead
                  </button>
                )}
              </>
            );
          })()}
        </Field>

        <Row>
          <Field label="Footage" required>
            <div className="flex gap-2 text-sm [&>button]:py-1.5">
              <ModeBtn
                active={mode === "live"}
                onClick={() => setMode("live")}
              >
                Live (still frame)
              </ModeBtn>
              <ModeBtn
                active={mode === "historical"}
                onClick={() => setMode("historical")}
              >
                Historical (clip)
              </ModeBtn>
            </div>
          </Field>
          <Field label="Model" required>
            <div className="space-y-1.5">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {GEMINI_MODELS.map((m) => {
                  const bits = [m.label, m.tier];
                  if (m.preview) bits.push("BETA");
                  return (
                    <option key={m.value} value={m.value}>
                      {bits.join(" · ")}
                    </option>
                  );
                })}
              </select>
              {(() => {
                const picked = GEMINI_MODELS.find((m) => m.value === model);
                if (!picked) return null;
                return (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <CostChip tier={picked.tier} />
                    {picked.preview && <BetaChip />}
                    <span className="text-[11px] text-slate-400">
                      {picked.tagline}
                    </span>
                  </div>
                );
              })()}
            </div>
          </Field>
        </Row>

        {mode === "historical" && (
          <>
            <Field label="Start time" required>
              <EpochPicker value={startEpoch} onChange={setStartEpoch} />
            </Field>
            <Row>
              <Field
                label="Duration (sec)"
                help="How long the clip is. Gemini bills per second of video."
              >
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={durationSec}
                  onChange={(e) => setDurationSec(Number(e.target.value) || 10)}
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                />
              </Field>
              <Field
                label="Pre-roll (sec)"
                help="Clip starts this many seconds before start time."
              >
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={preRollSec}
                  onChange={(e) => setPreRollSec(Number(e.target.value) || 0)}
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                />
              </Field>
            </Row>
          </>
        )}
        </>
        )}

        {/* Model picker is shown in upload mode too — the Footage Row
            above already includes it for camera mode. Kept as its own
            Field rather than mirroring the camera-mode Row layout
            because upload mode has nothing else to put next to it. */}
        {source === "upload" && (
          <>
          <Field label="Model" required>
            <div className="space-y-1.5">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {GEMINI_MODELS.map((m) => {
                  const bits = [m.label, m.tier];
                  if (m.preview) bits.push("BETA");
                  return (
                    <option key={m.value} value={m.value}>
                      {bits.join(" · ")}
                    </option>
                  );
                })}
              </select>
              {(() => {
                const picked = GEMINI_MODELS.find((m) => m.value === model);
                if (!picked) return null;
                return (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <CostChip tier={picked.tier} />
                    {picked.preview && <BetaChip />}
                    <span className="text-[11px] text-slate-400">
                      {picked.tagline}
                    </span>
                  </div>
                );
              })()}
            </div>
          </Field>
          <CostEstimate
            model={model}
            durationSec={uploadDurationSec}
            pricing={pricing.data ?? null}
            hasFile={!!uploadFile}
          />
          </>
        )}


        {/* Optional Helix post-step. Same machinery the verkada_helix_event
            flow action uses — Workbench just chains it after the analyze.
            Hidden until the operator picks a prompt template (or types a
            custom prompt) — there's nothing meaningful to log to Helix
            until we know what the model is actually being asked. The
            ``pickedTemplate``-driven effect above also auto-toggles the
            Post switch + pre-selects the matching event type when a
            Helix-paired prompt is chosen, so most operators never need
            to touch the toggle manually. */}
        {source === "camera" && (pickedTemplate || (prompt.trim() !== "" && prompt !== DEFAULT_PROMPT)) && (
        <div className="border-t border-white/10 pt-4 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={postToHelix}
              onChange={(e) => setPostToHelix(e.target.checked)}
            />
            <span className="text-sm text-slate-100">
              Post result to Helix
            </span>
            <span className="text-[11px] text-slate-500">
              {pickedTemplate?.helix_event_type
                ? `auto-paired with ${pickedTemplate.helix_event_type.name}`
                : "chain a verkada_helix_event step after the analyze"}
            </span>
          </label>
          {postToHelix && (
            <Row>
              {/*
                Stack the picker + create button vertically. Earlier we
                tucked the button inside ``Field`` (which wraps its
                children in a <label>), but a button-inside-a-label is
                a fragile clickable + visually disappears into the
                row. Pulling the button out as a sibling makes the
                create affordance obvious — especially when a paired
                prompt has primed a schema and we *want* the operator
                to notice it.
              */}
              <div>
                {(() => {
                  const paired = pickedTemplate?.helix_event_type;
                  const missing =
                    !!paired && !pairedTypeExists(helixTypes.data ?? [], paired);
                  // A paired analytic's attribute mapping only makes
                  // sense against its own type. Offering the picker here
                  // lets someone post Package Delivery attributes to a
                  // Deer Sighting schema — Verkada accepts it and the
                  // row is quietly wrong. So while the paired type is
                  // missing, creating it is the only move.
                  if (missing) {
                    return (
                      <Field
                        label="Helix event type"
                        required
                        help={`This analytic writes ${Object.keys(paired.event_schema).length} attributes that only fit ${paired.name}. Create it to continue.`}
                      >
                        <div className="px-2 py-1.5 rounded bg-white/5 border border-dashed border-white/15 text-sm text-slate-400">
                          {paired.name} — not on this org yet
                        </div>
                      </Field>
                    );
                  }
                  return (
                    <Field
                      label="Helix event type"
                      required
                      help={
                        helixTypes.data && helixTypes.data.length === 0
                          ? "No event types synced yet. Click 'Sync helix' on the connection."
                          : "Synced from Verkada — pick which event type to post against."
                      }
                    >
                      <select
                        value={helixEventTypeUid}
                        onChange={(e) => setHelixEventTypeUid(e.target.value)}
                        className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                      >
                        <option value="">— pick an event type —</option>
                        {(helixTypes.data ?? []).map((et) => (
                          <option key={et.id} value={et.event_type_uid}>
                            {et.name ?? "(unnamed)"}
                          </option>
                        ))}
                      </select>
                    </Field>
                  );
                })()}
                {(() => {
                  // Only surface the create affordance when the paired
                  // prompt's type isn't already in the synced list (or
                  // when there's no paired prompt and the operator is
                  // free-styling). Matching is by uid first, then by
                  // name (case-insensitive) — uid wins because the
                  // template ships with one, but legacy types in older
                  // orgs sometimes only line up by name.
                  const exists = pairedTypeExists(
                    helixTypes.data ?? [],
                    pickedTemplate?.helix_event_type,
                  );
                  if (exists) return null;
                  return (
                    <button
                      type="button"
                      onClick={() => setCreatingHelixType(true)}
                      disabled={!verkadaConnId}
                      title={
                        pickedTemplate?.helix_event_type
                          ? `Create the ${pickedTemplate.helix_event_type.name} type on this Verkada org (schema pre-filled from the paired prompt).`
                          : "Create a new Helix event type on this Verkada org."
                      }
                      className="mt-2 inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-emerald-700/60 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span aria-hidden>+</span>
                      {pickedTemplate?.helix_event_type
                        ? `Create "${pickedTemplate.helix_event_type.name}" in Verkada`
                        : "New Helix event type"}
                    </button>
                  );
                })()}
              </div>
              {pickedTemplate?.helix_attribute_mapping ? (
                // Paired prompt — fields fill from the multi-attribute
                // mapping that travels with the prompt definition. Show
                // a read-only summary instead of the single-attribute
                // picker (which would be a downgrade).
                <Field label="Attribute mapping (from paired prompt)">
                  <div className="text-[11px] bg-emerald-950/30 border border-emerald-900/60 rounded px-2 py-1.5 space-y-0.5">
                    {Object.entries(pickedTemplate.helix_attribute_mapping).map(
                      ([k, v]) => (
                        <div key={k} className="font-mono text-slate-300">
                          <span className="text-emerald-300">{k}</span>
                          <span className="text-slate-500"> ← </span>
                          <span className="text-slate-100">{v}</span>
                        </div>
                      ),
                    )}
                  </div>
                </Field>
              ) : (
                <Field
                  label="Write AI text into"
                  required={postToHelix}
                  help={
                    helixAttrOptions.length > 0
                      ? "Other schema fields will be sent as empty strings."
                      : "Pick an event type first to see its attributes."
                  }
                >
                  <select
                    value={helixAttribute}
                    onChange={(e) => setHelixAttribute(e.target.value)}
                    disabled={helixAttrOptions.length === 0}
                    className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  >
                    <option value="">— pick an attribute —</option>
                    {helixAttrOptions.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.key} ({a.type})
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </Row>
          )}
        </div>
        )}

        {err && (
          <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
            {err}
          </div>
        )}

        <div className="flex justify-end pt-2">
          {source === "camera" ? (
            <button
              onClick={() => {
                setErr(null);
                if (!verkadaConnId) return setErr("Pick a Verkada connection.");
                if (!geminiConnId) return setErr("Pick a Gemini connection.");
                if (!cameraId.trim()) return setErr("Pick a camera.");
                if (!prompt.trim()) return setErr("Prompt is required.");
                if (mode === "historical" && !startEpoch)
                  return setErr("Pick a start time for historical mode.");
                if (postToHelix && !helixEventTypeUid)
                  return setErr("Pick a Helix event type or turn off 'Post to Helix'.");
                if (postToHelix && !helixAttribute)
                  return setErr("Pick which Helix attribute to write the AI text into.");
                run.mutate();
              }}
              disabled={run.isPending || noConnections}
              className="text-sm px-4 py-2 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
            >
              {run.isPending ? "Starting…" : "Brew it"}
            </button>
          ) : (
            <button
              onClick={() => {
                setErr(null);
                if (!uploadFile) return setErr("Pick a file to upload.");
                if (!geminiConnId) return setErr("Pick a Gemini connection.");
                if (!prompt.trim()) return setErr("Prompt is required.");
                dryRun.mutate();
              }}
              disabled={dryRun.isPending || geminiConns.length === 0}
              className="text-sm px-4 py-2 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
              title="Sends the file to Gemini and (for paired templates) computes a Helix preview. Nothing is posted to Verkada."
            >
              {dryRun.isPending ? "Analyzing…" : "Run dry-run"}
            </button>
          )}
        </div>
      </Card>


      {source === "camera" && (
        <MakeItRun
          ranOnce={run.isSuccess || dryRun.isSuccess}
          analyticName={pickedTemplate?.name ?? "Analytic"}
          prompt={prompt}
          model={model}
          mode={mode}
          cameraId={cameraId}
          verkadaConnId={verkadaConnId}
          geminiConnId={geminiConnId}
          helixEventTypeUid={postToHelix ? helixEventTypeUid : ""}
          needsHelixType={postToHelix || !!pickedTemplate?.helix_event_type}
          helixMapping={pickedTemplate?.helix_attribute_mapping ?? null}
          durationSec={durationSec}
        />
      )}

      <p className="text-xs text-slate-500">
        Each run shows up under the Runs tab with the captured clip/image,
        the AI text, and the same per-phase progress checklist a flow
        execution gets.
      </p>

      {creatingHelixType && verkadaConnId && (
        <HelixEventTypeEditor
          connId={verkadaConnId}
          mode="create"
          // Seed the form from the paired prompt's helix definition
          // when one is selected — the operator opens the modal and
          // the name + attribute rows are already populated for the
          // common "the type doesn't exist on this org yet" path.
          seed={
            pickedTemplate?.helix_event_type
              ? {
                  name: pickedTemplate.helix_event_type.name,
                  event_schema: pickedTemplate.helix_event_type.event_schema,
                }
              : undefined
          }
          onClose={() => setCreatingHelixType(false)}
          onCreated={(created) => {
            // Land back on BYOA with the new type selected so the
            // operator can hit Brew immediately. The helix-types
            // query also invalidates inside the editor, so the
            // dropdown will repopulate on its own next render.
            setHelixEventTypeUid(created.event_type_uid);
          }}
        />
      )}
    </div>
  );
}


function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-5 space-y-4">
      {children}
    </div>
  );
}


function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>;
}


function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-slate-300 mb-1">
        {label}
        {required && <span className="text-rose-400 ml-1">*</span>}
      </div>
      {children}
      {help && <div className="text-xs text-slate-500 mt-1">{help}</div>}
    </label>
  );
}


/**
 * Two-up card picker for the Workbench's primary Source mode-switch
 * (Camera / Upload). Distinct from ``ModeBtn`` because:
 *
 *   - It's the form's top-level decision — clicking the wrong card
 *     changes whether anything posts to Helix at all, so the affordance
 *     gets icon + title + tagline + bigger touch target.
 *   - Active state uses a strong sky border + outer ring + glow that
 *     matches the canvas's selected-node treatment, so operators
 *     internalize one "this is the active thing" pattern across the
 *     app.
 *   - The optional ``badge`` slot lets the Upload card call out
 *     "DRY RUN" without burying the warning in the tagline.
 */
function SourceCard({
  active,
  icon,
  title,
  tagline,
  badge,
  onClick,
}: {
  active: boolean;
  icon: string;
  title: string;
  tagline: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative text-left px-4 py-3 rounded-lg border-2 transition duration-150 ease-out-strong ${
        active
          ? "bg-sky-950/50 border-sky-500 ring-2 ring-sky-500/30 shadow-[0_0_20px_rgba(56,189,248,0.25)]"
          : "bg-white/5 border-white/10 hover:border-sky-500/60 hover:bg-white/10"
      }`}
    >
      {badge && (
        <span
          className={`absolute top-2 right-2 text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded ${
            active
              ? "bg-amber-500/20 text-amber-200 border border-amber-500/40"
              : "bg-white/5 text-slate-400 border border-white/15"
          }`}
        >
          {badge}
        </span>
      )}
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none mt-0.5" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0">
          <div
            className={`text-sm font-semibold ${
              active ? "text-sky-100" : "text-slate-100"
            }`}
          >
            {title}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">
            {tagline}
          </div>
        </div>
      </div>
    </button>
  );
}


function ModeBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-3 py-1.5 rounded border text-xs ${
        active
          ? "bg-sky-950/50 border-sky-500 text-sky-100"
          : "bg-white/5 border-white/15 text-slate-300 hover:border-sky-500"
      }`}
    >
      {children}
    </button>
  );
}



/**
 * Live cost-estimate panel for the Workbench upload mode.
 *
 * Gemini bills by *tokens*, not bytes. For media that means roughly:
 *
 *   - **Video** (default media resolution): ~263 tokens per second of
 *     video. So a 60-second clip ≈ 16k input tokens before any prompt.
 *   - **Image**: ~258 tokens per image, regardless of pixel count
 *     (Gemini downsamples to a fixed budget).
 *
 * We add a small prompt-token allowance (~1k, a reasonable ceiling for
 * the analyze prompts the templates ship with) and assume ~500 output
 * tokens (most templates request short structured JSON). The display
 * shows the breakdown so an operator can see *why* one model is 10× the
 * cost of another and pick accordingly.
 *
 * These are explicit estimates — the post-run Stats page reports the
 * actual numbers from Gemini's usage_metadata. We label as
 * "estimated" everywhere to keep the contract honest.
 */
const VIDEO_TOKENS_PER_SEC = 263;
const IMAGE_TOKENS = 258;
const PROMPT_TOKEN_BUDGET = 1000;
const OUTPUT_TOKEN_BUDGET = 500;


function formatDuration(secs: number): string {
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs - m * 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}


function formatCost(usd: number): string {
  if (usd < 0.01) return `< $0.01`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}


function CostEstimate({
  model,
  durationSec,
  pricing,
  hasFile,
}: {
  model: string;
  durationSec: number | null;
  pricing:
    | { model: string; input_per_1m_usd: number; output_per_1m_usd: number }[]
    | null;
  hasFile: boolean;
}) {
  // Show a soft placeholder when there's no file yet so the line item
  // is discoverable even before the operator picks anything.
  if (!hasFile) {
    return (
      <div className="text-[11px] text-slate-500 italic mt-1.5">
        Pick a file to see the estimated cost.
      </div>
    );
  }

  // Probing video duration takes a tick after the file lands. Hold
  // the slot so the layout doesn't jump when the value populates.
  if (durationSec === null) {
    return (
      <div className="text-[11px] text-slate-500 italic mt-1.5">
        Reading file metadata…
      </div>
    );
  }

  const row = pricing?.find((p) => p.model === model);
  if (!row) {
    // Pricing didn't load (offline first boot before the cron seeded,
    // unrecognized model, etc.). Don't pretend to estimate — telling
    // the user nothing is better than telling them $0.
    return (
      <div className="text-[11px] text-slate-500 italic mt-1.5">
        No pricing data on file for {model} — try again after the daily
        pricing refresh.
      </div>
    );
  }

  const isVideo = durationSec > 0;
  const mediaTokens = isVideo
    ? Math.ceil(durationSec * VIDEO_TOKENS_PER_SEC)
    : IMAGE_TOKENS;
  const inputTokens = mediaTokens + PROMPT_TOKEN_BUDGET;
  const inputCost = (inputTokens / 1_000_000) * row.input_per_1m_usd;
  const outputCost =
    (OUTPUT_TOKEN_BUDGET / 1_000_000) * row.output_per_1m_usd;
  const total = inputCost + outputCost;

  return (
    <div className="mt-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-slate-300 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-100">
          Estimated cost: ~{formatCost(total)}
        </span>
        <span className="text-[10px] text-slate-500 italic">
          per run · pre-discount estimate
        </span>
      </div>
      <div className="font-mono text-[10.5px] text-slate-400 leading-relaxed">
        {isVideo ? (
          <>
            {mediaTokens.toLocaleString()} video tokens
            {" "}
            <span className="text-slate-500">({durationSec.toFixed(1)}s × {VIDEO_TOKENS_PER_SEC}/s)</span>
            {" + "}
            {PROMPT_TOKEN_BUDGET.toLocaleString()} prompt
            {" → "}
            {formatCost(inputCost)}{" "}
            <span className="text-slate-500">
              (${row.input_per_1m_usd.toFixed(2)}/M)
            </span>
          </>
        ) : (
          <>
            {IMAGE_TOKENS.toLocaleString()} image tokens + {PROMPT_TOKEN_BUDGET.toLocaleString()} prompt
            {" → "}
            {formatCost(inputCost)}{" "}
            <span className="text-slate-500">
              (${row.input_per_1m_usd.toFixed(2)}/M)
            </span>
          </>
        )}
      </div>
      <div className="font-mono text-[10.5px] text-slate-400 leading-relaxed">
        ~{OUTPUT_TOKEN_BUDGET} output tokens
        {" → "}
        {formatCost(outputCost)}{" "}
        <span className="text-slate-500">
          (${row.output_per_1m_usd.toFixed(2)}/M)
        </span>
      </div>
      <div className="text-[10px] text-slate-500 italic pt-0.5">
        Actual cost shows up on the Stats page after the run. Google's
        billing is the source of truth.
      </div>
    </div>
  );
}


/** Whether a paired template's Helix type already exists on the org.
 *
 *  Matched by uid first, then name (case-insensitive) — the uid is what
 *  templates ship, but types created by hand in older orgs often only
 *  line up by name.
 */
function pairedTypeExists(
  synced: { event_type_uid: string; name?: string | null }[],
  paired?: { event_type_uid: string; name: string },
): boolean {
  if (!paired) return false;
  return synced.some(
    (et) =>
      (paired.event_type_uid && et.event_type_uid === paired.event_type_uid) ||
      (paired.name &&
        (et.name ?? "").toLowerCase() === paired.name.toLowerCase()),
  );
}

interface ComposedAnalytic {
  name: string;
  summary?: string;
  prompt: string;
  helix_event_type: {
    event_type_uid: string;
    name: string;
    event_schema: Record<string, string>;
  };
  helix_attribute_mapping: Record<string, string>;
  model?: string;
}

interface SavedAnalytic extends ComposedAnalytic {
  id: string;
  created_at: string;
}

/** Describe an analytic in words; get back a prompt, a Helix event type
 *  and the mapping between them.
 *
 *  Those three have to agree — every JSON key the prompt promises needs
 *  an attribute, and every attribute needs a key — and writing them by
 *  hand is where people come unstuck. Generating them together is the
 *  only way they stay consistent, so the model is asked for all three at
 *  once and the server rejects a set that does not line up.
 */
function AnalyticComposer({
  geminiConnectionId,
  onUse,
  onSaved,
  defaultOpen = false,
}: {
  geminiConnectionId: string | null;
  onUse: (a: ComposedAnalytic) => void;
  onSaved: () => void;
  defaultOpen?: boolean;
}) {
  const [intent, setIntent] = useState("");
  // Open when there is no prompt yet — that is the moment this is the
  // obvious next move rather than one option among several.
  const [open, setOpen] = useState(defaultOpen);
  const [used, setUsed] = useState(false);

  const compose = useMutation({
    mutationFn: () =>
      apiPost<ComposedAnalytic>("/api/byoa/compose", {
        intent,
        gemini_connection_id: geminiConnectionId,
      }),
  });

  const save = useMutation({
    mutationFn: (a: ComposedAnalytic) =>
      apiPost<SavedAnalytic>("/api/byoa/analytics", {
        name: a.name,
        summary: a.summary,
        prompt: a.prompt,
        helix_event_type: a.helix_event_type,
        helix_attribute_mapping: a.helix_attribute_mapping,
      }),
    onSuccess: onSaved,
  });

  const a = compose.data;

  return (
    <div className="mb-4 rounded-lg border border-white/15 bg-white/5 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <span className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/10 text-slate-300 text-xs"
          >
            ✦
          </span>
          <span>
            <span className="block text-sm text-slate-100">
              Describe an analytic and have it built
            </span>
            <span className="block text-[11px] text-slate-400 mt-0.5">
              Say what the camera should watch for — vFusion writes the prompt,
              the Helix event type and the mapping between them.
            </span>
          </span>
        </span>
        <span className="text-xs text-slate-400 shrink-0 mt-0.5">
          {open ? "Hide" : "Open"}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={2}
            placeholder="e.g. tell me when a delivery van is parked in the driveway, and who the carrier is"
            className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => compose.mutate()}
              disabled={!intent.trim() || compose.isPending}
              className="text-sm px-3 py-1.5 rounded bg-sky-600 text-white disabled:opacity-40"
            >
              {compose.isPending ? "Building…" : "Build it"}
            </button>
            <span className="text-[11px] text-slate-500">
              Two or three fields, worked examples, and a cap on free text —
              the things that make these reliable.
            </span>
          </div>

          {compose.isError && (
            <p className="text-xs text-rose-300">
              {(compose.error as Error).message}
            </p>
          )}

          {a && (
            <div className="mt-2 rounded border border-slate-700 bg-slate-950/60 p-3 space-y-3">
              <div>
                <div className="text-sm text-slate-100">{a.name}</div>
                {a.summary && (
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {a.summary}
                  </div>
                )}
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">
                  Helix event type · {a.helix_event_type.name}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(a.helix_event_type.event_schema).map((attr) => (
                    <span
                      key={attr}
                      className="text-[11px] px-2 py-0.5 rounded border border-white/10 bg-white/5 text-slate-300 font-mono"
                      title={a.helix_attribute_mapping[attr]}
                    >
                      {attr}
                    </span>
                  ))}
                </div>
              </div>

              <details>
                <summary className="text-[11px] text-slate-500 cursor-pointer">
                  The prompt it wrote
                </summary>
                <pre className="mt-1 text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-56 overflow-y-auto">
                  {a.prompt}
                </pre>
              </details>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onUse(a);
                    setUsed(true);
                    window.setTimeout(() => setUsed(false), 2000);
                  }}
                  className="text-sm px-3 py-1.5 rounded bg-sky-600 text-white transition-colors duration-200 ease-out-strong"
                >
                  {used ? "Loaded below ↓" : "Use it"}
                </button>
                <button
                  type="button"
                  onClick={() => save.mutate(a)}
                  disabled={save.isPending || save.isSuccess}
                  className="text-sm px-3 py-1.5 rounded border border-slate-600 text-slate-200 hover:border-sky-500 disabled:opacity-40"
                >
                  {save.isSuccess ? "Saved" : save.isPending ? "Saving…" : "Save for reuse"}
                </button>
                {a.model && (
                  <span className="text-[11px] text-slate-600">
                    written by {a.model}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                "Use it" loads the prompt and turns on Helix posting — vFusion
                will offer to create the event type on your org if it does not
                exist yet. Nothing is written to Verkada until then.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


/** "It works — now make it keep happening."
 *
 *  A one-shot run already carries everything a flow needs except what
 *  starts it: the connections, the camera, live-vs-clip, the model, the
 *  prompt, the Helix type and the mapping. The hard part of building
 *  this by hand is not the graph, it is the wiring — getting
 *  {{ steps.analyze.output.json.x }} into the right Helix attribute —
 *  and that is already known here. So this asks the one open question
 *  and assembles the rest.
 */
function MakeItRun({
  ranOnce,
  analyticName,
  prompt,
  model,
  mode,
  cameraId,
  verkadaConnId,
  geminiConnId,
  helixEventTypeUid,
  needsHelixType,
  helixMapping,
  durationSec,
}: {
  ranOnce: boolean;
  analyticName: string;
  prompt: string;
  model: string;
  mode: "live" | "historical";
  cameraId: string;
  verkadaConnId: string | null;
  geminiConnId: string | null;
  helixEventTypeUid: string;
  needsHelixType: boolean;
  helixMapping: Record<string, string> | null;
  durationSec: number;
}) {
  const navigate = useNavigate();
  const [when, setWhen] = useState<"camera" | "schedule">("camera");
  const [objects, setObjects] = useState("person");
  const [everyMinutes, setEveryMinutes] = useState(15);
  // Naming what is missing beats a greyed button with no explanation.
  // The Helix type matters most: a flow built before it exists writes to
  // an event type that is not there, and the failure only shows up on
  // the first real run.
  const missing = [
    !verkadaConnId && "a Verkada connection",
    !geminiConnId && "a Gemini connection",
    !cameraId && "a camera",
    !prompt.trim() && "a prompt",
    needsHelixType && !helixEventTypeUid && "the Helix event type — create it above",
  ].filter(Boolean) as string[];
  const ready = missing.length === 0;

  const create = useMutation({
    mutationFn: () => {
      // A camera-triggered run analyses the event that fired it; a
      // scheduled one has no event, so it looks at the camera now.
      const byEvent = when === "camera";
      const analyzeConfig: Record<string, unknown> = {
        connection_id: verkadaConnId,
        gemini_connection_id: geminiConnId,
        camera_id: byEvent ? "{{ trigger.data.camera_id }}" : cameraId,
        model,
        prompt,
      };
      if (mode === "historical") {
        analyzeConfig.start_epoch = byEvent ? "{{ trigger.data.created }}" : "";
        analyzeConfig.duration_sec = String(durationSec);
        analyzeConfig.pre_roll_sec = "2";
      }

      const nodes: Record<string, unknown>[] = [
        {
          id: "analyze",
          name: "analyze",
          label: "Analyze the camera",
          kind: "action",
          action_type: "gemini_analyze_camera",
          // No position: the editor computes the layout when one is
          // absent, which is the same thing "Auto arrange" does. Guessing
          // coordinates here put this node on top of the trigger the
          // canvas draws above it.
          config: analyzeConfig,
        },
      ];
      const edges: Record<string, unknown>[] = [];

      if (helixEventTypeUid) {
        // Rewrite the template-local {{ output.* }} shorthand to point at
        // the analyze step, which is what the engine resolves.
        const attributes = Object.fromEntries(
          Object.entries(helixMapping ?? {}).map(([attr, ref]) => [
            attr,
            ref.replace(/output\./g, "steps.analyze.output."),
          ]),
        );
        nodes.push({
          id: "post_helix",
          name: "post_helix",
          label: "Post to Helix",
          kind: "action",
          action_type: "verkada_helix_event",
          config: {
            connection_id: verkadaConnId,
            camera_id: byEvent ? "{{ trigger.data.camera_id }}" : cameraId,
            event_type_uid: helixEventTypeUid,
            attributes: Object.keys(attributes).length
              ? attributes
              : { Summary: "{{ steps.analyze.output.text }}" },
          },
        });
        edges.push({ id: "e_analyze_helix", source: "analyze", target: "post_helix" });
      }

      return apiPost<{ id: string }>("/api/flows", {
        name: `${analyticName} — auto`,
        // Off until it is looked at. A flow that starts firing on every
        // motion event the moment a button is pressed is a surprise bill
        // and a surprise write to someone's Helix log.
        enabled: false,
        trigger_type: byEvent ? "verkada_webhook" : "schedule",
        trigger_config: byEvent
          ? {
              family: "camera",
              notification_type: "alert_rule_motion",
              filters: { camera_id: cameraId, ...(objects ? { objects } : {}) },
            }
          : { kind: "interval", every_minutes: everyMinutes },
        nodes,
        edges,
      });
    },
    onSuccess: (flow) => navigate(`/flows/${flow.id}/edit`),
  });

  return (
    // Tied to the card above rather than floating under it: a short
    // connector and an ordinal say this is the next step in the same
    // task, which is what it is. Left on its own it read as a footnote
    // that happened to land there.
    <div className="relative pt-8">
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-0 h-8 w-px -translate-x-1/2 bg-gradient-to-b from-transparent to-white/15"
      />
      <div
        className={`rounded-lg border p-4 transition-colors duration-300 ease-out-strong ${
          ranOnce
            ? "border-sky-500/30 bg-sky-500/[0.06]"
            : "border-white/15 bg-white/5"
        }`}
      >
        <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">
          {ranOnce ? "It works — now keep it running" : "Next"}
        </div>
        <div className="text-sm text-slate-100">Make this run on its own</div>
        <p className="text-[11px] text-slate-400 mt-0.5 mb-3">
          Everything above carries over — camera, prompt, model and the Helix
          mapping. The only open question is what starts it.
        </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <ModeBtn active={when === "camera"} onClick={() => setWhen("camera")}>
          When this camera sees something
        </ModeBtn>
        <ModeBtn active={when === "schedule"} onClick={() => setWhen("schedule")}>
          On a schedule
        </ModeBtn>
      </div>

      {when === "camera" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[11px] text-slate-400">Run when it detects</span>
          <select
            value={objects}
            onChange={(e) => setObjects(e.target.value)}
            className="px-2 py-1 rounded bg-white/5 border border-white/15 text-sm"
          >
            <option value="person">a person</option>
            <option value="vehicle">a vehicle</option>
            <option value="animal">an animal</option>
            <option value="">anything moving</option>
          </select>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[11px] text-slate-400">Run every</span>
          <select
            value={everyMinutes}
            onChange={(e) => setEveryMinutes(Number(e.target.value))}
            className="px-2 py-1 rounded bg-white/5 border border-white/15 text-sm"
          >
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>hour</option>
            <option value={360}>6 hours</option>
            <option value={1440}>day</option>
          </select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mt-4">
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={!ready || create.isPending}
          className="text-sm px-4 py-2 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
        >
          {create.isPending ? "Building…" : "Build the flow"}
        </button>
        <span className="text-[11px] text-slate-500">
          Opens in the flow editor, switched off. Nothing runs until you enable
          and save it.
        </span>
      </div>
      {!ready && (
        <p className="text-[11px] text-amber-400/80 mt-2">
          Still needs {missing.join(", ")}.
        </p>
      )}
        {create.isError && (
          <p className="text-xs text-rose-300 mt-2">
            {(create.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}
