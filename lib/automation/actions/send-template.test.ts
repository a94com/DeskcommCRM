/**
 * `send_template` — dispara um TEMPLATE APROVADO da Meta a partir de uma
 * automação (ex.: "lead entrou na etapa X"). O que se prova aqui:
 *
 *   1. config faltando falha rápido, sem tocar o banco;
 *   2. a TRAVA DE DUPLICIDADE (pedido do usuário, 2026-09) — se este contato já
 *      recebeu ESTE template alguma vez, pula sem chamar `sendMessageHandler`,
 *      mesmo que tudo o resto esteja correto. É a garantia real contra reenvio
 *      quando o lead volta pra mesma etapa; o aviso na tela é só cortesia.
 *   3. caminho feliz: sem duplicata, chama `sendMessageHandler` com
 *      `type:"template"` e os dados certos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "@/lib/automation/types";

const assertAgendaEffectSupabase = vi.fn();
const serviceForAutomation = vi.fn();
const sendMessageHandler = vi.fn();
const espacarEnvio = vi.fn();

vi.mock("@/lib/agenda/efeito", () => ({
  assertAgendaEffectSupabase: (...args: unknown[]) => assertAgendaEffectSupabase(...args),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: (...args: unknown[]) => serviceForAutomation(...args),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => sendMessageHandler(...args),
}));
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: (...args: unknown[]) => espacarEnvio(...args),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));

import { getAction } from "@/lib/automation/actions";
// Importa pela porta do efeito colateral, igual `register-all.ts`.
import "@/lib/automation/actions/send-template";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSAO = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

/**
 * Dublê do admin — `messages` (trava de duplicidade) e `meta_templates`
 * (renderizar o `body` antes de enviar, ver `corpoRenderizado`). Sem
 * `componentes`, cai no fallback "não espelhada" (`data: null`) e
 * `corpoRenderizado` devolve `""` — os casos que checam o texto de verdade
 * passam `componentes`.
 *
 * `channelSessionIdNulo: true` simula a linha real que causou o balão vazio
 * mesmo DEPOIS da primeira correção (2026-09-15): `meta_templates.channel_
 * session_id` é NULL, então a consulta com esse filtro nunca acha nada — só a
 * segunda tentativa (sem o filtro) acha. Rastreia se `.eq("channel_session_id"`
 * entrou na cadeia desta chamada pra decidir qual das duas respostas devolver.
 */
function bancoFalso(opts: {
  jaEnviado: boolean;
  erroNaLeitura?: boolean;
  componentes?: Array<{ type: string; text: string }>;
  channelSessionIdNulo?: boolean;
}) {
  const from = vi.fn((tabela: string) => {
    if (tabela === "meta_templates") {
      let filtrouPorSessao = false;
      const encadeavelTpl: Record<string, unknown> = {
        select: () => encadeavelTpl,
        eq: (campo: string) => {
          if (campo === "channel_session_id") filtrouPorSessao = true;
          return encadeavelTpl;
        },
      };
      encadeavelTpl.maybeSingle = async () => {
        if (!opts.componentes) return { data: null, error: null };
        if (opts.channelSessionIdNulo && filtrouPorSessao) return { data: null, error: null };
        return { data: { components: opts.componentes, parameter_format: "POSITIONAL" }, error: null };
      };
      return encadeavelTpl;
    }
    if (tabela !== "messages") throw new Error(`Tabela não prevista: ${tabela}`);
    const encadeavel: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "limit"]) {
      encadeavel[metodo] = () => encadeavel;
    }
    encadeavel.maybeSingle = async () => {
      if (opts.erroNaLeitura) return { data: null, error: { message: "connection terminated" } };
      return { data: opts.jaEnviado ? { id: "msg-antiga" } : null, error: null };
    };
    return encadeavel;
  });
  return { from } as unknown as ActionCtx["admin"];
}

function contexto(admin: ActionCtx["admin"]): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "regra-1",
    ruleName: "Template automático — Primeiro Contato",
    event: { id: "evento-1" } as ActionCtx["event"],
    requestId: "req-1",
    context: { contact: { id: CONTATO, phone_number: "+5511999998888" } },
  };
}

