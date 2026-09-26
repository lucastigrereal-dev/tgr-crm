import { PageHeader } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Boxes, Clock3, LockKeyhole, RefreshCw, ShieldOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const statusLabels = { available: "Disponível", held: "Em hold", sold: "Vendida", blocked: "Bloqueada" } as const;
const statusTone = {
  available: "bg-emerald-50 text-emerald-800 border-emerald-200",
  held: "bg-amber-50 text-amber-800 border-amber-200",
  sold: "bg-sky-50 text-sky-800 border-sky-200",
  blocked: "bg-rose-50 text-rose-800 border-rose-200",
} as const;

export default function CommercialInventory() {
  const utils = trpc.useUtils();
  const resorts = trpc.operations.resorts.useQuery();
  const [resortId, setResortId] = useState("");
  const [status, setStatus] = useState<"all" | "available" | "held" | "sold" | "blocked">("all");
  const [search, setSearch] = useState("");
  const [fractionsPerUnit, setFractionsPerUnit] = useState("52");
  const [listPrice, setListPrice] = useState("");
  const [priceTableVersion, setPriceTableVersion] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState("30");

  const resortRows = resorts.data?.rows ?? [];
  useEffect(() => { if (!resortId && resortRows[0]) setResortId(String(resortRows[0].id)); }, [resortId, resortRows]);

  const selectedResortId = Number(resortId) || 0;
  const units = trpc.operations.units.useQuery({ resortId: selectedResortId || undefined }, { enabled: Boolean(selectedResortId) });
  const summary = trpc.inventory.summary.useQuery({ resortId: selectedResortId }, { enabled: Boolean(selectedResortId) });
  const list = trpc.inventory.list.useQuery({
    resortId: selectedResortId,
    status: status === "all" ? undefined : status,
    search: search.trim() || undefined,
    limit: 1000,
  }, { enabled: Boolean(selectedResortId) });

  const refresh = async () => {
    await Promise.all([
      utils.inventory.summary.invalidate(),
      utils.inventory.list.invalidate(),
    ]);
  };

  const bootstrap = trpc.inventory.bootstrap.useMutation({
    onSuccess: async data => {
      toast.success(`${data.created} cotas criadas. Estoque esperado: ${data.expectedTotal}.`);
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  const hold = trpc.inventory.createHold.useMutation({
    onSuccess: async data => {
      toast.success(data.reused ? `Hold #${data.holdId} reaproveitado.` : `Hold #${data.holdId} criado.`);
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  const block = trpc.inventory.block.useMutation({ onSuccess: refresh, onError: error => toast.error(error.message) });
  const unblock = trpc.inventory.unblock.useMutation({ onSuccess: refresh, onError: error => toast.error(error.message) });
  const sweep = trpc.inventory.sweepExpiredHolds.useMutation({
    onSuccess: async data => {
      toast.success(`${data.holds} holds expirados processados; ${data.fractions.length} cotas liberadas.`);
      await refresh();
    },
    onError: error => toast.error(error.message),
  });

  const selectedResort = resortRows.find(item => item.id === selectedResortId);
  const expected = useMemo(() => (units.data?.rows?.length ?? 0) * (Number(fractionsPerUnit) || 0), [units.data?.rows?.length, fractionsPerUnit]);
  const rows = list.data?.rows ?? [];

  const createHold = (fractionId: number) => {
    const parsedProposal = proposalId.trim() ? Number(proposalId) : null;
    if (proposalId.trim() && (!Number.isInteger(parsedProposal) || Number(parsedProposal) <= 0)) return toast.error("Informe um ID de proposta válido.");
    hold.mutate({ fractionId, proposalId: parsedProposal, ttlMinutes: Number(ttlMinutes) || 30 });
  };

  return <div className="space-y-6">
    <PageHeader eyebrow="TSE Cutover" title="Estoque comercial de cotas" description="A UH é física. A cota é vendável. Aqui o TGR separa as duas coisas e impede dupla venda." />

    <Card><CardContent className="grid gap-4 p-5 lg:grid-cols-[1.2fr_.8fr]">
      <div className="space-y-3">
        <p className="text-xs font-bold uppercase tracking-[.14em] text-[#b18f4b]">Empreendimento</p>
        <Select value={resortId} onValueChange={setResortId}><SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger><SelectContent>{resortRows.map(item => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}</SelectContent></Select>
        <div className="grid gap-2 sm:grid-cols-3"><Input type="number" min="1" max="104" value={fractionsPerUnit} onChange={event => setFractionsPerUnit(event.target.value)} placeholder="Cotas/UH" /><Input type="number" min="0" step="0.01" value={listPrice} onChange={event => setListPrice(event.target.value)} placeholder="Preço de tabela" /><Input value={priceTableVersion} onChange={event => setPriceTableVersion(event.target.value)} placeholder="Versão da tabela" /></div>
        <div className="flex flex-wrap gap-2"><Button disabled={!selectedResortId || bootstrap.isPending} onClick={() => bootstrap.mutate({ resortId: selectedResortId, fractionsPerUnit: Number(fractionsPerUnit) || 52, listPrice: listPrice ? Number(listPrice) : undefined, priceTableVersion: priceTableVersion || undefined })}><Boxes className="mr-2 h-4 w-4" />Materializar estoque</Button><Button variant="outline" disabled={sweep.isPending} onClick={() => sweep.mutate()}><RefreshCw className="mr-2 h-4 w-4" />Liberar holds expirados</Button></div>
        <p className="text-xs text-muted-foreground">{units.data?.rows?.length ?? 0} UHs carregadas × {Number(fractionsPerUnit) || 0} = {expected.toLocaleString("pt-BR")} cotas esperadas no desenho atual.</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
        {(["total","available","held","sold","blocked"] as const).map(key => <div key={key} className="rounded-2xl border border-[#e7e1d6] bg-[#faf8f3] p-4"><p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{key === "total" ? "Total" : statusLabels[key]}</p><p className="mt-1 font-serif text-3xl text-[#1d2b2a]">{summary.data?.[key] ?? 0}</p></div>)}
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4"><p className="text-[10px] font-bold uppercase tracking-[.12em] text-amber-700">Holds vencidos</p><p className="mt-1 font-serif text-3xl text-amber-900">{summary.data?.expiredHolds ?? 0}</p></div>
      </div>
    </CardContent></Card>

    <Card><CardContent className="space-y-4 p-5">
      <div className="grid gap-3 md:grid-cols-[1fr_180px_140px_120px]">
        <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar cota ou UH" />
        <Select value={status} onValueChange={value => setStatus(value as typeof status)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos status</SelectItem>{Object.entries(statusLabels).map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
        <Input value={proposalId} onChange={event => setProposalId(event.target.value)} inputMode="numeric" placeholder="ID proposta p/ hold" />
        <Input value={ttlMinutes} onChange={event => setTtlMinutes(event.target.value)} inputMode="numeric" placeholder="TTL min" />
      </div>

      {list.data?.truncated ? <p className="rounded-xl border border-[#ead8ad] bg-[#fff9e9] p-3 text-xs text-[#71531a]">Exibindo apenas o primeiro recorte do estoque. Refine o filtro para operar com segurança.</p> : null}

      <div className="overflow-x-auto rounded-2xl border border-[#e8e3d9]">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-[#f4f0e7] text-left text-[10px] font-bold uppercase tracking-[.12em] text-[#52615c]"><tr><th className="px-4 py-3">Cota</th><th className="px-4 py-3">UH</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Proposta</th><th className="px-4 py-3">Contrato</th><th className="px-4 py-3">Hold até</th><th className="px-4 py-3 text-right">Ação</th></tr></thead>
          <tbody>{rows.map(({ fraction, unitCode }) => <tr key={fraction.id} className="border-t border-[#eee9df] bg-white">
            <td className="px-4 py-3 font-semibold text-[#1d2b2a]">{fraction.code}</td>
            <td className="px-4 py-3">{unitCode}</td>
            <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone[fraction.status]}`}>{statusLabels[fraction.status]}</span>{fraction.blockedReason ? <p className="mt-1 max-w-52 text-xs text-rose-700">{fraction.blockedReason}</p> : null}</td>
            <td className="px-4 py-3">{fraction.currentProposalId ? `#${fraction.currentProposalId}` : "—"}</td>
            <td className="px-4 py-3">{fraction.currentContractId ? `#${fraction.currentContractId}` : "—"}</td>
            <td className="px-4 py-3">{fraction.heldUntil ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(fraction.heldUntil)) : "—"}</td>
            <td className="px-4 py-3"><div className="flex justify-end gap-2">
              {fraction.status === "available" ? <Button size="sm" variant="outline" disabled={hold.isPending} onClick={() => createHold(fraction.id)}><Clock3 className="mr-1.5 h-3.5 w-3.5" />Hold</Button> : null}
              {fraction.status === "available" ? <Button size="sm" variant="outline" disabled={block.isPending} onClick={() => { const reason = window.prompt("Motivo do bloqueio desta cota?"); if (reason?.trim()) block.mutate({ fractionId: fraction.id, reason: reason.trim() }); }}><LockKeyhole className="mr-1.5 h-3.5 w-3.5" />Bloquear</Button> : null}
              {fraction.status === "blocked" ? <Button size="sm" variant="outline" disabled={unblock.isPending} onClick={() => unblock.mutate({ fractionId: fraction.id })}><ShieldOff className="mr-1.5 h-3.5 w-3.5" />Desbloquear</Button> : null}
            </div></td>
          </tr>)}</tbody>
        </table>
        {!rows.length ? <div className="p-8 text-center text-sm text-muted-foreground">{selectedResort ? "Nenhuma cota neste filtro." : "Selecione um empreendimento."}</div> : null}
      </div>
    </CardContent></Card>
  </div>;
}
