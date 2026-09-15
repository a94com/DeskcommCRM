"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { Stage } from "@/lib/kanban/types";

/**
 * Etapas de UM funil, para montar um seletor fora do board — o painel do
 * Inbox precisa mover o lead sem abrir o Kanban. `enabled` evita disparar
 * antes de saber o `pipelineId` (o painel monta o card antes do lead chegar).
 *
 * ⚠️ Chave "-lite" DE PROPÓSITO: `hooks/webhooks/useWebhookSources.ts` já tem
 * um `usePipelineStages` com a chave `["pipeline-stages", pipelineId]` que
 * busca o BOARD inteiro (`/board`, formato de resposta diferente). Usar a
 * mesma chave aqui faria o cache de um contaminar o do outro — quem montasse
 * por último decidiria o formato que o outro lugar recebe de volta.
 */
export function usePipelineStages(pipelineId: string | null) {
  return useQuery({
    queryKey: ["pipeline-stages-lite", pipelineId],
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
