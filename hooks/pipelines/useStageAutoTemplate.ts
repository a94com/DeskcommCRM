"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface AutoTemplateConfig {
  enabled: boolean;
  channel_session_id: string | null;
  template_name: string | null;
  template_language: string | null;
  template_values: Record<string, string> | null;
  /** Só vem preenchido quando a consulta leva `contactId` — ver `useAutoTemplatePreview`. */
  already_sent_to_contact: boolean | null;
}

const rota = (pipelineId: string, stageId: string) =>
  `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/stages/${encodeURIComponent(stageId)}/auto-template`;

const chave = (pipelineId: string, stageId: string) => ["stage-auto-template", pipelineId, stageId] as const;

/** Estado do disparo automático de template desta etapa — pro pop-up de configuração. */
export function useStageAutoTemplate(pipelineId: string, stageId: string, enabled = true) {
  return useQuery({
    queryKey: chave(pipelineId, stageId),
    enabled,
    queryFn: async () => (await apiClient.get<{ data: AutoTemplateConfig }>(rota(pipelineId, stageId))).data,
  });
}

/**
 * A MESMA rota, mas com `contact_id` — pra Camada 2 da trava de duplicidade
 * (2026-09): antes de mover um lead pra esta etapa, a UI de mover pergunta
 * "esse contato específico já recebeu o template desta etapa?" pra decidir se
 * mostra o aviso. Chave de cache separada porque a resposta depende do
 * contato, não só da etapa — misturar with `useStageAutoTemplate` faria o
 * resultado de um contato vazar pro outro.
 */
export function useAutoTemplatePreview(pipelineId: string, stageId: string | null, contactId: string | null) {
  return useQuery({
    queryKey: ["stage-auto-template-preview", pipelineId, stageId, contactId],
    enabled: Boolean(pipelineId && stageId && contactId),
    queryFn: async () =>
      (
        await apiClient.get<{ data: AutoTemplateConfig }>(
          `${rota(pipelineId, stageId as string)}?contact_id=${encodeURIComponent(contactId as string)}`,
        )
      ).data,
    staleTime: 0, // decide um move real — nunca serve do cache de outra checagem
  });
}

/**
 * Mesma consulta de `useAutoTemplatePreview`, mas como função simples — pra
 * chamar de dentro de um HANDLER de mover lead (`onDragEnd` do Kanban, o
 * `onChange` do seletor de Etapa do Inbox), onde não dá pra usar hook porque
 * a checagem só faz sentido no momento exato do gesto, não a cada render.
 */
export async function previaDeReenvio(
  pipelineId: string,
  stageId: string,
  contactId: string,
): Promise<AutoTemplateConfig> {
  return (
    await apiClient.get<{ data: AutoTemplateConfig }>(
      `${rota(pipelineId, stageId)}?contact_id=${encodeURIComponent(contactId)}`,
    )
  ).data;
}

export interface SalvarAutoTemplateInput {
  enabled: boolean;
  channel_session_id: string;
  template_name: string;
  template_language: string;
  template_values?: Record<string, string>;
}

export function useSalvarStageAutoTemplate(pipelineId: string, stageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SalvarAutoTemplateInput) =>
      apiClient.put<{ data: { enabled: boolean } }>(rota(pipelineId, stageId), input),
    onSettled: () => qc.invalidateQueries({ queryKey: chave(pipelineId, stageId) }),
  });
}
