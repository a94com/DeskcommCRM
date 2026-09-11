"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { Stage } from "@/lib/kanban/types";

/**
 * Etapas de UM funil, para montar um seletor fora do board — o painel do
 * Inbox precisa mover o lead sem abrir o Kanban. `enabled` evita disparar
 * antes de saber o `pipelineId` (o painel monta o card antes do lead chegar).
 */
export function usePipelineStages(pipelineId: string | null) {
  return useQuery({
    queryKey: ["pipeline-stages", pipelineId],
    enabled: !!pipelineId,
    staleTime: 60_000,
    queryFn: async (): Promise<Stage[]> => {
      const res = await apiClient.get<{ data: { stages: Stage[] } }>(
        `/api/v1/pipelines/${pipelineId}/stages`,
      );
      return res.data.stages;
    },
  });
}
