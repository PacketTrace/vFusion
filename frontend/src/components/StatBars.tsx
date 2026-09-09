import { Link } from "react-router-dom";

/**
 * A ranked horizontal bar chart, for "which of these is biggest".
 *
 * What it replaces put the label on one line and the bar on the next,
 * with the count flush against the far right edge of the card. On a wide
 * screen that is a couple of thousand pixels between a name and its
 * number, so reading one row meant a saccade across the whole viewport
 * and back. The bar itself was a pixel and a half tall and shared no
 * baseline with anything.
 *
 * Here a row is one line: label, track, count, share. The count sits at
 * the end of the track it belongs to rather than at the edge of the
 * container, so the eye travels the length of the bar and stops.
 *
 * Deliberately one hue rather than a colour per category. These bars are
 * a magnitude comparison and every one of them is directly labelled, so
 * a categorical palette would encode nothing the text does not already
 * say -- and the app's validated palette cannot separate more than four
 * slots at all-pairs anyway. Colour is spent on the thing text cannot
 * show instead: which row is currently filtering the page.
 */

export interface BarItem {
  key: string;
  label: string;
  count: number;
  /** Where clicking the row goes. Omit for a non-navigating row. */
  href?: string;
  /** Called instead of navigating. Takes precedence over href. */
  onPick?: () => void;
  /** Renders as the active filter. */
  selected?: boolean;
  title?: string;
}

const ACCENT = "#3987e5";
const MUTED = "#6b7280";

export default function StatBars({
  items,
  total,
  emptyText = "Nothing in this range.",
}: {
  items: BarItem[];
  /** Denominator for the share column. Falls back to the sum of what is
   *  shown, which is right for a complete breakdown and wrong for a
   *  top-N list -- so pass the real one whenever there is one. */
  total?: number;
  emptyText?: string;
}) {
  if (items.length === 0)
    return <div className="text-sm text-slate-500">{emptyText}</div>;

  const max = Math.max(...items.map((i) => i.count), 1);
  const denom = total ?? items.reduce((a, i) => a + i.count, 0) ?? 1;
  const anySelected = items.some((i) => i.selected);

  return (
    <ul className="space-y-0.5">
      {items.map((i) => {
        const share = denom > 0 ? (i.count / denom) * 100 : 0;
        // A row dims only while some *other* row is the active filter, so
        // an unfiltered chart never looks half switched off.
        const dim = anySelected && !i.selected;
        const body = (
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={`w-40 sm:w-52 shrink-0 truncate text-xs ${
                i.selected ? "text-white font-medium" : "text-slate-300"
              }`}
            >
              {i.label}
            </span>
            <span className="flex-1 min-w-[3rem] h-2.5 rounded-full bg-white/[0.06] overflow-hidden">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max((i.count / max) * 100, i.count > 0 ? 1.5 : 0)}%`,
                  backgroundColor: i.selected ? ACCENT : dim ? MUTED : ACCENT,
                  opacity: dim ? 0.45 : 1,
                  transition:
                    "width 250ms var(--ease-out), opacity 150ms var(--ease-out)",
                }}
              />
            </span>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-slate-200">
              {i.count.toLocaleString()}
            </span>
            <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-slate-500">
              {share >= 0.1 ? `${share.toFixed(share < 10 ? 1 : 0)}%` : "<0.1%"}
            </span>
          </div>
        );

        const title =
          i.title ??
          `${i.label} — ${i.count.toLocaleString()} of ${denom.toLocaleString()} (${share.toFixed(1)}%)`;
        const cls = `block w-full text-left rounded -mx-2 px-2 py-1.5 transition-colors ${
          i.selected ? "bg-sky-950/40" : "hover:bg-white/5"
        }`;

        return (
          <li key={i.key}>
            {i.onPick ? (
              <button type="button" onClick={i.onPick} className={cls} title={title}>
                {body}
              </button>
            ) : i.href ? (
              <Link to={i.href} className={cls} title={title}>
                {body}
              </Link>
            ) : (
              <div className={`${cls} cursor-default`} title={title}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
