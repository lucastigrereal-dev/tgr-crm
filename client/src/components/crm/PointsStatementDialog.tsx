import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

const entryLabel = { annual_credit: "Crédito anual", usage: "Uso", adjustment: "Ajuste", reversal: "Estorno", expiration: "Vencimento" } as const;

// Extrato de pontos do direito de uso (TSE #29): só inclusão; erro se corrige com estorno.
export function PointsStatementDialog({ entitlementId, label }: { entitlementId: number; label: string }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Lançar crédito e uso é do atendimento (admin e service); quem só consulta vê o extrato.
  const canPost = user?.role === "admin" || user?.role === "service";
  // Um requestId por lançamento manual, separado para uso e ajuste: reenvio após resposta perdida devolve o mesmo
  // lançamento, sem debitar de novo. Só o sucesso (ou o CONFLICT) daquela mesma operação troca a chave dela; crédito
  // anual e estorno não mexem nelas.
  const [usageRequestId, setUsageRequestId] = useState<string>(() => crypto.randomUUID());
  const [adjustRequestId, setAdjustRequestId] = useState<string>(() => crypto.randomUUID());
  const [open, setOpen] = useState(false);
  // Vazio = ano corrente do projeto, que vem do servidor (o navegador pode estar em outro fuso na virada do ano).
  const [year, setYear] = useState("");
  const [usagePoints, setUsagePoints] = useState("");
  const [reservationId, setReservationId] = useState("");
  const [note, setNote] = useState("");
  const utils = trpc.useUtils();
  const statement = trpc.pointsLedger.statement.useQuery({ entitlementId }, { enabled: open });
  // Páginas mais antigas carregadas sob demanda, para ver e estornar qualquer lançamento.
  type Page = NonNullable<typeof statement.data>;
  // As páginas antigas valem só para a primeira página de onde saíram: quando ela é recarregada (lançamento novo, foco na
  // janela, reabrir), as antigas são descartadas e voltam a ser buscadas a partir do cursor novo, sem buraco na fronteira.
  const [olderState, setOlder] = useState<{ base: number; pages: Page[] }>({ base: 0, pages: [] });
  const older = olderState.base === statement.dataUpdatedAt ? olderState.pages : [];
  const [loadingOlder, setLoadingOlder] = useState(false);
  const nextBeforeId = older.length ? older[older.length - 1]!.nextBeforeId : statement.data?.nextBeforeId ?? null;
  const entries = [...(statement.data?.entries ?? []), ...older.flatMap(page => page.entries)];
  const loadOlder = async () => {
    if (!nextBeforeId) return;
    setLoadingOlder(true);
    const base = statement.dataUpdatedAt;
    try { const page = await utils.pointsLedger.statement.fetch({ entitlementId, beforeId: nextBeforeId }); setOlder(current => ({ base, pages: [...(current.base === base ? current.pages : []), page] })); }
    catch (error) { toast.error((error as Error).message); }
    finally { setLoadingOlder(false); }
  };
  const done = (message: string) => { toast.success(message); void utils.pointsLedger.statement.invalidate({ entitlementId }); };
  const manualDone = (message: string, rotate: (id: string) => void) => { rotate(crypto.randomUUID()); setUsagePoints(""); setReservationId(""); setNote(""); done(message); };
  // Crédito anual e estorno têm chave natural (ano, lançamento): o erro pode vir de um pedido anterior que já gravou. O
  // extrato recarrega para mostrar o saldo e os botões como estão no banco.
  const onError = (error: { message: string }) => { toast.error(error.message); void utils.pointsLedger.statement.invalidate({ entitlementId }); };
  // CONFLICT num lançamento com requestId: o pedido já existe (ou foi recusado de vez). O extrato recarrega para mostrar o
  // que está gravado, e o próximo envio sai com requestId novo, como um lançamento novo e consciente.
  const onPostingError = (rotate: (id: string) => void) => (error: { message: string; data?: { code?: string } | null }) => {
    toast.error(error.message);
    if (error.data?.code === "CONFLICT") { rotate(crypto.randomUUID()); void utils.pointsLedger.statement.invalidate({ entitlementId }); }
  };
  const credit = trpc.pointsLedger.creditAnnual.useMutation({ onSuccess: () => done("Pontos do ano creditados."), onError });
  const usage = trpc.pointsLedger.recordUsage.useMutation({ onSuccess: () => manualDone("Uso lançado.", setUsageRequestId), onError: onPostingError(setUsageRequestId) });
  const adjust = trpc.pointsLedger.adjust.useMutation({ onSuccess: () => manualDone("Ajuste lançado.", setAdjustRequestId), onError: onPostingError(setAdjustRequestId) });
  const reverse = trpc.pointsLedger.reverse.useMutation({ onSuccess: () => done("Lançamento estornado."), onError });
  const busy = credit.isPending || usage.isPending || adjust.isPending || reverse.isPending;
  const points = Number(usagePoints);

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button size="sm" variant="outline" className="mt-2 h-7 text-xs">Extrato de pontos</Button></DialogTrigger>
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle className="font-serif text-2xl">Extrato de pontos · {label}</DialogTitle></DialogHeader>
      <p className="text-sm">Disponível: <strong>{statement.data?.available ?? "..."}</strong> ponto(s){statement.data ? ` · ${statement.data.entitlement.annualPoints} por ano · cada crédito vale ${statement.data.validityYears} anos (o do crédito e o seguinte); o uso consome primeiro o que vence antes` : ""}</p>
      {(statement.data?.pendingExpirations.length ?? 0) > 0 && <p className="text-xs text-amber-700">Vencidos: {statement.data!.pendingExpirations.map(item => `${item.points} de ${item.year}`).join(", ")}. A baixa no extrato acontece no próximo lançamento; o disponível já desconta.</p>}
      {statement.data?.truncated && <p className="text-xs text-amber-700">Mostrando {entries.length} de {statement.data.totalEntries} lançamentos, dos mais recentes para os antigos. O saldo considera todos.</p>}
      {canPost && <div className="grid gap-2 rounded-xl bg-[#faf8f3] p-3 text-sm">
        <div className="flex flex-wrap gap-2"><Input className="h-9 w-24" type="number" min="2000" max={statement.data?.currentYear} value={year || String(statement.data?.currentYear ?? "")} onChange={e => setYear(e.target.value)} aria-label="Ano" /><Button size="sm" className="h-9" disabled={busy || !statement.data} onClick={() => credit.mutate({ entitlementId, year: Number(year || statement.data?.currentYear) })}>Creditar pontos do ano</Button></div>
        <div className="flex flex-wrap gap-2">
          <Input className="h-9 w-28" type="number" value={usagePoints} onChange={e => setUsagePoints(e.target.value)} placeholder="Pontos" aria-label="Pontos" />
          <Input className="h-9 w-32" type="number" min="1" value={reservationId} onChange={e => setReservationId(e.target.value)} placeholder="Reserva nº" aria-label="Reserva" />
          <Input className="h-9 min-w-40 flex-1" value={note} maxLength={255} onChange={e => setNote(e.target.value)} placeholder="Observação ou motivo" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !(points > 0)} onClick={() => usage.mutate({ entitlementId, points, reservationId: reservationId ? Number(reservationId) : undefined, note: note.trim() || undefined, requestId: usageRequestId })}>Lançar uso</Button>
          {isAdmin && <Button size="sm" variant="outline" disabled={busy || !points} onClick={() => adjust.mutate({ entitlementId, points, note, requestId: adjustRequestId })}>Lançar ajuste (+/-)</Button>}
        </div>
      </div>}
      <div className="max-h-72 overflow-y-auto text-sm">
        {statement.data && entries.length === 0 && <p className="text-muted-foreground">Nenhum lançamento ainda.</p>}
        {entries.map(entry => <div key={entry.id} className="flex items-center justify-between gap-2 border-b border-[#f0ece4] py-2 last:border-b-0">
          <div><p className="font-semibold text-[#1d2b2a]">{entry.entryType === "expiration" && entry.points === 0 ? "Ano encerrado" : entryLabel[entry.entryType]}{entry.referenceYear ? ` ${entry.referenceYear}` : ""}{entry.expiresOn && !entry.reversed ? ` · vale até ${entry.expiresOn.split("-").reverse().join("/")}` : ""}{entry.reservationId ? ` · reserva ${entry.reservationId}` : ""}{entry.reversed ? " · estornado" : ""}</p><p className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleDateString("pt-BR")}{entry.note ? ` · ${entry.note}` : ""}</p></div>
          <div className="flex items-center gap-3 text-right"><div><p className={entry.points < 0 ? "text-[#8a3b2d]" : "text-[#285043]"}>{entry.points > 0 ? `+${entry.points}` : entry.points}</p><p className="text-xs text-muted-foreground">saldo {entry.balanceAfter}</p></div>
            {isAdmin && entry.entryType !== "reversal" && !entry.reversed && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const reason = window.prompt("Motivo do estorno:"); if (reason?.trim()) reverse.mutate({ entryId: entry.id, note: reason }); }}>Estornar</Button>}
          </div>
        </div>)}
        {nextBeforeId && <Button size="sm" variant="outline" className="mt-2 w-full" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Carregando..." : "Carregar lançamentos mais antigos"}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
