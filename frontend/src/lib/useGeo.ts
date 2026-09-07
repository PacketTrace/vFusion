import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./api";

export interface GeoInfo {
  ok: boolean;
  local?: boolean;
  label?: string;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  country_code?: string | null;
  isp?: string | null;
  org?: string | null;
  proxy?: boolean;
  hosting?: boolean;
  error?: string;
}

/**
 * Rough location for a set of IP addresses. One request per distinct
 * set, cached for the session; the backend caches for a month.
 */
export function useGeo(ips: Array<string | null | undefined>): Record<string, GeoInfo> {
  const distinct = Array.from(new Set(ips.filter((i): i is string => !!i))).sort();
  const q = useQuery({
    queryKey: ["audit-geo", distinct.join(",")],
    queryFn: () => {
      const p = new URLSearchParams();
      for (const ip of distinct) p.append("ip", ip);
      return apiGet<Record<string, GeoInfo>>(`/api/audit-events/geo?${p.toString()}`);
    },
    enabled: distinct.length > 0,
    staleTime: 30 * 60_000,
  });
  return q.data ?? {};
}

export function geoLabel(g: GeoInfo | undefined): string | null {
  if (!g || !g.ok) return null;
  return g.label ?? null;
}
