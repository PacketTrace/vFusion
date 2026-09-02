import { useQuery } from "@tanstack/react-query";

import { apiGet, Taxonomy } from "./api";

/** The Verkada trigger taxonomy. Shared query key across every consumer, so
 *  the picker, the flow list and each canvas node all read one cached copy. */
export function useTaxonomy() {
  return useQuery({
    queryKey: ["verkada-taxonomy"],
    queryFn: () => apiGet<Taxonomy>("/api/taxonomy/verkada"),
    // Only changes when the backend ships new event types.
    staleTime: Infinity,
  });
}

/** Turn a raw notification_type into the words Verkada uses for it.
 *
 *  `alert_rule_dwell` is "Loitering" in Command; nobody reading a dropdown
 *  or a flow list should have to know that. Falls back to a de-underscored
 *  version of the raw value, so a type added upstream tomorrow still reads
 *  sensibly instead of disappearing.
 */
export function useNotificationLabel() {
  const taxonomy = useTaxonomy();
  return (
    family: string | null | undefined,
    notificationType: string | null | undefined,
  ): string => {
    if (!notificationType) return "";
    const data = taxonomy.data;
    const direct = family
      ? data?.[family]?.notification_type_meta?.[notificationType]
      : undefined;
    if (direct?.label) return direct.label;
    // The flow list doesn't always carry a family — look across all of them.
    if (data) {
      for (const entry of Object.values(data)) {
        const hit = entry.notification_type_meta?.[notificationType];
        if (hit?.label) return hit.label;
      }
    }
    return notificationType.replace(/^alert_rule_/, "").replace(/_/g, " ");
  };
}
