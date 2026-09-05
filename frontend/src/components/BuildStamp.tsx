import { useQuery } from "@tanstack/react-query";

import { apiGet, PublicConfig } from "../lib/api";

/**
 * Which build is actually running, front and back.
 *
 * "Is this the new one, or did the restart not take?" came up enough
 * times while building this to be worth answering on the page rather
 * than by reading container logs.
 *
 * The frontend's id needs no build-time plumbing: Vite already emits a
 * content-hashed bundle name, so the hash in the script tag *is* the
 * build. The backend derives its own from a digest of the source. Both
 * change when the code changes and only then.
 */

/** The hash Vite put in the bundle filename, e.g. index-D3319ZVI.js. */
function frontendBuild(): string {
  try {
    const scripts = Array.from(document.querySelectorAll("script[src]"));
    for (const s of scripts) {
      const src = (s as HTMLScriptElement).src;
      const m = src.match(/index-([A-Za-z0-9_-]{6,})\.js/);
      if (m?.[1]) return m[1].slice(0, 8);
    }
  } catch {
    /* no DOM access is not worth failing over */
  }
  return "dev";
}

const FRONTEND = frontendBuild();

export default function BuildStamp() {
  const cfg = useQuery({
    queryKey: ["public-config"],
    queryFn: () => apiGet<PublicConfig>("/api/config"),
    staleTime: 60_000,
  });

  const backend = cfg.data?.build ?? "…";
  const started = cfg.data?.started_at
    ? new Date(cfg.data.started_at)
    : null;

  return (
    <span
      className="text-[10px] font-mono text-slate-600 hover:text-slate-400 transition-colors cursor-default"
      title={
        `frontend ${FRONTEND}\nbackend ${backend}` +
        (started ? `\nbackend started ${started.toLocaleString()}` : "") +
        "\n\nBoth change only when their code does. If one looks stale " +
        "after a deploy, that container did not rebuild."
      }
    >
      {FRONTEND}·{backend}
    </span>
  );
}
