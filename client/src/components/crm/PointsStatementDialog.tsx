import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

const entryLabel = { annual_credit: "Crédito anual", usage: "Uso", adjustment: "Ajuste", reversal: "Estorno" } as const;

// Extrato de pontos do direito de uso (TSE #29): só inclusão; erro se corrige com estorno.
export function PointsStatementDialog({ entitlementId, label }: { entitlementId: number; label: string }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Lançar crédito e uso é do atendimento (admin e service); quem só consulta vê o extrato.
  const canPost = user?.role === "admin" || user?.role === "service";
  // Um requestId por lançamento: reenvio após resposta perdida devolve o mesmo lançamento, sem debitar de novo.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
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
  const [older, setOlder] = useState<Page[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const nextBeforeId = older.length ? older[older.length - 1]!.nextBeforeId : statement.data?.nextBeforeId ?? null;
  const entries = [...(statement.data?.entries ?? []), ...older.flatMap(page => page.entries)];
  const loadOlder = async () => {
    if (!nextBeforeId) return;
    setLoadingOlder(true);
    try { const page = await utils.pointsLedger.statement.fetch({ entitlementId, beforeId: nextBeforeId }); setOlder(pages => [...pages, page]); }
    catch (error) { toast.error((error as Error).message); }
    finally { setLoadingOlder(false); }
  };
  const done = (message: string) => { toast.success(message); setRequestId(crypto.randomUUID()); setUsagePoints(""); setReservationId(""); setNote(""); setOlder([]); void utils.pointsLedger.statement.invalidate({ entitlementId }); };
  const onError = (error: { message: string }) => toast.error(error.message);
  const credit = trpc.pointsLedger.creditAnnual.useMutation({ onSuccess: () => done("Pontos do ano creditados."), onError });
  const usage = trpc.pointsLedger.recordUsage.useMutation({ onSuccess: () => done("Uso lançado."), onError });
  const adjust = trpc.pointsLedger.adjust.useMutation({ onSuccess: () => done("Ajuste lançado."), onError });
  const reverse = trpc.pointsLedger.reverse.useMutation({ onSuccess: () => done("Lançamento estornado."), onError });
  const busy = credit.isPending || usage.isPending || adjust.isPending || reverse.isPending;
  const points = Number(usagePoints);

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button size="sm" variant="outline" className="mt-2 h-7 text-xs">Extrato de pontos</Button></DialogTrigger>
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle className="font-serif text-2xl">Extrato de pontos · {label}</DialogTitle></DialogHeader>
      <p className="text-sm">Saldo: <strong>{statement.data?.balance ?? "..."}</strong> ponto(s){statement.data ? ` · ${statement.data.entitlement.annualPoints} por ano` : ""}</p>
      {statement.data?.truncated && <p className="text-xs text-amber-700">Mostrando {entries.length} de {statement.data.totalEntries} lançamentos, dos mais recentes para os antigos. O saldo considera todos.</p>}
      {canPost && <div className="grid gap-2 rounded-xl bg-[#faf8f3] p-3 text-sm">
        <div className="flex flex-wrap gap-2"><Input className="h-9 w-24" type="number" min="2000" max={statement.data?.currentYear} value={year || String(statement.data?.currentYear ?? "")} onChange={e => setYear(e.target.value)} aria-label="Ano" /><Button size="sm" className="h-9" disabled={busy || !statement.data} onClick={() => credit.mutate({ entitlementId, year: Number(year || statement.data?.currentYear) })}>Creditar pontos do ano</Button></div>
        <div className="flex flex-wrap gap-2">
          <Input className="h-9 w-28" type="number" value={usagePoints} onChange={e => setUsagePoints(e.target.value)} placeholder="Pontos" aria-label="Pontos" />
          <Input className="h-9 w-32" type="number" min="1" value={reservationId} onChange={e => setReservationId(e.target.value)} placeholder="Reserva nº" aria-label="Reserva" />
          <Input className="h-9 min-w-40 flex-1" value={note} maxLength={255} onChange={e => setNote(e.target.value)} placeholder="Observação ou motivo" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !(points > 0)} onClick={() => usage.mutate({ entitlementId, points, reservationId: reservationId ? Number(reservationId) : undefined, note: note.trim() || undefined, requestId })}>Lançar uso</Button>
          {isAdmin && <Button size="sm" variant="outline" disabled={busy || !points} onClick={() => adjust.mutate({ entitlementId, points, note, requestId })}>Lançar ajuste (+/-)</Button>}
        </div>
      </div>}
      <div className="max-h-72 overflow-y-auto text-sm">
        {statement.data && entries.length === 0 && <p className="text-muted-foreground">Nenhum lançamento ainda.</p>}
        {entries.map(entry => <div key={entry.id} className="flex items-center justify-between gap-2 border-b border-[#f0ece4] py-2 last:border-b-0">
          <div><p className="font-semibold text-[#1d2b2a]">{entryLabel[entry.entryType]}{entry.referenceYear ? ` ${entry.referenceYear}` : ""}{entry.reservationId ? ` · reserva ${entry.reservationId}` : ""}{entry.reversed ? " · estornado" : ""}</p><p className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleDateString("pt-BR")}{entry.note ? ` · ${entry.note}` : ""}</p></div>
          <div className="flex items-center gap-3 text-right"><div><p className={entry.points < 0 ? "text-[#8a3b2d]" : "text-[#285043]"}>{entry.points > 0 ? `+${entry.points}` : entry.points}</p><p className="text-xs text-muted-foreground">saldo {entry.balanceAfter}</p></div>
            {isAdmin && entry.entryType !== "reversal" && !entry.reversed && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const reason = window.prompt("Motivo do estorno:"); if (reason?.trim()) reverse.mutate({ entryId: entry.id, note: reason }); }}>Estornar</Button>}
          </div>
        </div>)}
        {nextBeforeId && <Button size="sm" variant="outline" className="mt-2 w-full" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Carregando..." : "Carregar lançamentos mais antigos"}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
