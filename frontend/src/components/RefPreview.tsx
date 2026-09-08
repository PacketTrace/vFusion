import { describeRef, formatSample, sampleFor, segments } from "../lib/templateRefs";

/**
 * What a field with ``{{ … }}`` in it will actually say, in words.
 *
 * Shown under the raw input rather than replacing it: the raw form is
 * exact and editable, and this is the readable copy beside it. Each
 * reference becomes a chip named for where it comes from and what it
 * is, with the sample value it currently resolves to.
 */
export default function RefPreview({
  value,
  steps,
  triggerSample,
  onRemove,
}: {
  value: string;
  steps: Array<{ name: string; label?: string; output_sample?: unknown }>;
  triggerSample: Record<string, unknown> | null;
  /** Remove one reference from the value. */
  onRemove?: (path: string) => void;
}) {
  if (!value || !value.includes("{{")) return null;
  const segs = segments(value);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] leading-5" data-testid="ref-preview">
      {segs.map((seg, i) =>
        seg.kind === "text" ? (
          seg.text.trim() ? (
            <span key={i} className="text-slate-400 whitespace-pre-wrap">
              {seg.text.length > 80 ? seg.text.slice(0, 77) + "…" : seg.text}
            </span>
          ) : null
        ) : (
          <Chip
            key={i}
            path={seg.path}
            steps={steps}
            triggerSample={triggerSample}
            onRemove={onRemove ? () => onRemove(seg.path) : undefined}
          />
        ),
      )}
    </div>
  );
}

function Chip({
  path,
  steps,
  triggerSample,
  onRemove,
}: {
  path: string;
  steps: Array<{ name: string; label?: string; output_sample?: unknown }>;
  triggerSample: Record<string, unknown> | null;
  onRemove?: () => void;
}) {
  const info = describeRef(path, steps);
  const sample = sampleFor(path, triggerSample, steps);
  const tone =
    info.source === "trigger"
      ? "border-sky-500/30 bg-sky-500/10 text-sky-200"
      : info.source === "step"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
        : "border-amber-500/30 bg-amber-500/10 text-amber-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${tone}`}
      title={`{{ ${path} }}`}
    >
      {info.origin && <span className="opacity-70">{info.origin} ›</span>}
      <span className="font-medium">{info.field}</span>
      {sample !== undefined && (
        <span className="text-slate-400 font-mono">= {formatSample(sample)}</span>
      )}
      {info.source === "unknown" && <span className="text-amber-300" title="No step or event field with this name">?</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 text-slate-400 hover:text-white leading-none"
          aria-label={`remove ${info.field}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
