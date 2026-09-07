/** The heading above a section of a page.
 *
 *  These were 11px uppercase across several pages — the same treatment
 *  as the small labels inside cards, which left a page's structural
 *  landmarks set smaller than the prose beneath them. Uppercasing a
 *  whole sentence is most of what made them read as captions;
 *  "DESCRIBE THE INTEGRATION" is a caption's styling applied to an
 *  instruction.
 *
 *  Shared rather than copied. It started life inside Byoa.tsx, which
 *  meant the next page to want one wrote its own — and two components
 *  that resemble each other drift.
 */
export default function SectionHeading({
  children,
  hint,
}: {
  children: React.ReactNode;
  /** A short qualifier that belongs on the same line as the heading. */
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <h2 className="text-sm font-semibold text-slate-100">{children}</h2>
      {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
    </div>
  );
}
