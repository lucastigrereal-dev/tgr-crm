import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader, money } from "@/components/crm/ui";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";

const rows = [["issued", "Válidos"], ["redeemed", "Usados"], ["expired", "Vencidos sem uso"], ["cancelled", "Cancelados"]] as const;

// Recepção: dar baixa no voucher pelo código e ver o custo dos brindes emitidos no período (TSE #31).
export default function Vouchers() {
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  // Vazio = o servidor usa o mês corrente até hoje no fuso do projeto e devolve as datas que usou.
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [last, setLast] = useState<{ customerId: number; description: string } | null>(null);
  const utils = trpc.useUtils();
  const summary = trpc.vouchers.summary.useQuery({ startDate: startDate || undefined, endDate: endDate || undefined }, { enabled: !(startDate && endDate && startDate > endDate) });
  const redeem = trpc.vouchers.redeem.useMutation({ onSuccess: r => { setLast(r); setCode(""); setNote(""); toast.success("Baixa registrada."); void utils.vouchers.summary.invalidate(); }, onError: e => {
    toast.error(e.message);
    // O erro pode vir de uma baixa anterior que já gravou (resposta perdida): o resumo recarrega para mostrar o estado real.
    void utils.vouchers.summary.invalidate();
  } });

  return <div className="space-y-6">
    <PageHeader eyebrow="Recepção" title="Vouchers e brindes" description="Dê baixa quando o casal apresentar o código e acompanhe quanto os brindes custaram no período." />
    <Card><CardContent className="space-y-3 pt-6">
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (code.trim()) redeem.mutate({ code, note: note.trim() || undefined }); }}>
        <Input className="h-9 w-48 uppercase" value={code} maxLength={32} onChange={e => setCode(e.target.value)} placeholder="Código do voucher" aria-label="Código do voucher" />
        <Input className="h-9 max-w-sm" value={note} maxLength={255} onChange={e => setNote(e.target.value)} placeholder="Observação (opcional)" />
        <Button size="sm" className="h-9" type="submit" disabled={redeem.isPending || !code.trim()}>{redeem.isPending ? "Registrando..." : "Dar baixa"}</Button>
      </form>
      {last && <p className="text-sm text-[#285043]">Usado: {last.description}. <Link href={`/clientes/${last.customerId}`} className="underline">Abrir ficha</Link></p>}
    </CardContent></Card>
    <Card><CardContent className="space-y-3 pt-6">
      <div className="flex flex-wrap items-center gap-2 text-sm"><span>Emitidos de</span><Input type="date" className="h-9 w-40" value={startDate || summary.data?.startDate || ""} onChange={e => { setStartDate(e.target.value); if (!endDate && summary.data) setEndDate(summary.data.endDate); }} aria-label="Início" /><span>a</span><Input type="date" className="h-9 w-40" value={endDate || summary.data?.endDate || ""} onChange={e => { setEndDate(e.target.value); if (!startDate && summary.data) setStartDate(summary.data.startDate); }} aria-label="Fim" /></div>
      {summary.data && <div className="grid gap-2 sm:grid-cols-5">
        {rows.map(([key, label]) => <div key={key} className="rounded-xl bg-[#faf8f3] p-3"><p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">{label}</p><p className="text-lg text-[#1d2b2a]">{summary.data[key].count}</p><p className="text-xs text-muted-foreground">{money(summary.data[key].cost)}</p></div>)}
        <div className="rounded-xl bg-[#1d2b2a] p-3 text-white"><p className="text-[10px] font-bold uppercase tracking-[.1em]">Total</p><p className="text-lg">{summary.data.total.count}</p><p className="text-xs">{money(summary.data.total.cost)}</p></div>
      </div>}
      {(summary.data?.partners.length ?? 0) > 0 && <div className="space-y-1 text-sm">
        <p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">Por parceiro</p>
        {summary.data!.partners.map(partner => <div key={partner.partnerName ?? ""} className="flex flex-wrap justify-between gap-2 border-b border-[#efe9dd] py-1"><span>{partner.partnerName ?? "Sem parceiro informado"}</span><span className="text-muted-foreground">{partner.count} emitido(s), {money(partner.cost)} · {partner.redeemedCount} usado(s), {money(partner.redeemedCost)}</span></div>)}
      </div>}
    </CardContent></Card>
  </div>;
}
