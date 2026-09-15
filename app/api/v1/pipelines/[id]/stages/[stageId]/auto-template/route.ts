import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET/PUT /api/v1/pipelines/[id]/stages/[stageId]/auto-template
 *
 * Camada de conveniência sobre `automation_rules` — o pop-up de configuração
 * da etapa (Kanban) fala com ISTO, não com a tela genérica de Automações. Por
 * trás, é uma `automation_rules` de verdade: `trigger_event:
 * "lead.stage_changed"`, condição `event.to_stage_id eq <stageId>`, ação
 * `send_template`. Continua aparecendo em `/app/webhooks` pra quem quiser ver
 * o JSON — esta rota só evita que o operador precise entender o conceito de
 * "regra" pra ligar um disparo automático na coluna.
 *
 * Achar a MESMA regra em vez de duplicar a cada salvamento: procura por
 * `trigger_event` + a condição de etapa via containment jsonb (`@>`), não por
 * nome — nome pode mudar (é só rótulo), a condição é o fato que identifica
 * "esta é a regra desta etapa".
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; stageId: string }>;
}

const CONDICAO_DE_ETAPA = (stageId: string) => [{ field: "event.to_stage_id", op: "eq", value: stageId }];

const putBodySchema = z
  .object({
    enabled: z.boolean(),
    channel_session_id: z.string().uuid(),
    template_name: z.string().min(1).max(512),
    template_language: z.string().min(1).max(20),
    template_values: z.record(z.string(), z.string().max(2000)).optional(),
  })
  .strict();

async function acharRegraDaEtapa(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  stageId: string,
) {
  // NÃO usar `.contains("conditions", array)` aqui: o supabase-js só serializa
  // como JSON quando o valor é um OBJETO (`.contains("metadata", {...})` em
  // admin/incidents funciona por isso). Pra um ARRAY, ele assume coluna
  // `text[]` do Postgres e faz `value.join(',')` (funciona pra
  // `.contains("tags", [tag])` acima) — aplicado a um array de OBJETOS vira
  // `{[object Object]}`, e o Postgres rejeita com "invalid input syntax for
  // type json". `conditions` é jsonb guardando um array; `.filter(...,"cs",...)`
  // manda a string já serializada direto, sem essa reinterpretação.
  const { data, error } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", orgId)
    .eq("trigger_event", "lead.stage_changed")
    .filter("conditions", "cs", JSON.stringify(CONDICAO_DE_ETAPA(stageId)))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    id: string;
    name: string;
    is_active: boolean;
    actions: Array<{ type: string; config?: Record<string, unknown> }>;
  } | null;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;

  const { stageId } = await ctx.params;
  const supabase = await createClient();

  let regra;
  try {
    regra = await acharRegraDaEtapa(supabase, authz.org.orgId, stageId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  const acao = regra?.actions.find((a) => a.type === "send_template");
  const resposta: {
    enabled: boolean;
    channel_session_id: string | null;
    template_name: string | null;
    template_language: string | null;
    template_values: Record<string, string> | null;
    already_sent_to_contact: boolean | null;
  } = {
    enabled: Boolean(regra?.is_active && acao),
    channel_session_id: (acao?.config?.channel_session_id as string | undefined) ?? null,
    template_name: (acao?.config?.template_name as string | undefined) ?? null,
    template_language: (acao?.config?.template_language as string | undefined) ?? null,
    template_values: (acao?.config?.template_values as Record<string, string> | undefined) ?? null,
    already_sent_to_contact: null,
  };

  // Consulta opcional pra Camada 2 da trava de duplicidade (pedido do
  // usuário, 2026-09): a UI de mover lead passa `contact_id` pra saber, ANTES
  // de mover, se esse contato específico já recebeu esse template — mesma
  // checagem que `send-template.ts` faz de verdade antes de enviar.
  const contactId = req.nextUrl.searchParams.get("contact_id");
  if (resposta.enabled && resposta.template_name && contactId) {
    const admin = createAdminClient();
    const { data: existente } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("contact_id", contactId)
      .eq("template_name", resposta.template_name)
      .limit(1)
      .maybeSingle();
    resposta.already_sent_to_contact = Boolean(existente);
  }

  return ok(resposta, { requestId });
}

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const { id: pipelineId, stageId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = putBodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Confere que a etapa é desta org — nunca confiar em UUID vindo da URL sem
  // checar posse (mesma doutrina de todo endpoint de etapa/funil do repo).
  const supabase = await createClient();
  const { data: etapa, error: etapaErr } = await supabase
    .from("crm_stages")
    .select("id, name")
    .eq("id", stageId)
    .eq("pipeline_id", pipelineId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (etapaErr) return fail("internal_error", etapaErr.message, 500, { requestId });
  if (!etapa) return fail("not_found", t("Etapa não encontrada."), 404, { requestId });

  let regraAtual;
  try {
    regraAtual = await acharRegraDaEtapa(supabase, org.orgId, stageId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  // Desligar sem nunca ter existido regra: nada a fazer, sucesso vazio.
  if (!parsed.data.enabled && !regraAtual) {
    return ok({ enabled: false }, { requestId });
  }

  const actionsBrutas = [
    {
      type: "send_template",
      config: {
        channel_session_id: parsed.data.channel_session_id,
        template_name: parsed.data.template_name,
        template_language: parsed.data.template_language,
        ...(parsed.data.template_values ? { template_values: parsed.data.template_values } : {}),
      },
    },
  ];
  const actions = await encryptRuleActionSecrets(createAdminClient(), actionsBrutas);
  if (actions === null) {
    return fail("encryption_unavailable", t("Não foi possível guardar a configuração com segurança."), 422, {
      requestId,
    });
  }

  if (regraAtual) {
    const { data: atualizada, error: updErr } = await supabase
      .from("automation_rules")
      .update({ actions, is_active: parsed.data.enabled })
      .eq("id", regraAtual.id)
      .eq("organization_id", org.orgId)
      .select("*")
      .single();
    if (updErr) return fail("internal_error", updErr.message, 500, { requestId });
    return ok({ enabled: parsed.data.enabled, rule: atualizada }, { requestId });
  }

  // Nasce JÁ ATIVA — diferente da tela genérica de Automações (regra nasce
  // pausada pra revisão): aqui é o usuário configurando deliberadamente pelo
  // pop-up da etapa, ligar é o ato de salvar.
  const { data: criada, error: insErr } = await supabase
    .from("automation_rules")
    .insert({
      organization_id: org.orgId,
      created_by_user_id: user.id,
      name: `Template automático — ${etapa.name}`,
      trigger_event: "lead.stage_changed",
      conditions: CONDICAO_DE_ETAPA(stageId),
      actions,
      is_active: true,
    })
    .select("*")
    .single();
  if (insErr) return fail("internal_error", insErr.message, 500, { requestId });

  return ok({ enabled: true, rule: criada }, { requestId, status: 201 });
}
