import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { InboundMessageEvent } from "@/lib/channels/meta/webhook";
import { getAdapter } from "@/lib/channels";
import { MediaTooLargeError } from "@/lib/messaging/media/types";

// `fetchInboundMedia` resolve a credencial via `resolveMetaCreds`, que consulta
// `channel_sessions` — sem sessão gravada, cai no fallback do `.env`
// (`configurarEnv`, abaixo). Mesmo padrão de mock de
// `tests/unit/channel-adapter-meta.test.ts`.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            is: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * A MÍDIA QUE O CLIENTE MANDA PELO CANAL OFICIAL.
 *
 * ─── O defeito, medido pela tela ────────────────────────────────────────────
 * Um áudio recebido virava bolha VAZIA no inbox — nem player, nem "mídia
 * indisponível", nada — porque nenhum dos três elos que
 * `tests/unit/midia-de-entrada-por-canal.test.ts` já cobra para o canal
 * intermediado jamais existiu para o canal oficial:
 *
 * 1. `ingestMetaInbound` guardava o anexo só em `metadata.meta_media_id` e
 *    deixava `media_url` NULO — nem o worker de persistência nem a rota de
 *    proxy têm o que perguntar.
 * 2. Ninguém emitia `media.persist_requested` — o worker nunca acordava.
 * 3. `metaCloudAdapter` não implementava `fetchInboundMedia` — mesmo acordado
 *    e com o que baixar, não havia COMO.
 *
 * Os casos abaixo cobrem os três, cada um com seu próprio sabote — a mesma
 * lição que o cabeçalho do arquivo irmão registra: consertar um só deixaria os
 * outros dois calados.
 */

const ORG = "22222222-0000-4000-8000-000000000001";

const EVENTO_AUDIO: InboundMessageEvent = {
  kind: "inbound_message",
  wabaId: "waba-1",
  phoneNumberId: "111",
  externalId: "wamid.AUDIO1",
  from: "5531998966398",
  profileName: "Cliente",
  sentAt: new Date("2026-09-09T19:22:00.000Z"),
  type: "audio",
  text: null,
  // A Cloud API nunca manda `url` de verdade aqui (conferido contra o parser
  // em `webhook.ts` — o campo existe no tipo mas o payload real não o povoa);
  // só o `id`, que expira e exige lookup.
  media: { id: "wamid-media-abc123", url: null, mime: "audio/ogg", voice: true },
};

const EVENTO_TEXTO: InboundMessageEvent = {
  kind: "inbound_message",
  wabaId: "waba-1",
  phoneNumberId: "111",
  externalId: "wamid.TEXTO1",
  from: "5531998966398",
  profileName: "Cliente",
  sentAt: new Date("2026-09-09T19:23:00.000Z"),
  type: "text",
  text: "oi",
  media: null,
};

/**
 * Admin de mentira que leva a ingestão até o fim (sessão → contato → conversa
 * → insert), registrando o payload do INSERT e toda chamada de RPC — é o que
 * os casos abaixo precisam inspecionar, e nenhum fake já existente no repo
 * chega tão longe (o de `ingestao-do-canal-oficial-por-organizacao.test.ts` é
 * feito sob medida para os desfechos ANTES do insert).
 */
