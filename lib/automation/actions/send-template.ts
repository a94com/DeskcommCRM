import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { renderTemplate } from "@/lib/automation/template";
import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
import { checkDailyLimit, espacarEnvio } from "@/lib/automation/throttle";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { reportarEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { renderTemplateBody } from "@/lib/channels/meta/render-template";

/**
 * Dispara um TEMPLATE APROVADO da Meta — não confundir com `send_whatsapp_message`
 * (texto livre). É o mesmo caminho que a tela do Inbox usa pra enviar modelo na
 * mão (`POST /api/v1/messages` com `type:"template"`, ver `_handler.ts`), só que
 * disparado pelo motor de regras em vez de um clique.
 *
 * Uso típico (2026-09): "lead entrou na etapa X" → manda o template aprovado
 * pro contato, sem o operador abrir a conversa.
 */

interface ConfigDeTemplate {
  channel_session_id: string;
  template_name: string;
  template_language: string;
  template_values?: Record<string, string>;
}

function lerConfig(config: Record<string, unknown>): ConfigDeTemplate | null {
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  const templateName = typeof config.template_name === "string" ? config.template_name : null;
  const templateLanguage = typeof config.template_language === "string" ? config.template_language : null;
  if (!sessionId || !templateName || !templateLanguage) return null;
  const valoresBrutos = config.template_values;
  const template_values =
    valoresBrutos && typeof valoresBrutos === "object"
      ? (valoresBrutos as Record<string, unknown>)
      : {};
  return {
    channel_session_id: sessionId,
    template_name: templateName,
    template_language: templateLanguage,
    template_values: Object.fromEntries(
      Object.entries(template_values).map(([k, v]) => [k, String(v)]),
    ),
  };
}

/**
 * O texto que o LEAD vai ler, com os `{{n}}` já substituídos — mesma função
 * que o agente usa (`inbound-turn.ts`) e que a tela manual monta ANTES de
 * chamar `/api/v1/messages` (`JanelaFechadaAviso.tsx`). Sem isto, `body` fica
 * vazio: `_handler.ts` só grava `template_name`/`template_language` no envio
 * (linha "Colunas só do template"), então o Inbox mostra um balão em branco
 * mesmo com a Meta tendo aceitado e entregue o template de verdade — achado ao
 * conferir envios reais desta automação (2026-09-15).
 *
 * Duas tentativas, não uma: primeiro filtra por `channel_session_id` (dois
 * números podem ter modelos com o MESMO nome e texto diferente); se não achar,
 * repete sem esse filtro. Precisa da segunda porque `meta_templates.channel_
 * session_id` é NULL em instalação anterior à sincronização por sessão — é
 * assim que `GET /api/v1/channels/templates` já lê (só por organization_id,
 * sem essa coluna), e foi por só tentar a primeira que o `body` saiu vazio de
 * novo mesmo DEPOIS desta função existir: a linha real de "etapa2" tem
 * `channel_session_id` nulo, então o filtro exato nunca achava nada.
 *
 * Falha de leitura ou espelho vazio nas duas tentativas: mesma postura de
 * `conferirDefinicao` ("não espelhada, deixa passar") — devolve `""` em vez de
 * barrar o envio, já que o texto é só para exibição local; a Meta renderiza o
 * template aprovado do lado dela independente disto.
 */
async function corpoRenderizado(
  ctx: ActionCtx,
  parsed: ConfigDeTemplate,
  template_values: Record<string, string>,
): Promise<string> {
  // Duas consultas INDEPENDENTES, não a mesma reaproveitada com mais um
  // `.eq()`: o builder do supabase-js é mutável — encadear a segunda tentativa
  // em cima da primeira acumularia o filtro de `channel_session_id` que a
  // segunda tentativa existe justamente para não ter.
  let { data, error } = await ctx.admin
    .from("meta_templates")
    .select("components, parameter_format")
    .eq("organization_id", ctx.organizationId)
    .eq("name", parsed.template_name)
    .eq("language", parsed.template_language)
    .eq("channel_session_id", parsed.channel_session_id)
    .maybeSingle();
  if (!error && !data) {
    ({ data, error } = await ctx.admin
      .from("meta_templates")
      .select("components, parameter_format")
      .eq("organization_id", ctx.organizationId)
      .eq("name", parsed.template_name)
      .eq("language", parsed.template_language)
      .maybeSingle());
  }
  if (error || !data) return "";

  const linha = data as { components: unknown; parameter_format?: string };
  try {
    return renderTemplateBody(linha.components, template_values, {
      name: parsed.template_name,
      language: parsed.template_language,
      parameterFormat: linha.parameter_format,
    });
  } catch {
    return "";
  }
}

/**
 * A trava contra reenvio duplicado (pedido do usuário, 2026-09): se esse
 * CONTATO já recebeu ESTE template antes — em qualquer conversa, disparado por
 * qualquer caminho —, pula em vez de mandar de novo. Cobre o caso de o lead
 * sair da etapa e voltar (de propósito ou sem querer), sem depender de quem
 * moveu ter visto ou confirmado nada — é a garantia de verdade; o aviso na
 * tela de mover (`MoverEtapa`/`KanbanBoard`) é só pra evitar surpresa.
 *
 * Reaproveita `messages.template_name` + `messages_template_idx`
 * (organization_id, template_name) que já existem pra outra finalidade —
 * nenhuma tabela ou índice novo.
 */
async function jaEnviadoAEsteContato(
  ctx: ActionCtx,
  contactId: string,
  templateName: string,
): Promise<boolean> {
  const { data, error } = await ctx.admin
    .from("messages")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .eq("template_name", templateName)
    .limit(1)
    .maybeSingle();
  // Falha de LEITURA não pode virar envio duplicado sem querer: se não deu
  // pra conferir, o caminho seguro é presumir que já foi (pula, não manda).
  // Reenviar por engano custa dinheiro de verdade (conversa Meta); pular por
  // engano custa, no pior caso, o operador reenviar na mão pelo Inbox.
  if (error) return true;
  return Boolean(data);
}

async function postponeUntil(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  const parsed = lerConfig(config);
  const contato = checarGuardasDeContato(ctx);
  if (contato.ok) {
    const protection = (await protecaoAgendaSupabase(ctx.admin, ctx.organizationId, [contato.contact.id])).get(contato.contact.id)!;
    if (protection.motivo === "leitura_indisponivel") throw new Error("agenda_read_failed");
    if (protection.adiar) return protection.reavaliar_em;
  }
  if (!parsed) return null; // config inválida falha no execute, não adia

  const foraDaJanela = await adiarAteAJanelaAbrir(ctx.admin, ctx.organizationId, parsed.channel_session_id);
  if (foraDaJanela) return foraDaJanela;

  const daily = await checkDailyLimit(ctx.admin, ctx.organizationId, parsed.channel_session_id);
  return daily.allowed ? null : (daily.retry_at ?? null);
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const parsed = lerConfig(config);
  if (!parsed) {
    return { type: "send_template", status: "failed", error: "missing_config" };
  }
  // Mesmas guardas compartilhadas com send_whatsapp_message/send_ai_message —
  // ver guarda-do-contato.ts (existe/bloqueado/telefone/consentimento).
  const guarda = checarGuardasDeContato(ctx);
  if (!guarda.ok) return { type: "send_template", status: "skipped", detail: { reason: guarda.reason } };
  const contact = guarda.contact;

  if (await jaEnviadoAEsteContato(ctx, contact.id, parsed.template_name)) {
    return {
      type: "send_template",
      status: "skipped",
      detail: { reason: "template_ja_enviado_a_este_contato", template_name: parsed.template_name },
    };
  }

  try {
    await assertAgendaEffectSupabase(ctx.admin, { organizationId: ctx.organizationId, contactId: contact.id });
    const boundary = await serviceForAutomation(ctx, contact.id, parsed.channel_session_id);
    const conversationId = boundary.conversation_id;
    await espacarEnvio(parsed.channel_session_id);
    // Slots do template (se houver) aceitam os mesmos tokens {{nome}}/
    // {{telefone}}/{{lead.title}} que o texto livre já usa — `renderTemplate`
    // é o MESMO resolvedor, só aplicado a cada valor em vez de ao corpo inteiro.
    const template_values = Object.fromEntries(
      Object.entries(parsed.template_values ?? {}).map(([k, v]) => [k, renderTemplate(v, ctx.context)]),
    );
    const body = await corpoRenderizado(ctx, parsed, template_values);
    const message = await sendMessageHandler(
      ctx.admin,
      {
        organization_id: ctx.organizationId,
        serviceBoundary: boundary,
        proactiveContext: { organizationId: ctx.organizationId, contactId: contact.id },
        actor: { type: "webhook_source", id: ctx.ruleId },
        requestId: `rule:${ctx.ruleId}`,
      },
      {
        conversation_id: conversationId,
        type: "template",
        template_name: parsed.template_name,
        template_language: parsed.template_language,
        template_values,
        body,
      } as Parameters<typeof sendMessageHandler>[2],
    );
    // O desfecho vem do ESTADO DA MENSAGEM, nunca da ausência de exceção —
    // mesmo cuidado de send-whatsapp.ts (ver desfecho-do-envio.ts).
    return await reportarEnvio(ctx, "send_template", message as unknown as MensagemEnviada, conversationId);
  } catch (err) {
    return {
      type: "send_template",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

registerAction({ type: "send_template", postponeUntil, execute });
