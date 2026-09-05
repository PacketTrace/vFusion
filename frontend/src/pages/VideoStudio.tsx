import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { API_BASE, apiDelete, apiGet, apiPost } from "../lib/api";

/**
 * Ask for a clip that looks like it came off a security camera.
 *
 * Most of this form is not about the scene — it is about the camera.
 * Where it is mounted, what it can and cannot resolve, what the light is
 * doing. Those decide whether the result reads as surveillance or as an
 * advert, and they are the part an operator would not think to type.
 *
 * Generation takes minutes and costs real money, so the prompt is
 * readable before you commit to it, and every job is kept with the
 * prompt that produced it — a clip that came out wrong is only useful
 * if you can see what was actually asked for.
 */

interface Job {
  id: string;
  at: string;
  status: "queued" | "running" | "done" | "failed" | "interrupted";
  scene: string;
  setting: string;
  vantage: string;
  duration_seconds: number;
  resolution: string;
  model: string;
  prompt: string;
  error: string | null;
  bytes?: number;
  waited_sec?: number;
}

interface Options {
  vantages: Record<string, string>;
  settings: Record<string, string>;
  lighting: Record<string, string>;
  activity: Record<string, string>;
  // Per-second rates live in the backend, which is also what records
  // the spend — one copy, so the estimate and the ledger cannot
  // disagree about what a clip cost.
  price_per_second: Record<string, Record<string, number>>;
}

const MODELS = [
  ["veo-3.1-fast-generate-preview", "Fast — cheapest sensible default"],
  ["veo-3.1-generate-preview", "Standard — best quality, 4× the price"],
  ["veo-3.1-lite-generate-preview", "Lite — cheapest"],
] as const;