function adminAteOFim() {
  const chamadasRpc: Array<{ nome: string; payload: Record<string, unknown> }> = [];
  let inserido: Record<string, unknown> | null = null;

  // Nem toda consulta termina em `.maybeSingle()` — `encontrarContatoPorTelefone`
  // usa `.limit(4)` e dá `await` direto na cadeia. Por isso `alvo` também é
  // THENABLE: cobre os dois jeitos de terminar sem duplicar o fake.
  const resolverTabela = async (tabela: string) => {
    if (tabela === "channel_sessions") {
      return { data: { id: "sessao-1", organization_id: ORG }, error: null };
    }
    if (tabela === "messages") {
      return { data: { id: "msg-1" }, error: null };
    }
    // "contacts": nenhum candidato existente — `fn_upsert_wa_contact` é quem cria.
    return { data: [], error: null };
  };

  const from = (tabela: string) => {
    const alvo: Record<string, unknown> = {
      select: () => alvo,
      eq: () => alvo,
      in: () => alvo,
      is: () => alvo,
      order: () => alvo,
      limit: () => alvo,
      insert: (valores: Record<string, unknown>) => {
        inserido = valores;
        return alvo;
      },
      maybeSingle: () => resolverTabela(tabela),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        resolverTabela(tabela).then(resolve, reject),
    };
    return alvo;
  };

  const rpc = async (nome: string, payload: unknown) => {
    chamadasRpc.push({ nome, payload: payload as Record<string, unknown> });
    if (nome === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
    if (nome === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
    return { data: null, error: null };
  };

  return {
    chamadasRpc,
    inseridoComo: () => inserido,
    client: { from, rpc } as unknown as SupabaseClient,
  };
}

describe("elo 1 — o ID do anexo é gravado onde o worker o procura", () => {
  it("grava `media_url` com o ID do anexo — a Cloud API não manda URL de verdade", async () => {
    const { client, inseridoComo } = adminAteOFim();
    const r = await ingestMetaInbound(client, EVENTO_AUDIO, { organizationId: ORG });
    expect(r.status).toBe("ingested");
    expect(inseridoComo()).toMatchObject({ media_url: "wamid-media-abc123" });
  });

  it("mensagem de texto (sem anexo) não ganha `media_url`", async () => {
    const { client, inseridoComo } = adminAteOFim();
    await ingestMetaInbound(client, EVENTO_TEXTO, { organizationId: ORG });
    expect(inseridoComo()).toMatchObject({ media_url: null });
  });
});

describe("elo 2 — alguém acorda o worker", () => {
  it("emite `media.persist_requested` com o MESMO payload do outro canal", async () => {
    const { client, chamadasRpc } = adminAteOFim();
    await ingestMetaInbound(client, EVENTO_AUDIO, { organizationId: ORG });

    const evento = chamadasRpc.find((c) => c.nome === "emit_event");
    expect(evento).toBeDefined();
    expect(evento?.payload).toMatchObject({
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: "msg-1",
      p_payload: { message_id: "msg-1", conversation_id: "conversa-1" },
      p_organization_id: ORG,
    });
  });

  it("NÃO pede persistência para mensagem sem anexo", async () => {
    // `emit_event` sozinho não basta de sabote: `aplicarEfeitosPosEntrada`
    // emite outros tipos de evento para toda mensagem (lead, agente…) — o que
    // este caso proíbe é especificamente o pedido de mídia.
    const { client, chamadasRpc } = adminAteOFim();
    await ingestMetaInbound(client, EVENTO_TEXTO, { organizationId: ORG });
    const pedidosDeMidia = chamadasRpc.filter(
      (c) => c.nome === "emit_event" && c.payload.p_event_type === "media.persist_requested",
    );
    expect(pedidosDeMidia).toEqual([]);
  });

  it("falha do emit NÃO derruba a ingestão — a mensagem já está gravada", async () => {
    const { client } = adminAteOFim();
    const clienteComEmitQuebrado = {
      from: (client as unknown as { from: (t: string) => unknown }).from,
      rpc: async (nome: string, _payload: unknown) => {
        if (nome === "emit_event") return { data: null, error: { message: "boom" } };
        if (nome === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
        if (nome === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
        return { data: null, error: null };
      },
    } as unknown as SupabaseClient;

    const r = await ingestMetaInbound(clienteComEmitQuebrado, EVENTO_AUDIO, { organizationId: ORG });
    expect(r.status).toBe("ingested");
  });
});

describe("elo 3 — o adapter sabe baixar pelo ID de duas chamadas", () => {
  const a = () => getAdapter("meta_cloud");

  function stubFetchEmDuasEtapas(lookup: unknown, bytes: Uint8Array, headers: Record<string, string>) {
    const spy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => lookup,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (nome: string) => headers[nome.toLowerCase()] ?? null },
        arrayBuffer: async () => bytes.buffer,
      });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  function configurarEnv() {
    vi.stubEnv("META_PHONE_NUMBER_ID", "111");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok-env");
    vi.stubEnv("META_GRAPH_VERSION", "v22.0");
  }

  it("chama a Graph API pelo ID, com Bearer nas DUAS chamadas", async () => {
    configurarEnv();
    const bytes = new Uint8Array([1, 2, 3]);
    const spy = stubFetchEmDuasEtapas(
      { url: "https://lookaside.fbsbx.com/temp/abc", mime_type: "audio/ogg", file_size: 3 },
      bytes,
      { "content-type": "audio/ogg; codecs=opus" },
    );

    const media = await a().fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: "111",
      url: "wamid-media-abc123",
      hintMime: null,
    });

    expect(media.mime).toBe("audio/ogg");
    expect(Buffer.from(media.buffer)).toEqual(Buffer.from(bytes));

    const [lookupUrl, lookupInit] = spy.mock.calls[0]!;
    expect(lookupUrl).toContain("/v22.0/wamid-media-abc123");
    expect((lookupInit.headers as Record<string, string>).Authorization).toBe("Bearer tok-env");

    const [downloadUrl, downloadInit] = spy.mock.calls[1]!;
    expect(downloadUrl).toBe("https://lookaside.fbsbx.com/temp/abc");
    expect((downloadInit.headers as Record<string, string>).Authorization).toBe("Bearer tok-env");
  });

  it("o `content-type` da resposta manda sobre a dica do webhook", async () => {
    configurarEnv();
    stubFetchEmDuasEtapas(
      { url: "https://lookaside.fbsbx.com/temp/xyz", mime_type: "audio/ogg" },
      new Uint8Array([9]),
      { "content-type": "application/octet-stream" },
    );
    const media = await a().fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: "111",
      url: "wamid-media-xyz",
      hintMime: "audio/ogg",
    });
    expect(media.mime).toBe("application/octet-stream");
  });

  it("arquivo grande demais é recusado ANTES de baixar um byte", async () => {
    configurarEnv();
    const spy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://x", file_size: 999_999_999 }),
    });
    vi.stubGlobal("fetch", spy);

    await expect(
      a().fetchInboundMedia!({ organizationId: ORG, sessionRef: "111", url: "wamid-grande", hintMime: null }),
    ).rejects.toThrow(MediaTooLargeError);
    // Só a chamada de lookup — a segunda (o download em si) nunca aconteceu.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sem credencial (nem sessão, nem env), lança em vez de devolver lixo", async () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    await expect(
      a().fetchInboundMedia!({ organizationId: ORG, sessionRef: "111", url: "wamid-x", hintMime: null }),
    ).rejects.toThrow(/meta_not_configured/);
  });
});
