import { AlertTriangle, BrainCircuit, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const bandCopy = {
  healthy: { label: "Saudável", className: "bg-emerald-100 text-emerald-800", icon: CheckCircle2 },
  attention: { label: "Atenção", className: "bg-amber-100 text-amber-800", icon: Clock3 },
  critical: { label: "Crítico", className: "bg-rose-100 text-rose-800", icon: AlertTriangle },
} as const;

export default function Intelligence() {
  const health = trpc.intelligence.portfolioHealth.useQuery({ limit: 100 });
  const summary = health.data?.summary ?? { total: 0, healthy: 0, attention: 0, critical: 0 };

  return (
    <main id="conteudo-principal" className="min-h-screen bg-[#f7f5ef] p-5 md:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="tgr-data-label">Inteligência operacional</p>
            <h1 className="mt-2 flex items-center gap-3 font-serif text-3xl tracking-tight text-[#1d2b2a] md:text-4xl">
              <BrainCircuit className="h-8 w-8 text-[#a67c2e]" /> Saúde da carteira
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Uma leitura explicável do risco de cada contrato, baseada em estágio, recebimento, documentos, relacionamento, tarefas e distrato.</p>
          </div>
          <Button variant="outline" onClick={() => health.refetch()} disabled={health.isFetching} className="w-fit border-[#d9d1bf] bg-white">
            <RefreshCw className={`mr-2 h-4 w-4 ${health.isFetching ? "animate-spin" : ""}`} /> Atualizar leitura
          </Button>
        </header>

        {health.isError ? <Card className="border-rose-200 bg-rose-50"><CardContent className="p-5 text-sm text-rose-800">Não foi possível calcular a saúde da carteira. Tente novamente; se persistir, informe o request ID ao suporte.</CardContent></Card> : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label="Contratos analisados" value={summary.total} tone="neutral" />
          <SummaryCard label="Saudáveis" value={summary.healthy} tone="green" />
          <SummaryCard label="Em atenção" value={summary.attention} tone="amber" />
          <SummaryCard label="Críticos" value={summary.critical} tone="rose" />
        </section>

        <Card className="border-[#e3ddcf] bg-white shadow-sm">
          <CardHeader className="border-b border-[#eee9df] pb-4"><CardTitle className="font-serif text-xl text-[#1d2b2a]">Fila de ação por risco</CardTitle></CardHeader>
          <CardContent className="p-0">
            {health.isLoading ? <div className="flex items-center gap-2 p-6 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" /> Calculando fatos da carteira...</div> : null}
            {!health.isLoading && !health.data?.rows.length ? <div className="p-6 text-sm text-slate-500">Nenhum contrato disponível para análise.</div> : null}
            <div className="divide-y divide-[#eee9df]">
              {health.data?.rows.map(row => {
                const band = bandCopy[row.health.band];
                const Icon = band.icon;
                return <article key={row.contractId} className="flex flex-col gap-4 p-5 transition-colors hover:bg-[#fcfbf7] md:flex-row md:items-start md:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${band.className}`}><Icon className="h-4 w-4" /></div>
                    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-medium text-[#1d2b2a]">Contrato {row.contractNumber}</h2><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${band.className}`}>{band.label}</span></div><p className="mt-1 text-xs text-slate-500">Status {row.status} · score explicável de {row.health.score}/100</p><div className="mt-3 flex flex-wrap gap-2">{row.health.factors.filter(factor => factor.impact < 0).slice(0, 3).map(factor => <span key={factor.key} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{factor.label}: {factor.evidence}</span>)}</div></div>
                  </div>
                  <div className="max-w-md text-left md:text-right"><p className="text-xs font-semibold uppercase tracking-[.14em] text-[#a67c2e]">Próxima ação</p><p className="mt-1 text-sm leading-5 text-slate-600">{row.health.nextActions[0] ?? "Manter acompanhamento e registrar novos fatos."}</p></div>
                </article>;
              })}
            </div>
          </CardContent>
        </Card>
        <p className="text-xs text-slate-500">Esta leitura é assistência operacional. Ela não aprova desconto, distrato, pagamento ou comissão automaticamente.</p>
      </div>
    </main>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: "neutral" | "green" | "amber" | "rose" }) {
  const colors = { neutral: "text-[#1d2b2a]", green: "text-emerald-700", amber: "text-amber-700", rose: "text-rose-700" };
  return <Card className="border-[#e3ddcf] bg-white shadow-sm"><CardContent className="p-5"><p className="text-xs font-semibold uppercase tracking-[.14em] text-slate-500">{label}</p><p className={`mt-3 text-3xl font-semibold tabular-nums ${colors[tone]}`}>{value}</p></CardContent></Card>;
}
