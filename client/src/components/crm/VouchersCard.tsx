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
  const [partnerName, setPartnerName] = useState("");
  const [cost, setCost] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [captureId, setCaptureId] = useState("");
  // Um requestId por emissão: reenvio após resposta perdida devolve o mesmo voucher, sem emitir outro.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const utils = trpc.useUtils();
  const list = trpc.vouchers.listByCustomer.useQuery({ customerId }, { enabled: customerId > 0 });
  // Ficha de captação que originou o brinde (tour, venda), para o custo ficar ligado a ela.
  const captures = trpc.vouchers.captureOptions.useQuery({ customerId }, { enabled: customerId > 0 && canIssue });
  // Fichas mais antigas que a primeira página, carregadas sob demanda.
  // Valem só para a primeira página de onde saíram; recarregada, as antigas são descartadas (sem buraco na fronteira).
  const [olderCaptureState, setOlderCaptures] = useState<{ base: number; captures: NonNullable<typeof captures.data>["captures"]; nextBeforeId: number | null } | null>(null);
  const olderCaptures = olderCaptureState?.base === captures.dataUpdatedAt ? olderCaptureState : null;
  const captureList = [...(captures.data?.captures ?? []), ...(olderCaptures?.captures ?? [])];
  const nextCaptureCursor = olderCaptures ? olderCaptures.nextBeforeId : captures.data?.nextBeforeId ?? null;
  const loadOlderCaptures = async () => {
    if (!nextCaptureCursor) return;
    const base = captures.dataUpdatedAt;
    const page = await utils.vouchers.captureOptions.fetch({ customerId, beforeId: nextCaptureCursor });
    setOlderCaptures(previous => ({ base, captures: [...(previous?.base === base ? previous.captures : []), ...page.captures], nextBeforeId: page.nextBeforeId }));
  };
  const refresh = () => void utils.vouchers.listByCustomer.invalidate({ customerId });
  const issue = trpc.vouchers.issue.useMutation({ onSuccess: r => { setRequestId(crypto.randomUUID()); setDescription(""); setPartnerName(""); setCost(""); setExpiresAt(""); setCaptureId(""); toast.success(`Voucher ${r.code} emitido.`); refresh(); }, onError: e => {
    toast.error(e.message);
    // CONFLICT: esta emissão já gerou um voucher (com outros dados). A lista recarrega para mostrá-lo, e o próximo envio
    // sai com requestId novo, como uma emissão nova.
    if (e.data?.code === "CONFLICT") { setRequestId(crypto.randomUUID()); refresh(); }
  } });
  const redeem = trpc.vouchers.redeem.useMutation({ onSuccess: () => { toast.success("Baixa registrada."); refresh(); }, onError: e => toast.error(e.message) });
  const cancel = trpc.vouchers.cancel.useMutation({ onSuccess: () => { toast.success("Voucher cancelado."); refresh(); }, onError: e => toast.error(e.message) });
  const submit = () => {
    if (description.trim().length < 3) return toast.error("Descreva o brinde.");
    const costAmount = cost.trim() ? Number(cost.replace(",", ".")) : 0;
    if (!Number.isFinite(costAmount) || costAmount < 0) return toast.error("Custo inválido.");
    issue.mutate({ customerId, description, partnerName: partnerName.trim() || undefined, costAmount, expiresAt: expiresAt || undefined, captureId: captureId ? Number(captureId) : undefined, requestId });
  };

  return <Card className="rounded-[1.35rem] border-[#e9e4da]">
    <CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Vouchers e brindes</CardTitle><p className="text-xs text-muted-foreground">O que foi prometido ao casal, quanto custa, até quando vale e se já foi usado.</p></CardHeader>
    <CardContent className="space-y-3">
      {canIssue && <div className="grid gap-2 sm:grid-cols-[1fr_120px_150px_auto]">
        <Input value={description} onChange={e => setDescription(e.target.value)} maxLength={255} placeholder="Brinde (ex.: jantar para 2)" className="h-9" />
        <Input value={cost} onChange={e => setCost(e.target.value)} inputMode="decimal" placeholder="Custo R$" className="h-9" />
        <Input value={expiresAt} onChange={e => setExpiresAt(e.target.value)} type="date" aria-label="Validade" className="h-9" />
        <Button size="sm" className="h-9" disabled={issue.isPending} onClick={submit}>{issue.isPending ? "Emitindo..." : "Emitir"}</Button>
        <Input value={partnerName} onChange={e => setPartnerName(e.target.value)} maxLength={120} placeholder="Parceiro que entrega (ex.: restaurante)" className="h-9 sm:col-span-2" />
        {captureList.length > 0 && <select value={captureId} onChange={e => setCaptureId(e.target.value)} aria-label="Ficha de captação" className="h-9 rounded-md border border-input bg-background px-2 text-sm sm:col-span-2">
          <option value="">Sem ficha de captação</option>
          {captureList.map(capture => <option key={capture.id} value={capture.id}>Ficha {capture.id} · {new Date(capture.scheduledAt ?? capture.createdAt).toLocaleDateString("pt-BR")}{capture.captureLocation ? ` · ${capture.captureLocation}` : ""}</option>)}
        </select>}
        {nextCaptureCursor && <Button size="sm" variant="outline" className="h-9" onClick={() => void loadOlderCaptures()}>Fichas mais antigas</Button>}
      </div>}
      {list.data?.truncated && <p className="text-xs text-amber-700">Mostrando {list.data.vouchers.length} de {list.data.total} vouchers: os {list.data.validCount} válidos e os mais recentes do histórico.</p>}
      {list.data?.vouchers.length === 0 && <p className="text-xs text-muted-foreground">Nenhum voucher emitido.</p>}
      {(list.data?.vouchers ?? []).map(voucher => <div key={voucher.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#faf8f3] p-3 text-sm">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">{voucher.code} · {money(voucher.costAmount)} · {dateLabel(voucher.expiresAt)}</p>
          <p className="break-words text-[#1d2b2a]">{voucher.description}{voucher.partnerName ? <span className="text-muted-foreground"> · {voucher.partnerName}</span> : null}</p>
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