function executar(ctx: ActionCtx, config: Record<string, unknown> = {}) {
  const acao = getAction("send_template");
  if (!acao) throw new Error("send_template não está registrada");
  return acao.execute(ctx, {
    channel_session_id: SESSAO,
    template_name: "aluggo_semnome",
    template_language: "pt_BR",
    ...config,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  assertAgendaEffectSupabase.mockResolvedValue(undefined);
  serviceForAutomation.mockResolvedValue({ conversation_id: "conversa-1" });
  sendMessageHandler.mockResolvedValue({ id: "mensagem-1", status: "sent" });
  espacarEnvio.mockResolvedValue(undefined);
});

describe("send_template — config", () => {
  it("falha rápido, sem tocar o banco, quando falta algo obrigatório", async () => {
    const admin = bancoFalso({ jaEnviado: false });
    const acao = getAction("send_template")!;
    const r = await acao.execute(contexto(admin), { channel_session_id: SESSAO });
    expect(r).toEqual({ type: "send_template", status: "failed", error: "missing_config" });
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });
});

describe("send_template — trava contra reenvio duplicado", () => {
  it("pula, sem enviar, quando este contato já recebeu este template antes", async () => {
    const admin = bancoFalso({ jaEnviado: true });

    const r = await executar(contexto(admin));

    expect(r).toEqual({
      type: "send_template",
      status: "skipped",
      detail: { reason: "template_ja_enviado_a_este_contato", template_name: "aluggo_semnome" },
    });
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(serviceForAutomation).not.toHaveBeenCalled();
  });

  it("falha de LEITURA na checagem de duplicidade também pula — não presume 'nunca enviei'", async () => {
    // Reenviar por engano custa dinheiro de verdade (conversa Meta); se não deu
    // pra conferir, o caminho seguro é pular, não mandar.
    const admin = bancoFalso({ jaEnviado: false, erroNaLeitura: true });

    const r = await executar(contexto(admin));

    expect(r.status).toBe("skipped");
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });
});

describe("send_template — caminho feliz", () => {
  it("sem duplicata, envia com type:template e os dados certos", async () => {
    const admin = bancoFalso({ jaEnviado: false });

    const r = await executar(contexto(admin));

    expect(r.status).toBe("success");
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    const [, , input] = sendMessageHandler.mock.calls[0]!;
    expect(input).toMatchObject({
      conversation_id: "conversa-1",
      type: "template",
      template_name: "aluggo_semnome",
      template_language: "pt_BR",
    });
  });

  it("resolve tokens {{nome}}/{{telefone}} nos valores dos slots", async () => {
    const admin = bancoFalso({ jaEnviado: false });
    const ctx = contexto(admin);
    ctx.context = { contact: { id: CONTATO, phone_number: "+5511999998888", name: "Kamila" } };

    await executar(ctx, { template_values: { "1": "{{nome}}" } });

    const [, , input] = sendMessageHandler.mock.calls[0]!;
    expect((input as { template_values: Record<string, string> }).template_values).toEqual({ "1": "Kamila" });
  });

  it("preenche body com o texto RENDERIZADO do template — achado ao ver o Inbox com balão vazio (2026-09-15)", async () => {
    // `_handler.ts` só grava `template_name`/`template_language` no envio — quem
    // decide o `body` é o CHAMADOR. Sem isto, a Meta manda o template de
    // verdade e o Inbox mostra a conversa muda (aconteceu com dois leads reais
    // antes deste caso existir).
    const admin = bancoFalso({
      jaEnviado: false,
      componentes: [{ type: "BODY", text: "Oi {{1}}! Tudo bem?" }],
    });

    await executar(contexto(admin), { template_values: { "1": "Genivaldo" } });

    const [, , input] = sendMessageHandler.mock.calls[0]!;
    expect((input as { body: string }).body).toBe("Oi Genivaldo! Tudo bem?");
  });

  it("channel_session_id nulo na linha real: cai pra segunda tentativa e ainda acha o texto", async () => {
    // Regressão exata do relato do usuário com o lead Edivaldo (2026-09-15):
    // o primeiro fix passou a buscar o texto, mas só tentava COM o filtro de
    // sessão — a linha de "etapa2" tem essa coluna nula, então a primeira
    // tentativa sempre voltava vazia e o balão continuou em branco.
    const admin = bancoFalso({
      jaEnviado: false,
      componentes: [{ type: "BODY", text: "Oi! Tudo bem?" }],
      channelSessionIdNulo: true,
    });

    await executar(contexto(admin));

    const [, , input] = sendMessageHandler.mock.calls[0]!;
    expect((input as { body: string }).body).toBe("Oi! Tudo bem?");
  });

  it("template não espelhado (sem componentes) manda body vazio, não falha o envio", async () => {
    const admin = bancoFalso({ jaEnviado: false }); // sem `componentes`

    const r = await executar(contexto(admin));

    expect(r.status).toBe("success");
    const [, , input] = sendMessageHandler.mock.calls[0]!;
    expect((input as { body: string }).body).toBe("");
  });

  it("contato bloqueado/sem telefone é pulado antes mesmo de checar duplicidade", async () => {
    const admin = bancoFalso({ jaEnviado: false });
    const ctx = contexto(admin);
    ctx.context = { contact: { id: CONTATO, phone_number: "+5511999998888", is_blocked: true } };

    const r = await executar(ctx);

    expect(r).toEqual({ type: "send_template", status: "skipped", detail: { reason: "contact_blocked" } });
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });
});
