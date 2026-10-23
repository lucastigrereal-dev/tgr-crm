import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HistoryList, type HistoryState } from "./panels";
import { formatWhen } from "./text";

// F3.1 (modo sombra): painel de apresentação. Nada aqui cancela contrato; o texto da tela diz isso com todas as letras.
export type RescueSettingsValues = { rescueWindowMonths: number; rescueAlertLeadDays: number; autoCancelEnabled: boolean; rescueReopenAfterDays: number; autoCancelPromiseDays: number; autoCancelMaxPaidPercent: number };
export type ShadowRow = { caseId: number; contractNumber: string; status: string; manualReviewReason: string | null; rescueDueAt: unknown; wouldRun: unknown };

const FIELDS: Array<{ key: Exclude<keyof RescueSettingsValues, "autoCancelEnabled">; label: string; help: string; min: number; max: number; unit: string }> = [
  { key: "rescueWindowMonths", label: "Prazo do resgate", help: "Conta da primeira parcela vencida e não paga.", min: 1, max: 24, unit: "meses" },
  { key: "rescueAlertLeadDays", label: "Avisar antes do fim do prazo", help: "O pós-vendas recebe o alerta de que o prazo vai vencer.", min: 0, max: 365, unit: "dias" },
  { key: "rescueReopenAfterDays", label: "Não reabrir caso encerrado por", help: "Evita recomeçar o prazo com a mesma parcela vencida.", min: 1, max: 730, unit: "dias" },
  { key: "autoCancelPromiseDays", label: "Teto: promessa de pagamento recente", help: "Com promessa ou renegociação nos últimos N dias, a decisão fica com uma pessoa.", min: 0, max: 365, unit: "dias" },
  { key: "autoCancelMaxPaidPercent", label: "Teto: valor já pago do contrato", help: "Acima disso, a decisão fica com uma pessoa.", min: 0, max: 100, unit: "%" },
];
const REASON_TEXT: Record<string, string> = { paid_commission: "comissão já paga", open_renegotiation: "renegociação aberta", recent_promise: "promessa recente", over_cap: "valor pago acima do teto", domain_error: "erro" };
const STATUS_TEXT: Record<string, string> = { due_for_cancellation: "Prazo vencido", manual_review: "Decisão manual" };

export function RescuePanel({ settings, isDefault, provisional, pending, onSave, history, shadow }: { settings: RescueSettingsValues; isDefault: boolean; provisional: boolean; pending: boolean; onSave: (values: RescueSettingsValues & { note?: string }) => void; history: HistoryState; shadow: ShadowRow[] | "error" | undefined }) {
  const [draft, setDraft] = useState<RescueSettingsValues>(settings);
  const [note, setNote] = useState("");
  const valid = FIELDS.every(field => Number.isInteger(draft[field.key]) && draft[field.key] >= field.min && draft[field.key] <= field.max);
  return <div className="space-y-6">
    <div role="status" className="rounded-xl border border-[#e9e4da] bg-[#f8f5ee] p-4 text-sm leading-6">
      <p className="font-semibold text-[#1d2b2a]">Modo sombra: só registra, não age</p>
      <p className="text-muted-foreground">Esta tela controla a fila de resgate do pós-vendas e o que o distrato automático <strong>faria</strong>. Nenhum contrato é distratado, nenhuma parcela, comissão ou cota é alterada por aqui. {provisional ? "Os valores abaixo são provisórios até chegar o modelo de contrato." : ""}</p>
    </div>
    <section aria-label="Prazos e tetos" className="rounded-xl border border-[#e9e4da] bg-white p-4">
      <p className="mb-3 text-xs text-muted-foreground">{isDefault ? "Usando os valores padrão (provisórios)." : "Usando a última versão salva."}</p>
      <div className="grid gap-3 md:grid-cols-2">{FIELDS.map(field => <label key={field.key} className="grid gap-1 text-sm">{field.label} ({field.unit})
        <Input aria-label={field.label} type="number" min={field.min} max={field.max} value={Number.isFinite(draft[field.key]) ? draft[field.key] : ""} onChange={event => setDraft({ ...draft, [field.key]: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
        <span className="text-xs text-muted-foreground">{field.help}</span></label>)}</div>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.autoCancelEnabled} onChange={event => setDraft({ ...draft, autoCancelEnabled: event.target.checked })} aria-label="Registrar o que o distrato automático faria" />Registrar o que o distrato automático faria (ensaio; desligado por padrão)</label>
      <label className="mt-3 grid gap-1 text-sm">Motivo da mudança (opcional)<Input aria-label="Motivo da mudança" maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>
      {valid ? null : <p role="alert" className="mt-2 text-sm text-[#9a3b2e]">Confira os valores: algum está fora do limite permitido.</p>}
      <Button className="mt-3" size="sm" disabled={pending || !valid} onClick={() => onSave({ ...draft, note: note.trim() || undefined })}>Salvar nova versão</Button>
      <p className="mt-2 text-xs text-muted-foreground">Vale para casos abertos depois. Casos em andamento mantêm o prazo que já tinham.</p>
    </section>
    <section aria-label="O que o sistema teria feito">
      <p className="text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">Prazo vencido (ensaio)</p>
      {shadow === "error" ? <p role="alert" className="mt-2 text-sm text-[#9a3b2e]">Não foi possível ler os casos agora. Tente de novo em alguns minutos.</p> : !shadow ? <p className="mt-2 text-sm text-muted-foreground">Carregando...</p> : shadow.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Nenhum caso com prazo vencido.</p> :
        <ul className="mt-2 space-y-2">{shadow.map(row => <li key={row.caseId} className="rounded-lg border border-[#ece6da] bg-white p-3 text-sm"><p className="font-medium">Contrato {row.contractNumber} <Badge variant="outline">{STATUS_TEXT[row.status] ?? "Em análise"}</Badge></p>
          <p className="mt-1 text-xs text-muted-foreground">Prazo até {formatWhen(row.rescueDueAt)}. {row.wouldRun ? "O distrato automático teria sido pedido. Nada foi cancelado." : row.manualReviewReason ? `O distrato automático não seria feito: ${REASON_TEXT[row.manualReviewReason] ?? "decisão humana"}.` : "Decisão manual da administração."}</p></li>)}</ul>}
    </section>
    <HistoryList entries={history} />
  </div>;
}
