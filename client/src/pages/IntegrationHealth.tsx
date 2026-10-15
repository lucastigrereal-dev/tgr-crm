import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/crm/ui";
import { trpc } from "@/lib/trpc";

const dateTime = (value: Date | string | null) => value ? new Date(value).toLocaleString("pt-BR") : "—";

// Painel de falhas das integrações (TSE #34): o que cada ponte entregou, o que foi recusado de vez e o que está parado.
export default function IntegrationHealth() {
  const health = trpc.integrations.health.useQuery(undefined, { refetchInterval: 30_000 });
  const data = health.data;

  return <div className="space-y-6">
    <PageHeader eyebrow="Admin" title="Integrações" description="Cada ponte do CRM com os outros sistemas da TGR. Pendente é evento ainda sem recibo: a ponte tenta de novo sozinha, com espera crescente. Recusado é o que o outro sistema rejeitou de vez e precisa de decisão." action={<Button size="sm" variant="outline" disabled={health.isFetching} onClick={() => void health.refetch()}>{health.isFetching ? "Atualizando..." : "Atualizar"}</Button>} />
    {health.isError && <p className="text-sm text-[#8a3b2d]">Não foi possível carregar o painel: {health.error.message}</p>}
    {data && <>
      <div className="grid gap-3 lg:grid-cols-3">
        {data.bridges.map(bridge => {
          const problem = bridge.rejected > 0 || bridge.stuck > 0;
          return <Card key={bridge.key} className="rounded-xl"><CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold text-[#1d2b2a]">{bridge.label}</p>
              {!bridge.configured ? <Badge variant="outline">Desligada</Badge> : problem ? <Badge variant="destructive">Precisa de atenção</Badge> : <Badge variant="secondary">Em dia</Badge>}
            </div>
            {!bridge.configured && <p className="text-xs text-muted-foreground">Sem endereço ou chave configurados neste ambiente: a ponte não envia, e os pendentes abaixo vão acumular.</p>}
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg bg-[#faf8f3] p-2"><dt className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">Entregues</dt><dd className="text-lg">{bridge.delivered}</dd></div>
              <div className="rounded-lg bg-[#faf8f3] p-2"><dt className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">Não se aplica</dt><dd className="text-lg">{bridge.notApplicable}</dd></div>
              <div className="rounded-lg bg-[#faf8f3] p-2"><dt className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">Recusados</dt><dd className={bridge.rejected ? "text-lg text-[#8a3b2d]" : "text-lg"}>{bridge.rejected}</dd></div>
              <div className="rounded-lg bg-[#faf8f3] p-2"><dt className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">Pendentes</dt><dd className="text-lg">{bridge.pending}</dd></div>
            </dl>
            {bridge.stuck > 0 && <p className="text-xs text-amber-700">{bridge.stuck} pendente(s) há mais de {data.stuckAfterMinutes} minutos; o mais antigo é de {dateTime(bridge.oldestPendingAt)}.</p>}
            <p className="text-[11px] text-muted-foreground">Pendentes: últimos {data.windowDays} dias.</p>
          </CardContent></Card>;
        })}
      </div>
      <Card className="rounded-xl"><CardContent className="space-y-3 pt-6">
        <p className="font-semibold text-[#1d2b2a]">Recusados mais recentes</p>
        {data.rejected.length === 0 && <p className="text-sm text-muted-foreground">Nenhum evento recusado.</p>}
        {data.rejected.map(row => <div key={row.id} className="border-b border-[#f0ece4] pb-2 text-sm last:border-b-0">
          <p><strong>{row.bridge}</strong> · {row.entityType} {row.entityId} · <span className="text-muted-foreground">{dateTime(row.createdAt)}</span></p>
          <p className="text-xs text-muted-foreground">{row.summary ?? "Sem detalhe."}</p>
        </div>)}
        {data.rejected.length > 0 && <p className="text-xs text-muted-foreground">Reprocessar um recusado hoje é manual, pelo roteiro do piloto: o recibo é apagado do banco por quem tem acesso a ele. Depois de apagado, o reenvio só acontece quando o servidor reinicia (eventos com mais de 15 minutos não voltam sozinhos).</p>}
      </CardContent></Card>
    </>}
  </div>;
}
