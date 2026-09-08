import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { AuditFilters, filtersFromSearch, filtersToSearch } from "./auditFilters";

type Updater = AuditFilters | ((prev: AuditFilters) => AuditFilters);

/**
 * Filters read from, and written to, the URL. Both Explorer tabs use
 * this, which is what makes a filter a shareable link rather than a
 * shared store.
 *
 * Filtering deliberately never changes which view you are looking at.
 * Clicking a bar on Insights used to drop you into the Events list,
 * which ended the exploration you were in the middle of: the whole
 * point of a chart is the next question, and answering it meant
 * clicking back every time. The view is one segmented control away,
 * and the same filters describe both.
 */
export function useAuditFilters(): {
  filters: AuditFilters;
  setFilters: (next: Updater) => void;
} {
  const [sp, setSp] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(sp), [sp]);

  // ``tab``, ``view`` and ``event`` ride along in the URL; filtersToSearch
  // carries the first two through untouched. The selected row is dropped,
  // because a different slice may not contain it.
  const setFilters = useCallback(
    (next: Updater) => {
      setSp(
        (prev) => {
          const resolved = typeof next === "function" ? next(filtersFromSearch(prev)) : next;
          const out = filtersToSearch(resolved, prev);
          out.delete("event");
          return out;
        },
        { replace: true },
      );
    },
    [setSp],
  );

  return { filters, setFilters };
}
