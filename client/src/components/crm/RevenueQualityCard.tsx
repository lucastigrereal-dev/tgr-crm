import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function RevenueQualityCard({ contractId }: { contractId: number }) {
  const utils = trpc.useUtils();
  const quality = trpc.finance.revenueQuality.useQuery({ contractId }, { enabled: Boolean(contractId) });
  const sync = trpc.finance.syncRevenueQualityLedger.useMutation({ onSuccess: result => { utils.finance.revenueQuality.invalidate({ contractId }); toast.success(`${result.factCount} fato(s) econômicos sincronizados com trilha auditável.`); }, onError: error => toast.error(error.message) });
  const row = quality.data?.[0];
  if (quality.isLoading) return <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardContent className="p-5 text-sm text-muted-foreground">Lendo qualidade econômica do contrato…</CardContent></Card>;
  if (quality.isError || !row) return <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardContent className="p-5 text-sm text-muted-foreground">A visão econômica ainda não possui fatos suficientes para este contrato.</CardContent></Card>;
  const summary = row.summary;
  return <Card className="rounded-[1.35rem] border-[#dcd4c4]"><CardHeader><div className="flex items-start justify-between gap-3"><div className="flex items-start gap-3"><div className="rounded-full bg-[#efe4c5] p-2"><ShieldCheck className="h-5 w-5 text-[#71531a]" /></div><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#8a6b2d]">Verdade econômica</p><CardTitle className="font-serif text-xl text-[#1d2b2a]">Qualidade da receita</CardTitle><p className="mt-1 text-xs text-muted-foreground">Política derivada: {row.policyVersion}</p></div></div><Button variant="outline" size="sm" className="border-[#d9cfbd]" disabled={sync.isPending} onClick={() => sync.mutate({ contractId })}><RefreshCw className={`mr-2 h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`} />{sync.isPending ? "Sincronizando" : "Gravar trilha"}</Button></div></CardHeader><CardContent className="grid grid-cols-2 gap-3 text-sm"><Metric label="VGV formalizado" value={summary.vgvFormalized} /><Metric label="VGV líquido sobrevivente" value={summary.vgvLiquidRealized} accent="text-[#1d2b2a]" /><Metric label="Caixa confirmado" value={summary.cashConfirmed} accent="text-[#1d2b2a]" /><Metric label="Exposição aberta / inadimplência" value={summary.cashExposure} danger /><Metric label="Receita revertida" value={summary.vgvFormalized - summary.vgvLiquidRealized} danger /><Metric label="Multa / retenção de distrato" value={summary.cancellationRetention} /><Metric label="Comissão esperada" value={summary.commissionExpected} /><Metric label="Comissão em risco" value={summary.commissionAtRisk} danger /><Metric label="Comissão paga" value={summary.commissionPaid} /><Metric label="Comissão estornada" value={summary.commissionReversed} danger /><Metric label="Reembolso de distrato" value={summary.cancellationRefund} danger /></CardContent></Card>;
}

function Metric({ label, value, accent, danger }: { label: string; value: number; accent?: string; danger?: boolean }) {
  return <div className="rounded-xl bg-[#faf8f3] p-3"><p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 font-serif text-lg ${danger ? "text-[#9b3f32]" : accent || "text-[#285043]"}`}>{money(value)}</p></div>;
}
