import { useState, type ReactNode } from "react";

/**
 * A titled section that starts collapsed.
 *
 * Children are only mounted while open, which matters when a section does
 * work on mount — the playbooks panel fires an MCP call, and that
 * shouldn't happen for a section nobody expanded.
 */
export default function Collapse({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Shown next to the title so a collapsed section still tells you something. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-baseline gap-2 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
      >
        <span
          className={`text-slate-500 text-[10px] leading-none transition-transform ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ▶
        </span>
        <span className="text-sm font-semibold text-slate-100">{title}</span>
        {summary && (
          <span className="text-[12px] text-slate-500 truncate">{summary}</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-3 border-t border-white/10">{children}</div>
      )}
    </div>
  );
}
