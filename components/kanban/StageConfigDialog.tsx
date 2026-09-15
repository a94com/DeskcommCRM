"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useApprovedTemplates } from "@/hooks/channels/useApprovedTemplates";
import { useStageAutoTemplate, useSalvarStageAutoTemplate } from "@/hooks/pipelines/useStageAutoTemplate";
import { useEditarEtapa } from "@/hooks/pipelines/useStages";
import type { Stage } from "@/lib/kanban/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipelineId: string;
  stage: Stage;
}

const RISK_COLD_HOURS_PADRAO = 24;

/**
 * Pop-up de configuração DA ETAPA — o usuário nunca precisa ir em Automações
 * nem entender `expected_duration_hours`: aqui é "manda esse template" e
 * "quanto tempo até esfriar", em português.
 */
export function StageConfigDialog({ open, onOpenChange, pipelineId, stage }: Props) {
  const t = useT();
  const { data: sessions } = useChannelSessions();
  const { data: templates, isLoading: templatesLoading } = useApprovedTemplates();
  const { data: atual, isLoading: atualLoading } = useStageAutoTemplate(pipelineId, stage.id, open);
  const salvarAutoTemplate = useSalvarStageAutoTemplate(pipelineId, stage.id);
  const editarEtapa = useEditarEtapa(pipelineId);

  const [enabled, setEnabled] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [templateChave, setTemplateChave] = useState("");
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});

  const [coldValor, setColdValor] = useState<string>(String(RISK_COLD_HOURS_PADRAO));
  const [coldUnidade, setColdUnidade] = useState<"horas" | "dias">("horas");

  // Re-sincroniza com o que veio do servidor toda vez que o pop-up abre —
  // nunca no meio da edição, senão a digitação do usuário seria apagada por
  // baixo dele a cada refetch.
  useEffect(() => {
    if (!open) return;
    if (atual) {
      setEnabled(atual.enabled);
      setSessionId(atual.channel_session_id ?? "");
      setTemplateChave(
        atual.template_name && atual.template_language ? `${atual.template_name} ${atual.template_language}` : "",
      );
      setTemplateValues(atual.template_values ?? {});
    }
    const horasAtuais = stage.expected_duration_hours ?? RISK_COLD_HOURS_PADRAO;
    if (horasAtuais % 24 === 0 && horasAtuais >= 24) {
      setColdValor(String(horasAtuais / 24));
      setColdUnidade("dias");
    } else {
      setColdValor(String(horasAtuais));
      setColdUnidade("horas");
    }
  }, [open, atual, stage.expected_duration_hours]);

  const templateEscolhido = (templates ?? []).find(
    (tpl) => `${tpl.name} ${tpl.language}` === templateChave,
  );

  const salvando = salvarAutoTemplate.isPending || editarEtapa.isPending;

  async function salvar() {
    if (enabled && (!sessionId || !templateEscolhido)) {
      toast.error(t("Escolha o número e o template antes de ligar o disparo automático."));
      return;
    }
    const horas = Number(coldValor);
    if (!Number.isFinite(horas) || horas <= 0) {
      toast.error(t("O tempo até esfriar precisa ser um número maior que zero."));
      return;
    }
    const expectedDurationHours = Math.round(coldUnidade === "dias" ? horas * 24 : horas);

    try {
      await Promise.all([
        salvarAutoTemplate.mutateAsync({
          enabled,
          channel_session_id: sessionId,
          template_name: templateEscolhido?.name ?? "",
          template_language: templateEscolhido?.language ?? "",
          ...(Object.keys(templateValues).length > 0 ? { template_values: templateValues } : {}),
        }),
        editarEtapa.mutateAsync({ stageId: stage.id, patch: { expected_duration_hours: expectedDurationHours } }),
      ]);
      toast.success(t("Configuração da etapa salva."));
      onOpenChange(false);
    } catch {
      toast.error(t("Não consegui salvar a configuração desta etapa."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Configurar etapa")} — {stage.name}</DialogTitle>
          <DialogDescription>
            {t("Vale só para os leads desta coluna.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>{t("Disparo automático de template")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("Quando um lead entrar nesta etapa, manda sozinho o template aprovado escolhido.")}
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={atualLoading} />
            </div>

            {enabled ? (
              <div className="space-y-3 rounded-sm border border-border p-3">
                <div className="space-y-1">
                  <Label>{t("Número de WhatsApp")}</Label>
                  <Select value={sessionId} onValueChange={setSessionId}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("Escolha o número")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(sessions ?? []).map((s) => (
                        <SelectItem key={s.id} value={s.id} disabled={s.status !== "WORKING"}>
                          {channelLabel(s) + (s.status !== "WORKING" ? " — desconectado" : "")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label>{t("Template aprovado")}</Label>
                  <Select
                    value={templateChave}
                    onValueChange={(v) => {
                      setTemplateChave(v);
                      setTemplateValues({});
                    }}
                    disabled={templatesLoading}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("Escolha um template aprovado")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(templates ?? []).map((tpl) => (
                        <SelectItem key={`${tpl.name} ${tpl.language}`} value={`${tpl.name} ${tpl.language}`}>
                          {tpl.name} ({tpl.language})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!templatesLoading && (templates ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("Nenhum template aprovado ainda. Sincronize em Conexões.")}
                    </p>
                  ) : null}
                </div>

                {templateEscolhido && templateEscolhido.slots.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {t("Este template tem variável — preencha (aceita {{nome}}, {{telefone}}, {{lead.title}}):")}
                    </p>
                    {templateEscolhido.slots.map((slot) => (
                      <div key={slot.key} className="space-y-1">
                        <Label className="text-xs">{slot.key} — {slot.onde}</Label>
                        <Input
                          value={templateValues[slot.key] ?? ""}
                          onChange={(e) => setTemplateValues((v) => ({ ...v, [slot.key]: e.target.value }))}
                          placeholder="{{nome}}"
                        />
                      </div>
                    ))}
                  </div>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  {t("Cada template enviado tem custo de conversa na Meta. Nunca é reenviado duas vezes ao mesmo contato, mesmo que ele volte pra esta etapa.")}
                </p>
              </div>
            ) : null}
          </section>

          <Separator />

          <section className="space-y-1">
            <Label>{t("Lead frio nesta etapa")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("Quanto tempo sem resposta até o card ficar sinalizado como esfriando.")}
            </p>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={coldValor}
                onChange={(e) => setColdValor(e.target.value)}
                className="w-24"
              />
              <Select value={coldUnidade} onValueChange={(v) => setColdUnidade(v as "horas" | "dias")}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="horas">{t("horas")}</SelectItem>
                  <SelectItem value="dias">{t("dias")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {stage.expected_duration_hours === null ? (
              <p className="text-xs text-muted-foreground">
                {t("Ainda não configurado — usando o padrão de 24h.")}
              </p>
            ) : null}
          </section>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={salvando}>
            {t("Cancelar")}
          </Button>
          <Button type="button" onClick={() => void salvar()} disabled={salvando}>
            {salvando ? t("Salvando…") : t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
