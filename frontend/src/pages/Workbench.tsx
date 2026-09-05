import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import ApiRunner from "./ApiRunner";
import VideoStudio from "./VideoStudio";
import Byoa from "./Byoa";

/**
 * The Workbench: the bench you try things on before committing them to
 * a flow. Composing an analytic against a real camera, and running a
 * Verkada endpoint to see what it actually returns, are the same kind
 * of act — poke it, read the answer, keep what works.
 */

const TABS = [
  { key: "analytics", label: "Analytics builder" },
  { key: "api", label: "API runner" },
  { key: "video", label: "Video" },
] as const;

const BLURB: Record<string, string> = {
  analytics:
    "One-shot Gemini run. Pick a camera, write a prompt, see what comes back without baking it into a flow first.",
  api: "Run any Verkada endpoint against a connection you already have, and read the response properly.",
  video: "Generate footage that looks like it came off a fixed security camera.",
};

export default function Workbench() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // ?tab=helixr is in links written before Helix had its own page, and
  // in anything an operator bookmarked. Send them where it went rather
  // than showing them a page missing the thing they asked for.
  const requested = searchParams.get("tab");
  const wantsHelix = requested === "helixr";
  useEffect(() => {
    if (wantsHelix) navigate("/helix", { replace: true });
  }, [wantsHelix, navigate]);
  if (wantsHelix) return null;

  // ?tab=byoa predates these tabs and means the analytics builder.
  const tab =
    requested === "api" ? "api" : requested === "video" ? "video" : "analytics";
  const setTab = (next: string) => {
    const p = new URLSearchParams(searchParams);
    p.set("tab", next);
    setSearchParams(p, { replace: true });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Workbench</h1>
        <p className="text-slate-400 text-sm mt-1 max-w-3xl">{BLURB[tab]}</p>
        <div className="mt-4 flex items-center gap-1 border-b border-white/10">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === t.key
                  ? "border-sky-500 text-white"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "analytics" && <Byoa />}
      {tab === "api" && <ApiRunner />}
      {tab === "video" && <VideoStudio />}
    </div>
  );
}
