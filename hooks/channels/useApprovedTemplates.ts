"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { TemplateView } from "@/app/api/v1/channels/templates/route";

/**
 * Templates aprovados do canal oficial (Meta) — pro seletor de "enviar
 * template automático" na etapa e na automação (`send_template`). A rota já é
 * `agent`+ desde a correção de RBAC de 2026-09-11; aqui quem configura
 * automação é manager/admin de qualquer forma.
 */
export function useApprovedTemplates() {
  return useQuery({
    queryKey: ["channel-templates"],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiClient.get<{ data: { waba: string | null; templates: TemplateView[] } }>(
        "/api/v1/channels/templates",
      );
      return res.data.templates.filter((t) => t.status === "APPROVED");
    },
  });
}
