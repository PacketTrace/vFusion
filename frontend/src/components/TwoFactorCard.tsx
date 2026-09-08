import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost, MfaSetup, MfaStatus } from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import QrReveal from "./QrReveal";

/**
 * Settings → Security → Two-factor authentication.
 *
 * Off by default, recommended, and turned on in three deliberate steps:
 * scan, prove the phone has it with a live code, confirm the password.
 * Backup codes appear exactly once, at the end, because the moment
 * two-factor is on is the moment they become the only way back in
 * without the phone.
 */
export default function TwoFactorCard() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["mfa-status"],
    queryFn: () => apiGet<MfaStatus>("/api/mfa"),
  });
  const [mode, setMode] = useState<"idle" | "setup" | "disable" | "codes">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const reset = () => {
    setMode("idle");
    setPassword("");
    setCode("");
    setSetup(null);
    setError(null);
    setShowSecret(false);
  };

  const begin = useMutation({
    mutationFn: () => apiPost<MfaSetup>("/api/mfa/setup", { password }),
    onSuccess: (s) => {
      setSetup(s);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });
  const enable = useMutation({
    mutationFn: () => apiPost<MfaStatus & { backup_codes: string[] }>("/api/mfa/enable", { password, code }),
    onSuccess: (r) => {
      setBackupCodes(r.backup_codes);
      setMode("codes");
      setSetup(null);
      setCode("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["mfa-status"] });
      qc.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (e: Error) => setError(e.message),
  });
  const disable = useMutation({
    mutationFn: () => apiPost<MfaStatus>("/api/mfa/disable", { password, code }),
    onSuccess: () => {
      reset();
      qc.invalidateQueries({ queryKey: ["mfa-status"] });
      qc.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (e: Error) => setError(e.message),
  });
  const regen = useMutation({
    mutationFn: () => apiPost<MfaStatus & { backup_codes: string[] }>("/api/mfa/backup-codes", { password, code }),
    onSuccess: (r) => {
      setBackupCodes(r.backup_codes);
      setMode("codes");
      setCode("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["mfa-status"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  // A pending secret expires server-side in 15 minutes; say so before
  // the code box silently starts failing.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (setup) setStartedAt(Date.now());
  }, [setup]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!setup) return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [setup]);
  const minutesLeft = startedAt ? Math.max(0, 15 - Math.floor((Date.now() - startedAt) / 60_000)) : null;

  const s = status.data;
  const enabled = !!s?.enabled;

  return (
    <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3" data-testid="mfa-card">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Two-factor authentication</h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
            A code from an authenticator app after the password. Optional, and strongly recommended: this
            one password guards a key that can unlock doors.
          </p>
        </div>
        <span
          className={`text-[11px] px-2 py-0.5 rounded border ${
            enabled
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-300"
          }`}
        >
          {enabled ? "On" : "Off"}
        </span>
      </div>

      {enabled && s && mode === "idle" && (
        <div className="text-xs text-slate-300 space-y-2">
          <div>
            On since {s.enabled_at ? new Date(s.enabled_at).toLocaleString() : "—"} ·{" "}
            <span className={s.backup_codes_remaining <= 2 ? "text-amber-300" : ""}>
              {s.backup_codes_remaining} of {s.backup_codes_issued} backup codes left
            </span>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => setMode("codes")} className={btnGhost}>
              New backup codes
            </button>
            <button type="button" onClick={() => setMode("disable")} className={btnGhost}>
              Turn off
            </button>
          </div>
          <p className="text-slate-500">
            Lost the phone and the codes? On the docker host, delete <code className="font-mono">mfa.json</code>{" "}
            from the <code className="font-mono">vfusion_secrets</code> volume and restart the backend.
          </p>
        </div>
      )}

      {!enabled && mode === "idle" && (
        <button type="button" onClick={() => setMode("setup")} className={btnPrimary} data-testid="mfa-enable">
          Set up two-factor
        </button>
      )}

      {mode === "setup" && !setup && (
        <form
          className="space-y-2 max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) begin.mutate();
          }}
        >
          <div className="text-xs text-slate-300">Confirm the admin password to generate a secret.</div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            className={input}
            placeholder="Admin password"
          />
          {error && <div className="text-xs text-rose-300">{error}</div>}
          <div className="flex gap-2">
            <button type="submit" disabled={!password || begin.isPending} className={btnPrimary}>
              {begin.isPending ? "Generating…" : "Continue"}
            </button>
            <button type="button" onClick={reset} className={btnGhost}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === "setup" && setup && (
        <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-5 items-start">
          <div className="space-y-2">
            <QrReveal matrix={setup.matrix} size={224} label="Scan with your authenticator app" />
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              className="text-[11px] text-slate-400 hover:text-slate-200"
            >
              {showSecret ? "Hide the key" : "Can't scan? Show the key"}
            </button>
            {showSecret && (
              <div className="flex items-center gap-2">
                <code className="text-xs font-mono text-slate-200 break-all">{setup.secret}</code>
                <button type="button" onClick={() => copyToClipboard(setup.secret)} className={btnGhost}>
                  Copy
                </button>
              </div>
            )}
          </div>
          <form
            className="space-y-3 max-w-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim().length >= 6) enable.mutate();
            }}
          >
            <ol className="text-xs text-slate-300 space-y-1 list-decimal pl-4">
              <li>Open your authenticator app (1Password, Google Authenticator, Authy…).</li>
              <li>Scan the code. It will add <span className="text-slate-100">vFusion (admin)</span>.</li>
              <li>Type the six digits it shows now.</li>
            </ol>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="123 456"
              className={`${input} text-lg tracking-[0.25em] font-mono text-center`}
              data-testid="mfa-setup-code"
            />
            {minutesLeft !== null && (
              <div className="text-[11px] text-slate-500">
                {minutesLeft > 0 ? `This code is good for ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}.` : "This setup has expired. Cancel and start again."}
              </div>
            )}
            {error && <div className="text-xs text-rose-300">{error}</div>}
            <div className="flex gap-2">
              <button type="submit" disabled={code.trim().length < 6 || enable.isPending} className={btnPrimary}>
                {enable.isPending ? "Checking…" : "Turn on two-factor"}
              </button>
              <button type="button" onClick={reset} className={btnGhost}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {mode === "codes" && backupCodes && (
        <div className="space-y-2 max-w-lg">
          <div className="text-xs text-slate-200 font-medium">Backup codes — shown once</div>
          <p className="text-xs text-slate-400">
            Each works one time in place of the authenticator. Keep them somewhere the phone is not.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 font-mono text-sm text-slate-100" data-testid="mfa-backup-codes">
            {backupCodes.map((c) => (
              <div key={c} className="rounded bg-black/30 border border-white/10 px-2 py-1 text-center tracking-wider">
                {c}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => copyToClipboard(backupCodes.join("\n"))} className={btnGhost}>
              Copy all
            </button>
            <button
              type="button"
              onClick={() => {
                setBackupCodes(null);
                reset();
              }}
              className={btnPrimary}
            >
              I have saved them
            </button>
          </div>
        </div>
      )}

      {mode === "codes" && !backupCodes && (
        <CodeAndPassword
          title="New backup codes"
          blurb="The old ones stop working the moment new ones are issued."
          password={password}
          setPassword={setPassword}
          code={code}
          setCode={setCode}
          error={error}
          busy={regen.isPending}
          submitLabel="Issue new codes"
          onSubmit={() => regen.mutate()}
          onCancel={reset}
        />
      )}

      {mode === "disable" && (
        <CodeAndPassword
          title="Turn off two-factor"
          blurb="Password and a current code, or a backup code."
          password={password}
          setPassword={setPassword}
          code={code}
          setCode={setCode}
          error={error}
          busy={disable.isPending}
          submitLabel="Turn off"
          danger
          onSubmit={() => disable.mutate()}
          onCancel={reset}
        />
      )}
    </section>
  );
}

function CodeAndPassword({
  title,
  blurb,
  password,
  setPassword,
  code,
  setCode,
  error,
  busy,
  submitLabel,
  danger,
  onSubmit,
  onCancel,
}: {
  title: string;
  blurb: string;
  password: string;
  setPassword: (s: string) => void;
  code: string;
  setCode: (s: string) => void;
  error: string | null;
  busy: boolean;
  submitLabel: string;
  danger?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="space-y-2 max-w-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (password && code.trim().length >= 6) onSubmit();
      }}
    >
      <div className="text-xs text-slate-200 font-medium">{title}</div>
      <div className="text-xs text-slate-400">{blurb}</div>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        className={input}
        placeholder="Admin password"
      />
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="one-time-code"
        className={`${input} font-mono tracking-widest`}
        placeholder="123 456  or  ABCD-EFGH"
      />
      {error && <div className="text-xs text-rose-300">{error}</div>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!password || code.trim().length < 6 || busy}
          className={danger ? btnDanger : btnPrimary}
        >
          {busy ? "Working…" : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className={btnGhost}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const input =
  "w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600";
const btnPrimary =
  "text-xs px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40 disabled:cursor-not-allowed";
const btnGhost =
  "text-xs px-3 py-1.5 rounded-md border border-white/15 text-slate-300 hover:bg-white/10 transition-colors";
const btnDanger =
  "text-xs px-3 py-1.5 rounded-md bg-rose-700 hover:bg-rose-600 text-white disabled:opacity-40 disabled:cursor-not-allowed";
