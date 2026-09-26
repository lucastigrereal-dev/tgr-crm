import { PageHeader } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Calculator, Plus, RefreshCw } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const today = () => new Date().toISOString().slice(0, 10);
const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);

export default function MonetaryAdjustments() {
  const utils = trpc.useUtils();
  const resorts = trpc.operations.resorts.useQuery();
  const contracts = trpc.contracts.list.useQuery({ limit: 500 });
  const [resortId, setResortId] = useState("");
  const [contractId, setContractId] = useState("");
  const [policyVersionId, setPolicyVersionId] = useState("");
  const [throughDate, setThroughDate] = useState(today());
  const [indexCode, setIndexCode] = useState("INCC");

  const resortRows = resorts.data?.rows ?? [];
  useEffect(() => { if (!resortId && resortRows[0]) setResortId(String(resortRows[0].id)); }, [resortId, resortRows]);

  const policies = trpc.commercialPolicies.list.useQuery(
    { resortId: Number(resortId) || 1, policyType: "monetary_adjustment", includeRetired: false, limit: 100 },
    { enabled: Boolean(resortId) },
  );
  const policyRows = policies.data ?? [];
  useEffect(() => { if (policyRows.length && !policyRows.some(item => String(item.id) === policyVersionId)) setPolicyVersionId(String(policyRows[0].id)); }, [policyRows, policyVersionId]);

  const canSimulate = Boolean(contractId && policyVersionId && throughDate);
  const simulation = trpc.monetaryAdjustments.simulate.useQuery(
    { contractId: Number(contractId) || 1, policyVersionId: Number(policyVersionId) || 1, throughDate },
    { enabled: canSimulate, retry: false },
  );
  const history = trpc.monetaryAdjustments.history.useQuery(
    { contractId: Number(contractId) || 1, limit: 20 },
    { enabled: Boolean(contractId) },
  );

  const selectedPolicy = policyRows.find(item => String(item.id) === policyVersionId);
  const selectedPolicyJson = useMemo(() => {
    try { return selectedPolicy ? JSON.parse(selectedPolicy.policyJson) as Record<string, unknown> : null; } catch { return null; }
  }, [selectedPolicy]);

  useEffect(() => {
    if (typeof selectedPolicyJson?.indexCode === "string") setIndexCode(String(selectedPolicyJson.indexCode));
  }, [selectedPolicyJson]);

  const createPolicy = trpc.commercialPolicies.create.useMutation({
    onSuccess: async () => { toast.success("Política de reajuste versionada."); await utils.commercialPolicies.list.invalidate(); },
    onError: error => toast.error(error.message),
  });
  const upsertIndex = trpc.monetaryAdjustments.upsertIndexValue.useMutation({
    onSuccess: async () => { toast.success("Valor do índice registrado."); await utils.monetaryAdjustments.indexValues.invalidate(); await simulation.refetch(); },
    onError: error => toast.error(error.message),
  });
  const apply = trpc.monetaryAdjustments.apply.useMutation({
    onSuccess: async data => {
      toast.success(`Reajuste #${data.adjustmentId} aplicado com memória de cálculo.`);
      await Promise.all([simulation.refetch(), history.refetch(), utils.customers.installments.invalidate(), utils.finance.installments.invalidate()]);
    },
    onError: error => toast.error(error.message),
  });

  const submitPolicy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resortId) return toast.error("Selecione o empreendimento.");
    const data = new FormData(event.currentTarget);
    createPolicy.mutate({
      resortId: Number(resortId),
      policyType: "monetary_adjustment",
      version: String(data.get("version") ?? ""),
      policy: {
        indexCode: String(data.get("indexCode") ?? "").toUpperCase(),
        periodicityMonths: Number(data.get("periodicityMonths") ?? 1),
        spreadMonthlyPercent: Number(data.get("spreadMonthlyPercent") ?? 0),
        applyTo: "open_installments",
        description: String(data.get("description") ?? ""),
      },
    });
  };

  const submitIndex = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    upsertIndex.mutate({
      indexCode: String(data.get("indexCode") ?? "").toUpperCase(),
      referenceDate: String(data.get("referenceDate") ?? ""),
      variationPercent: Number(data.get("variationPercent") ?? 0),
      source: String(data.get("source") ?? ""),
      sourceReference: String(data.get("sourceReference") ?? "") || null,
    });
  };

  const calc = simulation.data?.calculation;
  return <div className="space-y-6">
    <PageHeader eyebrow="Receita" title="Reajuste monetário" description="Simule antes, aplique depois. Cada centavo reajustado fica reproduzível por política, índice, período e memória de cálculo." />

    <div className="grid gap-5 xl:grid-cols-2">
      <Card><CardContent className="space-y-4 p-5">
        <div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#b18f4b]">1. Política versionada</p><p className="mt-1 text-sm text-muted-foreground">Nada de INCC ou IGP-M escondido em código.</p></div>
        <Select value={resortId} onValueChange={setResortId}><SelectTrigger><SelectValue placeholder="Empreendimento" /></SelectTrigger><SelectContent>{resortRows.map(item => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}</SelectContent></Select>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submitPolicy}>
          <Input name="version" required placeholder="Versão: NATAL-PRE-01" />
          <Input name="indexCode" required defaultValue="INCC" placeholder="Índice" />
          <div><Label>Periodicidade (meses)</Label><Input name="periodicityMonths" type="number" min="1" max="24" defaultValue="6" /></div>
          <div><Label>Adicional mensal (%)</Label><Input name="spreadMonthlyPercent" type="number" min="0" max="10" step="0.01" defaultValue="0" /></div>
          <Input className="sm:col-span-2" name="description" placeholder="Ex.: pré-entrega, semestral" />
          <Button className="sm:col-span-2" disabled={createPolicy.isPending}><Plus className="mr-2 h-4 w-4" />Criar versão</Button>
        </form>
      </CardContent></Card>

      <Card><CardContent className="space-y-4 p-5">
        <div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#b18f4b]">2. Série do índice</p><p className="mt-1 text-sm text-muted-foreground">A fonte entra junto com o número. Sem taxa órfã.</p></div>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submitIndex}>
          <Input name="indexCode" value={indexCode} onChange={event => setIndexCode(event.target.value.toUpperCase())} required />
          <Input name="referenceDate" type="date" required />
          <div><Label>Variação do mês (%)</Label><Input name="variationPercent" type="number" step="0.000001" required /></div>
          <Input name="source" required placeholder="Fonte oficial / responsável" />
          <Input className="sm:col-span-2" name="sourceReference" placeholder="Referência, URL, boletim ou documento" />
          <Button variant="outline" className="sm:col-span-2" disabled={upsertIndex.isPending}><RefreshCw className="mr-2 h-4 w-4" />Registrar índice</Button>
        </form>
      </CardContent></Card>
    </div>

    <Card><CardContent className="space-y-5 p-5">
      <div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#b18f4b]">3. Simular e aplicar</p><p className="mt-1 text-sm text-muted-foreground">A aplicação mexe somente em parcelas abertas ou vencidas e grava a fotografia antes/depois.</p></div>
      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_200px_auto]">
        <Select value={contractId} onValueChange={setContractId}><SelectTrigger><SelectValue placeholder="Contrato" /></SelectTrigger><SelectContent>{contracts.data?.rows?.map(({ contract, customerName }) => <SelectItem key={contract.id} value={String(contract.id)}>{contract.number} · {customerName}</SelectItem>)}</SelectContent></Select>
        <Select value={policyVersionId} onValueChange={setPolicyVersionId}><SelectTrigger><SelectValue placeholder="Política de reajuste" /></SelectTrigger><SelectContent>{policyRows.map(item => <SelectItem key={item.id} value={String(item.id)}>{item.version}</SelectItem>)}</SelectContent></Select>
        <Input type="date" value={throughDate} onChange={event => setThroughDate(event.target.value)} />
        <Button variant="outline" disabled={!canSimulate || simulation.isFetching} onClick={() => simulation.refetch()}><Calculator className="mr-2 h-4 w-4" />Simular</Button>
      </div>

      {simulation.error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{simulation.error.message}</p> : null}
      {calc ? calc.eligible ? <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Base" value={simulation.data?.baseDate ?? "—"} />
          <Metric label="Até" value={simulation.data?.throughDate ?? "—"} />
          <Metric label="Índice" value={calc.indexCode} />
          <Metric label="Fator total" value={calc.totalFactor.toFixed(6)} />
          <Metric label="Antes" value={money(calc.beforeTotal)} />
          <Metric label="Depois" value={money(calc.afterTotal)} />
        </div>
        <div className="overflow-x-auto rounded-2xl border border-[#e8e3d9]"><table className="w-full min-w-[720px] text-sm"><thead className="bg-[#f4f0e7] text-left text-[10px] font-bold uppercase tracking-[.12em] text-[#52615c]"><tr><th className="px-4 py-3">Parcela</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Antes</th><th className="px-4 py-3">Depois</th><th className="px-4 py-3">Delta</th></tr></thead><tbody>{calc.installments.map(item => <tr key={item.id} className="border-t border-[#eee9df]"><td className="px-4 py-3">#{item.sequence}</td><td className="px-4 py-3">{item.status}</td><td className="px-4 py-3">{money(item.before)}</td><td className="px-4 py-3 font-semibold">{money(item.after)}</td><td className="px-4 py-3">{money(item.delta)}</td></tr>)}</tbody></table></div>
        <Button disabled={apply.isPending} onClick={() => {
          if (!window.confirm(`Aplicar o reajuste revisado de ${money(calc.beforeTotal)} para ${money(calc.afterTotal)}? Esta ação altera parcelas abertas e grava ledger.`)) return;
          apply.mutate({ contractId: Number(contractId), policyVersionId: Number(policyVersionId), throughDate, confirmation: "APPLY_REVIEWED_ADJUSTMENT" });
        }}>Aplicar reajuste revisado</Button>
      </div> : <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Periodicidade ainda não atingida: {calc.elapsedMonths}/{calc.requiredMonths} meses.</p> : null}
    </CardContent></Card>

    {history.data?.length ? <Card><CardContent className="p-5"><p className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-[#b18f4b]">Memórias aplicadas</p><div className="space-y-2">{history.data.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e8e3d9] bg-white p-3 text-sm"><span>#{item.id} · {item.indexCode} · {String(item.baseDate).slice(0,10)} → {String(item.throughDate).slice(0,10)}</span><strong>{money(Number(item.beforeTotal))} → {money(Number(item.afterTotal))}</strong></div>)}</div></CardContent></Card> : null}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-[#e8e3d9] bg-[#faf8f3] p-3"><p className="text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold text-[#1d2b2a]">{value}</p></div>;
}
