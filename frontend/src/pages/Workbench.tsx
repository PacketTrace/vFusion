import { useSearchParams } from "react-router-dom";

import Byoa from "./Byoa";
import Helixr from "./Helixr";


/**
 * Workbench has two sections, picked via ``?tab=`` so URLs stay shareable
 * and "Run it back" links from past runs keep working:
 *
 *   - **BYOA** (Brew Your Own Analytics): one-shot Gemini test runner.
 *     Pick a camera, write a prompt, see what the model returns —
 *     without committing to a flow first.
 *
 *   - **Helix**: manage Helix video-tagging event types for a Verkada
 *     org. Same data the flow editor's helix_event_ref dropdown reads,
 *     but writable — create new types and edit existing ones in place.
 */

type Tab = "byoa" | "helixr";

const TABS: { key: Tab; label: string; blurb: string }[] = [
  {
    key: "byoa",
    // The tab is "Build" and the URL is still ?tab=byoa: renaming the
    // label is cosmetic, renaming the param would break every "Run it
    // back" link already sitting in a Runs row.
    label: "Build",
    blurb:
      "One-shot Gemini run. Pick a camera, write a prompt, see what comes back without baking it into a flow first.",
  },
  {
    key: "helixr",
    // "Helix" is what Verkada calls it, so it is what everyone reading
    // this already knows it as. The URL keeps ?tab=helixr: renaming a
    // label is cosmetic, renaming the param would break links.
    label: "Helix",
    blurb:
      "Verkada's Helix event types — the schemas your AI results are written into. Create one, edit its attributes, or delete one you no longer post against. Types only: the events themselves are posted by flows and by Build.",
  },
];


export default function Workbench() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: Tab = requested === "helixr" ? "helixr" : "byoa";
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(searchParams);
    p.set("tab", next);
    setSearchParams(p, { replace: true });
  };
  const meta = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <div className="space-y-6">
      <div className="max-w-6xl">
        <h1 className="text-2xl font-semibold text-white">Workbench</h1>
        <p className="text-slate-400 text-sm mt-1">{meta.blurb}</p>

        <div className="mt-4 flex items-center gap-1 border-b border-white/10">
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {t.label}
                {active && (
                  <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-sky-500" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Neither tab constrains its own width. They did it differently
          before -- Build through its own wrapper, Helix through this
          one -- so the content jumped between two widths on switching,
          and on a wide screen sat well left of the container it was
          nominally centred in. The shell is already 1600px and centred;
          a narrower box inside it with no mx-auto only anchors left. */}
      <div>
        {tab === "byoa" && <Byoa />}
        {tab === "helixr" && <Helixr />}
      </div>
    </div>
  );
}
