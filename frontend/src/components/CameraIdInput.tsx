import { useMemo, useState } from "react";

import { useCameras } from "../lib/cameras";

/**
 * A camera id, chosen rather than typed.
 *
 * Every other page picks cameras from a list; the API runner made you
 * paste a UUID, which means leaving to find one. The ids are already
 * cached locally, so there was never a reason.
 *
 * Offline cameras are listed and marked, not hidden. On the Helix demo
 * hiding them is right — seeding events onto a camera with no footage
 * produces a timeline that cannot be clicked. Here the opposite holds:
 * asking why a camera is offline is a perfectly good reason to call an
 * endpoint about it.
 */
export default function CameraIdInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const cameras = useCameras();
  const list = useMemo(() => {
    const items = [...(cameras.data ?? [])];
    items.sort((a, b) => {
      const offA = (a.status ?? "").toLowerCase() === "offline";
      const offB = (b.status ?? "").toLowerCase() === "offline";
      // Online first, then by name — an offline camera is the exception
      // and should not be in the way of the common case.
      if (offA !== offB) return offA ? 1 : -1;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
    return items;
  }, [cameras.data]);

  const known = list.some((c) => c.camera_id === value);
  // Typing is still allowed: an id from a webhook, another org, or a
  // camera that has not synced yet is a legitimate thing to paste.
  const [typing, setTyping] = useState(false);

  if (typing || (value !== "" && !known)) {
    return (
      <div className="space-y-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="camera UUID"
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
        />
        <button
          type="button"
          onClick={() => {
            setTyping(false);
            onChange("");
          }}
          className="text-[11px] text-sky-400 hover:text-sky-300"
        >
          pick from your cameras instead
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === "__type__") {
            setTyping(true);
            return;
          }
          onChange(e.target.value);
        }}
        className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
      >
        <option value="">— pick a camera —</option>
        {list.map((c) => (
          <option key={c.camera_id} value={c.camera_id}>
            {c.name ?? c.camera_id}
            {c.site ? ` — ${c.site}` : ""}
            {(c.status ?? "").toLowerCase() === "offline" ? " (offline)" : ""}
          </option>
        ))}
        <option value="__type__">Type an ID instead…</option>
      </select>
      {value && (
        <div className="text-[10px] text-slate-600 font-mono break-all">
          {value}
        </div>
      )}
    </div>
  );
}