function titleise(k: string): string {
  return k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default function VideoStudio() {
  const qc = useQueryClient();
  const [scene, setScene] = useState("");
  const [setting, setSetting] = useState("retail_checkout");
  const [vantage, setVantage] = useState("ceiling_dome");
  const [lighting, setLighting] = useState("daylight_indoor");
  const [activity, setActivity] = useState("one_person");
  const [framing, setFraming] = useState<"general" | "focused">("general");
  const [focusTarget, setFocusTarget] = useState("");
  const [duration, setDuration] = useState(8);
  const [resolution, setResolution] = useState("720p");
  const [model, setModel] = useState<string>(MODELS[0][0]);
  const [extra, setExtra] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const options = useQuery({
    queryKey: ["video-options"],
    queryFn: () => apiGet<Options>("/api/video/options"),
  });

  const body = {
    scene,
    setting,
    vantage,
    lighting,
    activity,
    framing,
    focus_target: focusTarget,
    duration_seconds: duration,
    resolution,
    model,
    extra,
  };

  const jobs = useQuery({
    queryKey: ["video-jobs"],
    queryFn: () => apiGet<Job[]>("/api/video/jobs"),
    // Only while something is in flight — generation takes minutes and
    // polling a settled list is just noise on the network tab.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((j) => j.status === "queued" || j.status === "running")
        ? 5000
        : false,
  });

  const preview = useQuery({
    queryKey: ["video-prompt", body],
    queryFn: () => apiPost<{ prompt: string }>("/api/video/preview-prompt", body),
    enabled: showPrompt && !!scene.trim(),
  });

  const generate = useMutation({
    mutationFn: () => apiPost<Job>("/api/video/generate", body),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["video-jobs"] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/video/jobs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["video-jobs"] }),
  });

  const perSec = options.data?.price_per_second?.[model]?.[resolution];
  const estimate = perSec != null ? perSec * duration : null;

  const opts = options.data;

  return (
    <div className="space-y-4">
      <div className="max-w-3xl">
        <p className="text-slate-400 text-sm">
          Generate footage that looks like it came off a fixed camera. Most of
          these settings describe the <i>camera</i> rather than the scene —
          where it is mounted, what the light is doing — because that is what
          decides whether the result reads as surveillance.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border border-white/15 bg-white/5 p-4 space-y-3">
          <label className="block">
            <div className="text-xs text-slate-300 mb-1">What happens</div>
            <textarea
              value={scene}
              onChange={(e) => setScene(e.target.value)}
              rows={3}
              placeholder="e.g. a customer puts two folded shirts on the counter and taps a card on the terminal"
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm resize-y"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="Place"
              value={setting}
              onChange={setSetting}
              options={opts?.settings}
            />
            <Select
              label="Where the camera is"
              value={vantage}
              onChange={setVantage}
              options={opts?.vantages}
            />
            <Select
              label="Light"
              value={lighting}
              onChange={setLighting}
              options={opts?.lighting}
            />
            <Select
              label="Who is in frame"
              value={activity}
              onChange={setActivity}
              options={opts?.activity}
            />
          </div>

          <div>
            <div className="text-xs text-slate-300 mb-1">Aim</div>
            <div className="flex gap-1.5">
              {(
                [
                  ["general", "General coverage"],
                  ["focused", "Pointed at something"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setFraming(v)}
                  className={`text-[11px] px-2 py-1 rounded border ${
                    framing === v
                      ? "border-sky-600 bg-sky-900/40 text-white"
                      : "border-white/10 text-slate-400 hover:bg-white/5"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {framing === "focused" && (
              <input
                value={focusTarget}
                onChange={(e) => setFocusTarget(e.target.value)}
                placeholder="the till and card terminal"
                className="w-full mt-2 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              />
            )}
            <p className="text-[11px] text-slate-500 mt-1">
              Point it at something when the clip has to show the thing a Helix
              event is about. Otherwise general coverage looks more like a real
              install.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">Seconds</div>
              <select
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {[4, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">Resolution</div>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
              </select>
            </label>
            <label className="block">
              <div className="text-xs text-slate-300 mb-1">Model</div>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {MODELS.map(([id, label]) => (
                  <option key={id} value={id} title={label}>
                    {label.split(" — ")[0]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <div className="text-xs text-slate-300 mb-1">
              Anything else <span className="text-slate-600">optional</span>
            </div>
            <input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="appended to the prompt verbatim"
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            />
          </label>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => generate.mutate()}
              disabled={!scene.trim() || generate.isPending}
              className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 text-white text-sm disabled:opacity-40"
            >
              {generate.isPending ? "Requesting…" : "Generate"}
            </button>
            {estimate != null ? (
              <span className="text-xs text-slate-400">
                about ${estimate.toFixed(2)} · {duration}s at {resolution} ·
                lands on the Stats page
              </span>
            ) : (
              <span className="text-xs text-amber-300">
                No published rate for this model — cost unknown until it runs
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowPrompt((v) => !v)}
              className="text-[11px] text-sky-400 hover:text-sky-300 ml-auto"
            >
              {showPrompt ? "hide prompt" : "see the prompt first"}
            </button>
          </div>
          {err && <div className="text-sm text-rose-300">{err}</div>}

          {showPrompt && (
            <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap bg-black/30 border border-white/10 rounded p-2 max-h-64 overflow-y-auto">
              {preview.data?.prompt ?? "Describe the scene first."}
            </pre>
          )}
        </div>

        <div className="space-y-2">
          {(jobs.data ?? []).length === 0 && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-sm text-slate-500">
              Clips land here. Generation takes a few minutes — you can leave
              the page, the job keeps running.
            </div>
          )}
          {(jobs.data ?? []).map((j) => (
            <div
              key={j.id}
              className="rounded-lg border border-white/15 bg-white/5 p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-slate-100 line-clamp-2">
                    {j.scene}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {titleise(j.setting)} · {j.duration_seconds}s · {j.resolution}
                    {j.bytes ? ` · ${Math.round(j.bytes / 1024)} KB` : ""}
                    {j.waited_sec ? ` · took ${j.waited_sec}s` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove.mutate(j.id)}
                  className="text-xs text-slate-500 hover:text-rose-300 px-1 shrink-0"
                  title="Delete the job and its clip"
                >
                  ×
                </button>
              </div>

              {(j.status === "queued" || j.status === "running") && (
                <div className="flex items-center gap-2 text-xs text-sky-300">
                  <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                  {j.status === "queued" ? "Queued…" : "Generating — a few minutes"}
                </div>
              )}
              {j.status === "done" && (
                <video
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full rounded border border-white/10 bg-black"
                  src={`${API_BASE}/api/video/file/${j.id}`}
                />
              )}
              {(j.status === "failed" || j.status === "interrupted") && (
                <div className="text-xs text-rose-300">{j.error}</div>
              )}

              <button
                type="button"
                onClick={() => setOpenPrompt(openPrompt === j.id ? null : j.id)}
                className="text-[11px] text-slate-500 hover:text-slate-300"
              >
                {openPrompt === j.id ? "hide" : "what was asked for"}
              </button>
              {openPrompt === j.id && (
                <pre className="text-[10px] text-slate-500 font-mono whitespace-pre-wrap bg-black/30 border border-white/10 rounded p-2 max-h-48 overflow-y-auto">
                  {j.prompt}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Record<string, string> | undefined;
}) {
  return (
    <label className="block">
      <div className="text-xs text-slate-300 mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
      >
        {Object.keys(options ?? {}).map((k) => (
          <option key={k} value={k} title={options?.[k]}>
            {titleise(k)}
          </option>
        ))}
      </select>
    </label>
  );
}
