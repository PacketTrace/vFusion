import { useEffect, useMemo, useRef, useState } from "react";

export interface ValueOption {
  value: string;
  /** Shown to the right of the value — e.g. "not yet seen on camera". */
  note?: string;
}

export interface ValueGroup {
  label: string;
  options: ValueOption[];
}

/** A value input with a dropdown of known options.
 *
 *  A native `<datalist>` was the obvious thing here and it was wrong: the
 *  browser filters the list down to what you have typed, so the moment a
 *  value is filled in the menu collapses to that one entry and there is
 *  no way to see the other choices without clearing the field first. The
 *  list is also rendered by the OS, so it ignores the app's styling.
 *
 *  This shows every option every time, regardless of what is in the box,
 *  and still accepts free text for fields whose values we can't enumerate.
 */
export function ValuePicker({
  value,
  onChange,
  groups,
  placeholder = "value to match",
}: {
  value: string;
  onChange: (v: string) => void;
  groups: ValueGroup[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const flat = useMemo(
    () => groups.flatMap((g) => g.options),
    [groups],
  );
  const hasOptions = flat.length > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hasOptions) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + flat.length) % flat.length);
      return;
    }
    if (e.key === "Enter" && open && active >= 0) {
      e.preventDefault();
      commit(flat[active].value);
    }
  };

  return (
    <div ref={root} className="relative flex-1">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => hasOptions && setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls="value-picker-list"
        autoComplete="off"
        className="w-full pl-2 pr-7 py-1 rounded bg-slate-950 border border-slate-700 text-sm font-mono focus:border-sky-600 focus:outline-none"
        placeholder={placeholder}
        spellCheck={false}
      />
      {hasOptions && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Hide values" : "Show values"}
          onClick={() => {
            setOpen((o) => !o);
            inputRef.current?.focus();
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-300"
        >
          <svg
            viewBox="0 0 12 12"
            className="w-2.5 h-2.5 transition-transform duration-150 ease-out-strong"
            style={{ transform: open ? "rotate(180deg)" : "none" }}
            aria-hidden="true"
          >
            <path
              d="M1.5 4L6 8.5L10.5 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {open && hasOptions && (
        <div
          id="value-picker-list"
          role="listbox"
          className="absolute z-30 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 shadow-xl shadow-black/40 py-1 animate-value-picker"
        >
          {groups.map((group) =>
            group.options.length === 0 ? null : (
              <div key={group.label}>
                {groups.length > 1 && (
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500">
                    {group.label}
                  </div>
                )}
                {group.options.map((opt) => {
                  const idx = flat.findIndex((o) => o.value === opt.value);
                  const selected = opt.value === value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => commit(opt.value)}
                      className={`w-full text-left px-2 py-1 text-sm flex items-center justify-between gap-2 ${
                        idx === active ? "bg-slate-800" : ""
                      } ${selected ? "text-sky-300" : "text-slate-200"}`}
                    >
                      <span className="font-mono truncate">{opt.value}</span>
                      {opt.note && (
                        <span className="text-[10px] text-slate-500 shrink-0">
                          {opt.note}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
