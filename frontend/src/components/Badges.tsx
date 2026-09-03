import { Family, SignatureStatus } from "../lib/api";

const FAMILY_STYLE: Record<Family, string> = {
  camera: "bg-sky-500/15 text-sky-300 border border-sky-500/25",
  access: "bg-violet-500/15 text-violet-300 border border-violet-500/25",
  lpr: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25",
  sensor: "bg-amber-500/15 text-amber-300 border border-amber-500/25",
  intercom: "bg-pink-500/15 text-pink-300 border border-pink-500/25",
  credential: "bg-indigo-500/15 text-indigo-300 border border-indigo-500/25",
  alarm: "bg-red-500/15 text-red-300 border border-red-500/25",
  // Unknown is the one that should catch the eye — it is a prompt to go
  // add the variant to the taxonomy.
  unknown: "bg-rose-500/20 text-rose-300 border border-rose-500/40",
};

export function FamilyBadge({ family }: { family: Family | null }) {
  const f = family ?? "unknown";
  return (
    <span
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${FAMILY_STYLE[f]}`}
      title={f === "unknown" ? "Not recognized — review in Unrecognized tab" : f}
    >
      {f}
    </span>
  );
}

// Verification is binary at this layer — see SignatureStatus in lib/api.ts
// for why we deliberately don't show a loud "bad sig" chip. The
// "verified" badge is the only positive signal; everything else falls
// back to no chip (or a faint "unsigned" when the request had no header
// at all so an operator can still distinguish "no secret configured"
// from "we have a secret but couldn't match").
const SIG_STYLE: Record<SignatureStatus, string> = {
  verified: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25",
  unverified: "bg-white/5 text-slate-400 border border-white/10",
  missing_header: "bg-white/5 text-slate-400 border border-white/10",
};

const SIG_LABEL: Record<SignatureStatus, string> = {
  verified: "✓ verified",
  unverified: "unverified",
  missing_header: "unsigned",
};

export function SignatureBadge({
  status,
}: {
  status: SignatureStatus | null;
}) {
  if (!status) return null;
  // "missing_header" stays hidden (every request without a header
  // looks the same — no signal worth surfacing). "verified" gets the
  // green chip. "unverified" gets a small gray chip with no alarm
  // copy — operators see "this didn't verify" but don't get a red
  // siren on every Verkada retry.
  if (status === "missing_header") return null;
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SIG_STYLE[status]}`}
      title={
        status === "verified"
          ? "HMAC verified against the stored signing secret."
          : "Couldn't HMAC-verify against the stored signing secret. Most often a legitimate Verkada retry past the timestamp window — see `docker compose logs backend | grep \"verkada signature\"` for the specific reason."
      }
    >
      {SIG_LABEL[status]}
    </span>
  );
}
