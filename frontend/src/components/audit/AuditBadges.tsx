import { ACTOR_LABEL, CATEGORY_LABEL, categoryColor } from "../../lib/auditFilters";

/** Category chip. Colour follows the category (see auditFilters), and
 *  the label carries identity on its own, so the chip is never
 *  colour-alone. */
export function CategoryBadge({ category, small }: { category: string; small?: boolean }) {
  const color = categoryColor(category);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-semibold whitespace-nowrap ${
        small ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5"
      }`}
      style={{
        color,
        borderColor: `${color}40`,
        backgroundColor: `${color}1f`,
      }}
      title={CATEGORY_LABEL[category] ?? category}
    >
      <span
        aria-hidden
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {CATEGORY_LABEL[category] ?? category}
    </span>
  );
}

const ACTOR_STYLE: Record<string, string> = {
  user: "bg-white/5 text-slate-300 border-white/10",
  api_key: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  support: "bg-amber-500/15 text-amber-300 border-amber-500/25",
  system: "bg-white/5 text-slate-500 border-white/10",
};

export function ActorBadge({ actor }: { actor: string }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border ${ACTOR_STYLE[actor] ?? ACTOR_STYLE.system}`}
    >
      {ACTOR_LABEL[actor] ?? actor}
    </span>
  );
}

const METHOD_STYLE: Record<string, string> = {
  GET: "bg-sky-500/15 text-sky-300 border-sky-500/25",
  POST: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25",
  PUT: "bg-amber-500/15 text-amber-300 border-amber-500/25",
  PATCH: "bg-violet-500/15 text-violet-300 border-violet-500/25",
  DELETE: "bg-rose-500/15 text-rose-300 border-rose-500/25",
};

export function MethodBadge({ method }: { method: string | null }) {
  if (!method) return null;
  const m = method.toUpperCase();
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
        METHOD_STYLE[m] ?? "bg-white/5 text-slate-300 border-white/10"
      }`}
    >
      {m}
    </span>
  );
}

/** Status codes use the reserved status colours, with the number as the
 *  label — never colour alone. */
export function statusTone(code: number | null | undefined): string {
  if (code === null || code === undefined) return "text-slate-500";
  if (code >= 500) return "text-rose-300";
  if (code >= 400) return "text-amber-300";
  if (code >= 300) return "text-slate-300";
  return "text-emerald-300";
}

export function StatusBadge({ code }: { code: number | null }) {
  if (code === null || code === undefined) return null;
  return (
    <span className={`text-[11px] font-mono ${statusTone(code)}`} title={`HTTP ${code}`}>
      {code}
    </span>
  );
}
