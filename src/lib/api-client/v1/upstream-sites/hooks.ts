"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpstreamSiteConfigInput } from "@/lib/api/v1/schemas/upstream-sites";
import { apiClient } from "@/lib/api-client/v1/client";
import { v1Keys } from "@/lib/api-client/v1/keys";
import type { UpstreamSite } from "@/types/provider";

export type DashboardUpstreamSite = Omit<UpstreamSite, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export function useUpstreamSites() {
  return useQuery({
    queryKey: v1Keys.upstreamSites.list(),
    queryFn: () => apiClient.get<{ items: DashboardUpstreamSite[] }>("/api/v1/upstream-sites"),
  });
}

export function useUpdateUpstreamSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ siteId, input }: { siteId: number; input: UpstreamSiteConfigInput }) =>
      apiClient.patch<DashboardUpstreamSite>(`/api/v1/upstream-sites/${siteId}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: v1Keys.upstreamSites.all }),
  });
}

export function useTestUpstreamSitePat() {
  return useMutation({
    mutationFn: ({ siteId, input }: { siteId: number; input: UpstreamSiteConfigInput }) =>
      apiClient.post<{ groupCount: number }>(`/api/v1/upstream-sites/${siteId}/pat:test`, input),
  });
}

export function useDeleteUpstreamSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (siteId: number) => apiClient.delete<void>(`/api/v1/upstream-sites/${siteId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: v1Keys.upstreamSites.all }),
  });
}
