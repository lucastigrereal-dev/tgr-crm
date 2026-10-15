import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { money } from "@/components/crm/ui";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

const stateLabel = { issued: "Válido", redeemed: "Usado", cancelled: "Cancelado", expired: "Vencido" } as const;
const stateTone = { issued: "bg-[#e5efe4] text-[#285043]", redeemed: "bg-[#e6eef5] text-[#315d7e]", cancelled: "bg-[#f3e4e1] text-[#8a3b2d]", expired: "bg-[#f4efe2] text-[#8a6b2d]" } as const;
const dateLabel = (value: string | null) => value ? new Date(`${value}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "sem validade";

// Vouchers e brindes do associado (TSE #31): emitir com custo e validade, dar baixa no uso e cancelar com motivo.
export function VouchersCard({ customerId }: { customerId: number }) {
  // Os botões seguem o servidor: emitir e dar baixa é da recepção e da venda (admin, seller, service); cancelar é da
  // venda (admin, seller). Quem não pode, como o financeiro, vê só o histórico.
  const { user } = useAuth();
  const canIssue = user?.role === "admin" || user?.role === "seller" || user?.role === "service";
  const canCancel = user?.role === "admin" || user?.role === "seller";
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const utils = trpc.useUtils();
  const list = trpc.vouchers.listByCustomer.useQuery({ customerId }, { enabled: customerId > 0 });
  const refresh = () => void utils.vouchers.listByCustomer.invalidate({ customerId });
  const issue = trpc.vouchers.issue.useMutation({ onSuccess: r => { setDescription(""); setCost(""); setExpiresAt(""); toast.success(`Voucher ${r.code} emitido.`); refresh(); }, onError: e => toast.error(e.message) });
  const redeem = trpc.vouchers.redeem.useMutation({ onSuccess: () => { toast.success("Baixa registrada."); refresh(); }, onError: e => toast.error(e.message) });
  const cancel = trpc.vouchers.cancel.useMutation({ onSuccess: () => { toast.success("Voucher cancelado."); refresh(); }, onError: e => toast.error(e.message) });
  const submit = () => {
    if (description.trim().length < 3) return toast.error("Descreva o brinde.");
    const costAmount = cost.trim() ? Number(cost.replace(",", ".")) : 0;
    if (!Number.isFinite(costAmount) || costAmount < 0) return toast.error("Custo inválido.");
    issue.mutate({ customerId, description, costAmount, expiresAt: expiresAt || undefined });
  };

  return <Card className="rounded-[1.35rem] border-[#e9e4da]">
    <CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Vouchers e brindes</CardTitle><p className="text-xs text-muted-foreground">O que foi prometido ao casal, quanto custa, até quando vale e se já foi usado.</p></CardHeader>
    <CardContent className="space-y-3">
      {canIssue && <div className="grid gap-2 sm:grid-cols-[1fr_120px_150px_auto]">
        <Input value={description} onChange={e => setDescription(e.target.value)} maxLength={255} placeholder="Brinde (ex.: jantar para 2)" className="h-9" />
        <Input value={cost} onChange={e => setCost(e.target.value)} inputMode="decimal" placeholder="Custo R$" className="h-9" />
        <Input value={expiresAt} onChange={e => setExpiresAt(e.target.value)} type="date" aria-label="Validade" className="h-9" />
        <Button size="sm" className="h-9" disabled={issue.isPending} onClick={submit}>{issue.isPending ? "Emitindo..." : "Emitir"}</Button>
      </div>}
      {list.data?.length === 0 && <p className="text-xs text-muted-foreground">Nenhum voucher emitido.</p>}
      {(list.data ?? []).map(voucher => <div key={voucher.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#faf8f3] p-3 text-sm">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">{voucher.code} · {money(voucher.costAmount)} · {dateLabel(voucher.expiresAt)}</p>
          <p className="break-words text-[#1d2b2a]">{voucher.description}</p>
          {voucher.cancelReason && <p className="text-xs text-muted-foreground">Motivo: {voucher.cancelReason}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Badge className={stateTone[voucher.state]}>{stateLabel[voucher.state]}</Badge>
          {voucher.state === "issued" && <>
            {canIssue && <Button size="sm" variant="outline" disabled={redeem.isPending} onClick={() => redeem.mutate({ code: voucher.code })}>Dar baixa</Button>}
            {canCancel && <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => { const reason = window.prompt("Motivo do cancelamento:"); if (reason?.trim()) cancel.mutate({ id: voucher.id, reason }); }}>Cancelar</Button>}
          </>}
        </div>
      </div>)}
    </CardContent>
  </Card>;
}
