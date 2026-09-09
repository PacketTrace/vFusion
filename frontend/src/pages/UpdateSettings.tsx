import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiGet, apiPost, PublicConfig } from "../lib/api";

/**
 * Updates — the state the header badge deliberately refuses to show.
 *
 * The badge renders nothing when there is nothing to do, which is the
 * right behaviour for a thing that lives in the chrome of every page:
 * a permanent "up to date" pill is a notification that has never once
 * been useful. But the question "am I current?" is real, and it needs
 * somewhere to be answered on purpose rather than inferred from an
 * absence.
 *
 * So this page shows what the badge hides: the up-to-date case, when
 * the check last ran, whether it failed and why, which channel it
 * follows, and a button to ask again now instead of waiting six hours.
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
  checked_at?: number | null;
  error?: string | null;
}

const COMMAND = "./update.sh";

function ago(epochSeconds: number | null | undefined): string | null {
  if (!epochSeconds) return null;
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 90) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      <h2 className="text-xs uppercase tracking-wider text-slate-400 mb-3">
        {title}
      </h2>
      {children}
    </div>
  );
}

export default function UpdateSettings() {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);

  const q = useQuery({
    queryKey: ["update-check"],
    queryFn: () => apiGet<UpdateInfo>("/api/update"),
    staleTime: 30 * 60_000,
    retry: false,
  });

  const cfg = useQuery({
    queryKey: ["public-config"],
    queryFn: () => apiGet<PublicConfig>("/api/config"),
    staleTime: 60_000,
  });

  // Forced: skips the six-hour cache. This is the button's whole reason
  // for existing, so it must not quietly return the same cached answer.
  const check = useMutation({
    mutationFn: () => apiGet<UpdateInfo>("/api/update?force=true"),
    onSuccess: (data) => qc.setQueryData(["update-check"], data),
  });

  const undismiss = useMutation({
    mutationFn: () => apiPost("/api/update/dismiss", { version: "" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["update-check"] }),
  });

  const info = q.data;
  const lastChecked = ago(info?.checked_at);

  return (
    <div className="space-y-6">
      <Card title="This install">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <div>
            <div className="text-2xl font-semibold text-white tabular-nums">
              {info?.current ?? cfg.data?.version ?? "…"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">Running now</div>
          </div>
          <div>
            <div className="text-sm font-mono text-slate-300">
              {cfg.data?.build ?? "…"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">Build</div>
          </div>
          <div>
            <div className="text-sm text-slate-300 capitalize">
              {info?.enabled ? info.channel : "Off"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">Channel</div>
          </div>
        </div>
      </Card>

      <Card title="Available">
        {!info ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : !info.enabled ? (
          <div className="text-sm text-slate-400">
            Update checking is off. Set{" "}
            <code className="font-mono text-slate-300">UPDATE_CHANNEL</code> in
            your <code className="font-mono text-slate-300">.env</code> to{" "}
            <code className="font-mono text-slate-300">beta</code> or{" "}
            <code className="font-mono text-slate-300">stable</code> and restart
            the backend to turn it back on.
          </div>
        ) : info.update_available ? (
          <div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="update-dot" aria-hidden />
              <span className="text-lg font-semibold text-emerald-200">
                {info.name || `vFusion ${info.latest}`}
              </span>
              {info.prerelease && (
                <span className="text-[11px] uppercase tracking-wide text-amber-300/80 border border-amber-500/30 rounded px-1.5 py-0.5">
                  Pre-release
                </span>
              )}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              You are on {info.current}
              {info.published_at
                ? ` · released ${new Date(info.published_at).toLocaleDateString(
                    undefined,
                    { month: "short", day: "numeric", year: "numeric" },
                  )}`
                : ""}
              {info.dismissed ? " · hidden from the header" : ""}
            </div>

            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">
                Run this in your vFusion directory
              </div>
              <pre className="text-[11px] font-mono text-slate-200 bg-black/40 border border-white/10 rounded-md px-3 py-2 whitespace-pre overflow-x-auto">
{COMMAND}
              </pre>
              <div className="flex items-center gap-3 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(COMMAND).then(
                      () => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1600);
                      },
                      () => setCopied(false),
                    );
                  }}
                  className="text-xs text-slate-300 hover:text-white px-2.5 py-1.5 rounded-md border border-white/15 hover:bg-white/10 transition-colors"
                >
                  {copied ? "Copied" : "Copy command"}
                </button>
                <a
                  href={info.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-sky-300 hover:text-sky-200"
                >
                  Release notes ↗
                </a>
                {info.dismissed && (
                  <button
                    type="button"
                    onClick={() => undismiss.mutate()}
                    disabled={undismiss.isPending}
                    className="ml-auto text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
                  >
                    Show in the header again
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-sm text-slate-200">
              {info.checked
                ? `vFusion ${info.current} is the newest release on the ${info.channel} channel.`
                : "Nothing published on this channel yet."}
            </div>
            {!info.checked && !info.error && (
              <div className="text-xs text-slate-500 mt-1">
                The check reached GitHub and found no releases to compare
                against. Draft releases are not visible to it.
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="The check">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="text-xs text-slate-400 leading-relaxed max-w-prose">
            vFusion asks GitHub for its own list of releases every six hours
            and caches the answer, so a restart does not trigger a fresh call.
            The request is an ordinary unauthenticated read: it carries no
            version, no org and nothing else about this install, so GitHub
            learns your address and no more. Set{" "}
            <code className="font-mono text-slate-300">UPDATE_CHANNEL=off</code>{" "}
            to stop it entirely.
            <br />
            <br />
            vFusion never updates itself. A container cannot replace itself,
            and the only way to give it that power is the Docker socket, which
            is root on the host — a bad trade for something holding a key that
            can unlock doors. The last step stays yours.
          </div>
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => check.mutate()}
              disabled={check.isPending || !info?.enabled}
              className="text-sm text-white px-3 py-2 rounded-md border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-50 disabled:hover:bg-sky-500/15 transition-colors"
            >
              {check.isPending ? "Checking…" : "Check now"}
            </button>
            <div className="text-[11px] text-slate-500 mt-1.5 text-right">
              {check.isError
                ? "Check failed"
                : info?.error
                  ? `Last attempt failed: ${info.error}`
                  : lastChecked
                    ? `Checked ${lastChecked}`
                    : "Not checked yet"}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
