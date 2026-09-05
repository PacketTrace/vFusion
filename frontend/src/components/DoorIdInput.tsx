import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { apiGet } from "../lib/api";

/**
 * A door id, chosen rather than typed. The camera equivalent, against
 * the door list vFusion already syncs.
 *
 * Doors come from two places: a real sync of /access/v1/door, and doors
 * merely *seen* in captured access events when no sync has run. The
 * second kind is labelled, because "observed" means the name may be
 * missing and the list may be short — a door nobody has badged through
 * will not be in it.
 */
interface Door {
  door_id: string;
  name: string | null;
  site_name: string | null;
  source: string;
}

export default function DoorIdInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const doors = useQuery({
    queryKey: ["verkada-doors"],
    queryFn: () => apiGet<Door[]>("/api/verkada/doors"),
  });
  const list = doors.data ?? [];
  const known = list.some((d) => d.door_id === value);
  const [typing, setTyping] = useState(false);

  if (typing || (value !== "" && !known)) {
    return (
      <div className="space-y-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="door UUID"
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
          pick from your doors instead
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
        <option value="">— pick a door —</option>
        {list.map((d) => (
          <option key={d.door_id} value={d.door_id}>
            {d.name ?? d.door_id}
            {d.site_name ? ` — ${d.site_name}` : ""}
            {d.source === "observed" ? " (seen in events)" : ""}
          </option>
        ))}
        <option value="__type__">Type an ID instead…</option>
      </select>
      {list.length === 0 && !doors.isLoading && (
        <p className="text-[11px] text-amber-300">
          No doors known yet — sync them on the Connections page, or type an
          ID.
        </p>
      )}
    </div>
  );
}
