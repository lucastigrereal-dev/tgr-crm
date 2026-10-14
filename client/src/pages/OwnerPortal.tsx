import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useParams } from "wouter";

// Portal do Proprietário (TSE #19, escopo mínimo): página pública de leitura aberta pelo link que a equipe envia.
const money = (value: string | number) => Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const day = (value: string | Date | null) => value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
const contractStatus: Record<string, string> = { pending_signature: "Aguardando assinatura", active: "Ativo", overdue: "Em atraso", cancelled: "Cancelado", closed: "Encerrado" };
const usageModel: Record<string, string> = { fixed_week: "Semana fixa", flexible_week: "Semana flexível", points: "Pontos" };
const installmentStatus: Record<string, { label: string; tone: "default" | "secondary" | "destructive" | "outline" }> = {
  paid: { label: "Paga", tone: "secondary" }, open: { label: "Em aberto", tone: "outline" }, overdue: { label: "Vencida", tone: "destructive" },
  cancelled: { label: "Cancelada", tone: "secondary" }, renegotiated: { label: "Renegociada", tone: "secondary" },
};

async function copy(text: string, label: string) {
  try { await navigator.clipboard.writeText(text); toast.success(`${label} copiado.`); } catch { toast.error("Não deu para copiar. Selecione e copie manualmente."); }
}

export default function OwnerPortal() {
  const { token = "" } = useParams<{ token: string }>();
  const view = trpc.ownerPortal.view.useQuery({ token }, { retry: false, refetchOnWindowFocus: false });

  if (view.isLoading) return <main className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">Carregando seus dados…</main>;
  if (view.error || !view.data) {
    return <main className="mx-auto max-w-3xl p-6"><Card><CardContent className="py-10 text-center">
      <h1 className="text-lg font-semibold">Link indisponível</h1>
      <p className="mt-2 text-sm text-muted-foreground">Este link é inválido, expirou ou foi revogado. Peça um novo link à equipe de atendimento.</p>
    </CardContent></Card></main>;
  }

  const data = view.data;
  return <main className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
    <header>
      <h1 className="text-2xl font-semibold">Olá, {data.firstName}</h1>
      <p className="text-sm text-muted-foreground">Seus contratos e parcelas. Link válido até {new Date(data.expiresAt).toLocaleDateString("pt-BR")}.</p>
    </header>
    {data.contracts.length === 0 && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Nenhum contrato disponível por aqui ainda.</CardContent></Card>}
    {data.contracts.map(contract => <Card key={contract.id}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span>Contrato {contract.number}</span>
          <Badge variant={contract.status === "overdue" ? "destructive" : "outline"}>{contractStatus[contract.status] ?? contract.status}</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{usageModel[contract.usageModel] ?? contract.usageModel} · {money(contract.totalAmount)}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {contract.installments.length === 0 && <p className="text-sm text-muted-foreground">Sem parcelas lançadas.</p>}
        {contract.installments.map(installment => {
          const status = installmentStatus[installment.status] ?? { label: installment.status, tone: "outline" as const };
          return <div key={installment.id} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>Parcela {installment.sequence} · vence {day(installment.dueDate)}</span>
              <span className="flex items-center gap-2"><strong>{money(installment.amount)}</strong><Badge variant={status.tone}>{status.label}</Badge></span>
            </div>
            {installment.billing && <div className="mt-2 flex flex-wrap gap-2">
              {installment.billing.pixCopyPaste && <Button size="sm" variant="secondary" onClick={() => copy(installment.billing!.pixCopyPaste!, "PIX copia e cola")}>Copiar PIX</Button>}
              {installment.billing.digitableLine && <Button size="sm" variant="secondary" onClick={() => copy(installment.billing!.digitableLine!, "Linha digitável")}>Copiar linha digitável</Button>}
              {installment.billing.bankSlipUrl && <Button size="sm" variant="outline" asChild><a href={installment.billing.bankSlipUrl} target="_blank" rel="noopener noreferrer">2ª via do boleto</a></Button>}
              {installment.billing.invoiceUrl && <Button size="sm" variant="outline" asChild><a href={installment.billing.invoiceUrl} target="_blank" rel="noopener noreferrer">Ver cobrança</a></Button>}
            </div>}
          </div>;
        })}
      </CardContent>
    </Card>)}
    <p className="text-center text-xs text-muted-foreground">Dúvidas sobre valores ou contrato? Fale com a equipe de atendimento.</p>
  </main>;
}
