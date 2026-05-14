import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { apiGet, Connection } from "../lib/api";

export default function PendingSetupBanner() {
  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
    refetchInterval: 5000,
  });

  const pending = (conns.data ?? []).filter((c) => !c.setup_complete);
  if (pending.length === 0) return null;

  return (
    <Link
      to="/connections"
      className="block bg-amber-950/50 border border-amber-900 hover:bg-amber-950 rounded-lg px-4 py-3 transition-colors"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-amber-200 font-medium text-sm">
            ⚡ {pending.length === 1 ? "New Verkada org detected" : `${pending.length} new Verkada orgs detected`} — finish setup
          </div>
          <div className="text-amber-300/70 text-xs mt-0.5 truncate">
            {pending.map((p) => p.name).join(", ")} — add your API key to enable flow actions.
          </div>
        </div>
        <span className="text-amber-300 text-sm shrink-0">→</span>
      </div>
    </Link>
  );
}
