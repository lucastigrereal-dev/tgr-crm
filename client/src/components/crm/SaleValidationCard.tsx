import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { canCapability } from "@shared/permissions";
import { Check, Circle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

// ADR-007 (V6): os cinco portões da venda validada. O servidor decide; aqui só mostramos e oferecemos as ações ao gerente (admin).
const GATE_LABELS: Array<{ key: "paymentConfirmed" | "contractGenerated" | "contractSigned" | "signedDocumentStored" | "managerValidated"; label: string }> = [
  { key: "paymentConfirmed", label: "Pagamento confirmado" },
  { key: "contractGenerated", label: "Contrato gerado" },
  { key: "contractSigned", label: "Contrato assinado" },
  { key: "signedDocumentStored", label: "Documento assinado armazenado" },
  { key: "managerValidated", label: "Validação final do gerente" },
];

export function SaleValidationCard({ contractId }: { contractId: number }) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const status = trpc.saleValidation.getValidationStatus.useQuery({ contractId }, { enabled: Boolean(contractId) });
  const refresh = () => Promise.all([utils.saleValidation.getValidationStatus.invalidate({ contractId }), utils.contracts.detail.invalidate({ id: contractId }), utils.contracts.list.invalidate()]);
  const confirm = trpc.saleValidation.confirmPayment.useMutation({ onSuccess: async () => { await refresh(); setOpen(false); setNote(""); toast.success("Pagamento confirmado."); }, onError: error => toast.error(error.message) });
  const validate = trpc.saleValidation.validateSale.useMutation({ onSuccess: async () => { await refresh(); toast.success("Venda validada. Contrato ativo."); }, onError: error => { void refresh(); toast.error(error.message); } });
  const canConfirm = Boolean(user && canCapability(user.role, "sale.payment.confirm"));
  const canValidate = Boolean(user && canCapability(user.role, "sale.validate"));
  const data = status.data;
  return <Card className="rounded-xl border-[#e9e4da] shadow-none">
    <CardHeader className="border-b border-[#eee9df] pb-4"><p className="tgr-data-label text-[#94702e]">Venda validada</p><CardTitle className="mt-1 font-serif text-xl text-[#1d2b2a]">Portões de validação</CardTitle></CardHeader>
    <CardContent className="space-y-3 pt-5 text-sm">
      {status.isLoading ? <p className="text-muted-foreground">Lendo portões…</p> : !data ? <p className="text-muted-foreground">Não foi possível ler a validação desta venda.</p> : <>
        <ul className="space-y-2">{GATE_LABELS.map(({ key, label }) => <li key={key} className="flex items-center gap-2" data-testid={`gate-${key}`}>{data.gates[key] ? <Check className="h-4 w-4 text-emerald-700" aria-label="atendido" /> : <Circle className="h-4 w-4 text-muted-foreground" aria-label="pendente" />}<span className={data.gates[key] ? "font-medium" : "text-muted-foreground"}>{label}</span></li>)}</ul>
        {data.gates.missing.length ? <p className="text-xs text-muted-foreground">Pendências para validar: {data.gates.missing.length}.</p> : null}
        {canConfirm || canValidate ? <div className="flex flex-wrap gap-2 pt-1">
          {canConfirm && !data.gates.paymentConfirmed ? <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" className="border-[#d9cfbd]">Confirmar pagamento</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle className="font-serif text-2xl">Confirmar pagamento</DialogTitle></DialogHeader><form className="grid gap-3 py-2" onSubmit={event => { event.preventDefault(); confirm.mutate({ contractId, note }); }}><div className="grid gap-2"><Label htmlFor="payment-note">Nota de conferência</Label><Input id="payment-note" value={note} onChange={event => setNote(event.target.value)} minLength={3} required /></div><Button type="submit" disabled={confirm.isPending || note.trim().length < 3}>Confirmar</Button></form></DialogContent></Dialog> : null}
          {canValidate && !data.gates.managerValidated ? <Button disabled={!data.gates.ready || validate.isPending} onClick={() => validate.mutate({ contractId })}>Validar venda</Button> : null}
        </div> : null}
      </>}
    </CardContent>
  </Card>;
}
