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
  // Latches on first open. Children stay mounted afterwards so collapsing
  // can animate — but a section nobody has opened still does no work, which
  // is what keeps the playbooks panel from firing an MCP call on mount.
  const [everOpened, setEverOpened] = useState(defaultOpen);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setEverOpened(true);
        }}
        aria-expanded={open}
        className="w-full flex items-baseline gap-2 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
      >
        <span
          className={`text-slate-500 text-[10px] leading-none transition-transform duration-200 ease-out-strong ${
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
      {/* grid-template-rows 0fr→1fr animates to the content's natural height
       * without measuring it, and being a transition rather than a keyframe
       * it retargets mid-flight — spam the header and it reverses from where
       * it is instead of restarting.
       *
       * Written as inline styles on purpose. Expressed as Tailwind arbitrary
       * utilities (`grid-rows-[0fr]`, `transition-[grid-template-rows]`) this
       * silently failed to collapse: if the class never makes it through the
       * JIT there is no error, the row just never shrinks and the section
       * appears stuck open. Inline styles can't miss.
       *
       * min-height on the row is also load-bearing. A grid item's automatic
       * minimum size is its content, so a 0fr track still renders full height
       * unless the item is allowed to shrink. */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transition:
            "grid-template-rows 200ms cubic-bezier(0.23, 1, 0.32, 1), opacity 200ms cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div style={{ minHeight: 0, overflow: "hidden" }}>
          {everOpened && (
            <div className="px-3 pb-3 pt-3 border-t border-white/10">
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
