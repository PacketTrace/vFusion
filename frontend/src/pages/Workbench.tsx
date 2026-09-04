import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import Byoa from "./Byoa";


/**
 * The Workbench: a one-shot Gemini run against a real camera.
 *
 * It had a second tab for Helix event types. That grew a demo-data
 * generator alongside it and stopped being a sidecar to prompt testing,
 * so it moved out to its own destination — and a tab strip with one tab
 * left in it is just a line.
 */
export default function Workbench() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // ?tab=helixr is in links written before Helix had its own page, and
  // in anything an operator bookmarked. Send them where it went rather
  // than showing them a page missing the thing they asked for.
  const wantsHelix = searchParams.get("tab") === "helixr";
  useEffect(() => {
    if (wantsHelix) navigate("/helix", { replace: true });
  }, [wantsHelix, navigate]);
  if (wantsHelix) return null;

  return (
    <div className="space-y-6">
      <div className="max-w-6xl">
        <h1 className="text-2xl font-semibold text-white">Workbench</h1>
        <p className="text-slate-400 text-sm mt-1">
          One-shot Gemini run. Pick a camera, write a prompt, see what comes
          back without baking it into a flow first.
        </p>
      </div>
      <Byoa />
    </div>
  );
}
