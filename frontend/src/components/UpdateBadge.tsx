import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost } from "../lib/api";

/**
 * "There is a newer vFusion" — and the exact command to get it.
 *
 * Deliberately not a button that updates anything. A container cannot
 * replace itself, and the only way to give it that power is to hand the
 * app the Docker socket, which is root on the host. For something whose
 * whole job is holding a key that opens doors, that is the wrong trade.
 * So this tells you and gets out of the way.
 *
 * It renders nothing at all when there is no update, when the check
 * failed, or when this version has been dismissed. That is most days:
 * the component's normal state is invisible, which is why it can afford
 * to be a coloured dot when it does appear.
 */

interface UpdateInfo {
  enabled: boolean;
  channel: string;
  current: string;
  latest: string | null;
  name?: string | null;
  url: string;
  published_at?: string | null;
  prerelease?: boolean;
  update_available: boolean;
  dismissed: boolean;
  checked: boolean;
  error?: string | null;
}

/** What the operator runs. Kept here because it is what the popover is
 *  for — a version number nobody can act on is just an interruption.
 *
 *  Deliberately without a `cd`. The install directory is whatever the
 *  operator cloned into, and a guessed path that is wrong is worse than
 *  no path at all: it looks authoritative, fails, and sends someone
 *  looking for a problem that is not there. The label above it says
 *  where to run it. */
const COMMAND = "./update.sh";

export default function UpdateBadge() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["update-check"],
    queryFn: () => apiGet<UpdateInfo>("/api/update"),
    // The backend caches for six hours; this only decides how often a
    // long-lived tab re-reads that cache.
    staleTime: 30 * 60_000,
    refetchInterval: 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const info = q.data;

  const dismiss = useMutation({
    mutationFn: (version: string) => apiPost("/api/update/dismiss", { version }),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["update-check"] });
    },
  });

  // Click-outside and Escape. A popover you cannot leave without
  // clicking the one right button is a modal wearing a disguise.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  if (!info?.update_available || info.dismissed) return null;

  const published = info.published_at
    ? new Date(info.published_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-emerald-200 hover:text-white px-2.5 py-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
        title={`vFusion ${info.latest} is available — you are on ${info.current}`}
      >
        <span className="update-dot" aria-hidden />
        <span className="hidden sm:inline">Update</span>
        <span className="font-mono">{info.latest}</span>
      </button>

      {open && (
        <div
          className="animate-value-picker absolute right-0 top-full mt-2 w-[22rem] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg border border-white/10 bg-slate-900 shadow-2xl shadow-black/60 p-4 z-50"
          style={{ transformOrigin: "top right" }}
          role="dialog"
          aria-label="Update available"
        >
          <div className="text-sm font-medium text-white">
            {info.name || `vFusion ${info.latest}`}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            You are running {info.current}
            {published ? ` · released ${published}` : ""}
            {info.prerelease ? " · pre-release" : ""}
          </div>

          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">
              Run this in your vFusion directory
            </div>
            <pre className="text-[11px] font-mono text-slate-200 bg-black/40 border border-white/10 rounded-md px-3 py-2 whitespace-pre overflow-x-auto">
{COMMAND}
            </pre>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(COMMAND).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
              className="mt-2 text-xs text-slate-300 hover:text-white px-2.5 py-1.5 rounded-md border border-white/15 hover:bg-white/10 transition-colors"
            >
              {copied ? "Copied" : "Copy command"}
            </button>
          </div>

          <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
            vFusion never updates itself. The script pulls the new images,
            runs the migrations and restarts the stack. Back up the
            Postgres volume first if this install matters.
          </p>

          <div className="flex items-center gap-3 mt-3 pt-3 border-t border-white/10">
            <a
              href={info.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-sky-300 hover:text-sky-200"
            >
              Release notes ↗
            </a>
            <button
              type="button"
              onClick={() => info.latest && dismiss.mutate(info.latest)}
              disabled={dismiss.isPending}
              className="ml-auto text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
