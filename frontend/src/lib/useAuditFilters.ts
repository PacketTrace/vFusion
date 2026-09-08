import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { AuditFilters, filtersFromSearch, filtersToSearch } from "./auditFilters";

type Updater = AuditFilters | ((prev: AuditFilters) => AuditFilters);

/**
 * Filters read from, and written to, the URL. Both Explorer tabs use
 * this, which is what makes "click a bar, land on those rows" a URL
 * change rather than a shared store.
 */
export function useAuditFilters(): {
  filters: AuditFilters;
  setFilters: (next: Updater) => void;
  /** Apply filters and switch to the Events view of the Audit log tab. */
  showInList: (next: Updater) => void;
} {
  const [sp, setSp] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(sp), [sp]);

  const write = useCallback(
    (next: Updater, tab?: string) => {
      setSp(
        (prev) => {
          const resolved = typeof next === "function" ? next(filtersFromSearch(prev)) : next;
          const out = filtersToSearch(resolved, prev);
          if (tab) {
            out.set("tab", tab);
            out.set("view", "events");
          }
          // A different slice means the selected row no longer belongs.
          out.delete("event");
          return out;
        },
        { replace: true },
      );
    },
    [setSp],
  );

  const setFilters = useCallback((next: Updater) => write(next), [write]);
  const showInList = useCallback((next: Updater) => write(next, "audit"), [write]);
  return { filters, setFilters, showInList };
}
