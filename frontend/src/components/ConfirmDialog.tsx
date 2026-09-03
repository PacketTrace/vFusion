import { useEffect, useRef } from "react";

/** A confirmation the app draws itself.
 *
 *  The browser's confirm() was being used for every destructive action:
 *  a white system sheet dropped over a dark UI, with OS button order and
 *  no room to say what the consequence actually is. It also blocks the
 *  main thread, so nothing behind it can update while it is open.
 *
 *  Chrome matches HelixEventTypeEditor so modals in this app look like
 *  one family.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Delete",
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus lands on cancel rather than the
  // destructive action — a stray return key should not delete anything.
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50 animate-confirm-backdrop"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="bg-slate-900 border border-white/15 rounded-xl w-full max-w-md animate-confirm-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {body && (
            <div className="text-[13px] text-slate-400 mt-1.5 leading-relaxed">
              {body}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded-md border border-white/15 text-slate-300 hover:text-white hover:border-white/30"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`text-sm px-3 py-1.5 rounded-md text-white disabled:opacity-50 ${
              destructive
                ? "bg-rose-700 hover:bg-rose-600"
                : "bg-sky-700 hover:bg-sky-600"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
