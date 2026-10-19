import { EmptyState, StatusPill, dateLabel, money } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const statusLabel = { draft: "Rascunho", approved: "Aprovado", applied: "Aplicado", rejected: "Rejeitado", cancelled: "Cancelado" } as const;

/** CRM-A11: acordos de parcela com as ações do fluxo (aprovar, aplicar, cancelar). Quem propôs não aprova: o servidor decide e devolve `canApprove`. */
export function RenegotiationsPanel() {
  const utils = trpc.useUtils();
  const list = trpc.finance.listRenegotiations.useQuery();
  const done = (message: string) => { utils.finance.listRenegotiations.invalidate(); utils.finance.installments.invalidate(); toast.success(message); };
  const approve = trpc.finance.approveRenegotiation.useMutation({ onSuccess: () => done("Acordo aprovado."), onError: error => toast.error(error.message) });
  const apply = trpc.finance.applyRenegotiation.useMutation({ onSuccess: () => done("Acordo aplicado: nova parcela criada."), onError: error => toast.error(error.message) });
  const cancel = trpc.finance.cancelRenegotiation.useMutation({ onSuccess: () => done("Acordo encerrado."), onError: error => toast.error(error.message) });
  const rows = list.data?.rows ?? [];
  const busy = approve.isPending || apply.isPending || cancel.isPending;
  return <section className="space-y-3 rounded-[1.35rem] border border-[#e9e4da] bg-white p-4 sm:p-5" data-testid="renegotiations-panel">
    <div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b18f4b]">Acordos de parcela</p><h2 className="mt-1 font-serif text-xl text-[#1d2b2a]">Renegociações</h2></div>
    {!rows.length ? <EmptyState title="Nenhum acordo" body="Propose um acordo na parcela para ele aparecer aqui." /> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
      <thead className="text-left text-[10px] font-bold uppercase tracking-[.12em] text-[#52615c]"><tr><th className="px-3 py-2">Contrato</th><th className="px-3 py-2">Parcela</th><th className="px-3 py-2">Saldo</th><th className="px-3 py-2">Acordo</th><th className="px-3 py-2">Novo vencimento</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Ações</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} className="border-t border-[#eee9df]" data-testid={`renegotiation-${row.id}`}>
        <td className="px-3 py-2"><p className="font-semibold">{row.contractNumber}</p><p className="text-xs text-muted-foreground">{row.customerName}</p></td>
        <td className="px-3 py-2">#{row.installmentSequence}</td>
        <td className="px-3 py-2">{money(Number(row.originalAmount))}</td>
        <td className="px-3 py-2">{money(Number(row.proposedAmount))}</td>
        <td className="px-3 py-2">{dateLabel(row.proposedDueDate)}</td>
        <td className="px-3 py-2"><StatusPill value={statusLabel[row.status]} /></td>
        <td className="px-3 py-2"><div className="flex justify-end gap-2">
          {row.status === "draft" ? <Button size="sm" variant="outline" disabled={busy || !row.canApprove} title={row.canApprove ? undefined : "Quem propôs o acordo não pode aprová-lo."} onClick={() => approve.mutate({ id: row.id })}>Aprovar</Button> : null}
          {row.status === "approved" ? <Button size="sm" disabled={busy} onClick={() => apply.mutate({ id: row.id })}>Aplicar</Button> : null}
          {row.status === "draft" || row.status === "approved" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm("Encerrar este acordo sem aplicar?")) cancel.mutate({ id: row.id }); }}>Cancelar</Button> : null}
        </div></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
