import { useAuth } from "@/_core/hooks/useAuth";
import { money } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { canCapability } from "@shared/permissions";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

// ADR-010: comissão já paga em contrato distratado nunca é estornada sozinha. Esta fila mostra o que espera decisão manual
// (estornar / compensar / dispensar) e só aparece para quem tem `commission.pay`; o servidor continua sendo quem decide.
export const REVERSAL_DECISIONS = [
  { value: "reversed", label: "Estornada (valor devolvido)" },
  { value: "offset", label: "Compensada em outro lançamento" },
  { value: "waived", label: "Dispensada (sem estorno)" },
] as const;
type Decision = (typeof REVERSAL_DECISIONS)[number]["value"];

export function CommissionReversalQueue() {
  const { user } = useAuth();
  const canResolve = Boolean(user && canCapability(user.role, "commission.pay"));
  const utils = trpc.useUtils();
  const queue = trpc.commissions.reversalQueue.useQuery(undefined, { enabled: canResolve });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [decision, setDecision] = useState<Decision>("reversed");
  const [financialTransactionId, setFinancialTransactionId] = useState("");
  const [note, setNote] = useState("");
  const resolve = trpc.commissions.resolveReversalReview.useMutation({
    onSuccess: () => { utils.commissions.reversalQueue.invalidate(); setSelectedId(null); setNote(""); setFinancialTransactionId(""); toast.success("Revisão de estorno registrada."); },
    onError: error => toast.error(error.message),
  });
  if (!canResolve) return null;
  const rows = queue.data ?? [];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedId === null) return;
    const transactionId = financialTransactionId.trim() ? Number(financialTransactionId) : undefined;
    if (transactionId !== undefined && (!Number.isInteger(transactionId) || transactionId <= 0)) return toast.error("Informe um número de lançamento válido ou deixe em branco.");
    if (note.trim().length < 5) return toast.error("Descreva a decisão (mínimo 5 caracteres).");
    resolve.mutate({ id: selectedId, decision, note: note.trim(), ...(transactionId !== undefined ? { financialTransactionId: transactionId } : {}) });
  };

  return <Card className="rounded-xl border-[#dcd4c4] shadow-none" data-testid="commission-reversal-queue">
    <CardHeader><p className="tgr-data-label text-[#8a6b2d]">Distrato · comissão já paga</p><CardTitle className="mt-1 font-serif text-2xl">Fila de revisão de estorno</CardTitle><p className="text-sm text-[#6d6a62]">Comissões pagas de contratos distratados não são estornadas automaticamente. Decida cada caso e registre a nota.</p></CardHeader>
    <CardContent className="space-y-3">
      {queue.isLoading ? <p className="text-sm text-[#6d6a62]">Carregando fila...</p> : rows.length === 0 ? <p className="text-sm text-[#6d6a62]">Nenhuma comissão aguardando revisão de estorno.</p> : rows.map(row => <div key={row.id} className="flex flex-col gap-3 rounded-xl border border-[#e9e4da] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0"><p className="font-semibold text-[#1d2b2a]">{row.sellerName ?? `Vendedor #${row.sellerId}`} · {row.commissionRole} · {money(Number(row.amount))}</p><p className="text-xs text-[#6d6a62]">Contrato {row.contractNumber ?? row.contractId ?? "—"} · comissão #{row.id}{row.reversalReviewRequestedAt ? ` · enfileirada em ${new Date(row.reversalReviewRequestedAt).toLocaleDateString("pt-BR")}` : ""}</p>{row.reversalReviewReason ? <p className="mt-1 text-xs text-[#8a6b2d]">{row.reversalReviewReason}</p> : null}</div>
        <Button size="sm" variant="outline" className="rounded-xl border-[#d9cfbd]" onClick={() => { setSelectedId(row.id); setDecision("reversed"); }}>Resolver</Button>
      </div>)}
    </CardContent>
    <Dialog open={selectedId !== null} onOpenChange={open => { if (!open) setSelectedId(null); }}><DialogContent className="max-h-[88vh] overflow-y-auto"><DialogHeader><DialogTitle className="font-serif text-2xl">Resolver revisão de estorno</DialogTitle><DialogDescription>Registra a decisão manual e a nota; o evento fica auditado.</DialogDescription></DialogHeader>
      <form className="grid gap-4 py-2" onSubmit={submit}>
        <div className="grid gap-2"><Label>Decisão *</Label><Select value={decision} onValueChange={value => setDecision(value as Decision)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{REVERSAL_DECISIONS.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-2"><Label>Lançamento financeiro de referência (opcional)</Label><Input inputMode="numeric" value={financialTransactionId} onChange={event => setFinancialTransactionId(event.target.value)} placeholder="ID do lançamento" /></div>
        <div className="grid gap-2"><Label>Nota *</Label><Textarea value={note} onChange={event => setNote(event.target.value)} minLength={5} maxLength={2000} required /></div>
        <Button disabled={resolve.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">{resolve.isPending ? "Registrando..." : "Registrar decisão"}</Button>
      </form>
    </DialogContent></Dialog>
  </Card>;
}
