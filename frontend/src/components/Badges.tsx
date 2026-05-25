import { Family, SignatureStatus } from "../lib/api";

const FAMILY_STYLE: Record<Family, string> = {
  camera: "bg-sky-900 text-sky-200",
  access: "bg-violet-900 text-violet-200",
  lpr: "bg-emerald-900 text-emerald-200",
  sensor: "bg-amber-900 text-amber-200",
  intercom: "bg-pink-900 text-pink-200",
  credential: "bg-indigo-900 text-indigo-200",
  alarm: "bg-red-900 text-red-200",
  unknown: "bg-rose-900 text-rose-200",
};

export function FamilyBadge({ family }: { family: Family | null }) {
  const f = family ?? "unknown";
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${FAMILY_STYLE[f]}`}
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
  verified: "bg-emerald-900 text-emerald-200",
  unverified: "bg-slate-800 text-slate-400",
  missing_header: "bg-slate-800 text-slate-400",
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
