import { useQuery } from "@tanstack/react-query";

import { apiGet, VerkadaCamera } from "./api";

/** Fetch the cached camera list. Stays fresh enough — daily sync + manual button. */
export function useCameras() {
  return useQuery({
    queryKey: ["verkada-cameras"],
    queryFn: () => apiGet<VerkadaCamera[]>("/api/verkada/cameras"),
    staleTime: 60_000,
  });
}

/** UUID → display name. Falls back to a shortened UUID if we don't know it. */
export function useCameraLookup() {
  const q = useCameras();
  const map = new Map<string, VerkadaCamera>();
  for (const c of q.data ?? []) map.set(c.camera_id, c);
  return {
    isLoading: q.isLoading,
    cameras: q.data ?? [],
    lookup(camera_id: string | null | undefined): string {
      if (!camera_id) return "";
      const c = map.get(camera_id);
      if (c && c.name) return c.name;
      return `${camera_id.slice(0, 8)}…`;
    },
    get(camera_id: string | null | undefined): VerkadaCamera | undefined {
      return camera_id ? map.get(camera_id) : undefined;
    },
  };
}
