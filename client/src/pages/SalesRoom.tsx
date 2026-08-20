import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader } from "@/components/crm/ui";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "../../../server/routers";
import type { inferRouterOutputs } from "@trpc/server";
import { Armchair, CalendarDays, CheckCircle2, Clock3, DoorOpen, Play, RefreshCw, Square, UserRoundCheck, UserX, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const statusCopy = {
  scheduled: { label: "Na fila", tone: "bg-[#e6eef5] text-[#315d7e]" },
  checked_in: { label: "Chegou", tone: "bg-[#e5efe4] text-[#285043]" },
  presented: { label: "Em apresentação", tone: "bg-[#ece8f6] text-[#5c477b]" },
} as const;

type RouterOutput = inferRouterOutputs<AppRouter>;
type QueueItem = RouterOutput["captures"]["receptionQueue"][number];

function todayLocal() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function minuteLabel(minutes: number) {
  if (minutes <= 0) return "agora";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}min` : `${minutes} min`;
}

function personName(id: number | null, sellers: Array<{ id: number; name: string | null }>) {
  return sellers.find(seller => seller.id === id)?.name ?? "Não atribuído";
}

export default function SalesRoom() {
  const utils = trpc.useUtils();
  const [date, setDate] = useState(todayLocal);
  const [now, setNow] = useState(() => new Date());
  const [tableDraft, setTableDraft] = useState<Record<number, string>>({});
  const [linerDraft, setLinerDraft] = useState<Record<number, string>>({});
  const [closerDraft, setCloserDraft] = useState<Record<number, string>>({});
  const [noTourOpen, setNoTourOpen] = useState<number | null>(null);
  const [noTourReason, setNoTourReason] = useState("");
  const queue = trpc.captures.receptionQueue.useQuery({ date }, { refetchInterval: 5_000 });
  const selectors = trpc.captures.selectors.useQuery();
  const sellers = selectors.data?.sellers ?? [];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = () => {
    utils.captures.receptionQueue.invalidate();
    utils.captures.list.invalidate();
  };
  const checkIn = trpc.captures.checkIn.useMutation({ onSuccess: () => { toast.success("Chegada registrada. Agora a recepção manda o casal para a mesa."); refresh(); }, onError: error => toast.error(error.message) });
  const assignRoom = trpc.captures.assignRoom.useMutation({ onSuccess: () => { toast.success("Mesa e time atribuídos."); refresh(); }, onError: error => toast.error(error.message) });
  const startPresentation = trpc.captures.startPresentation.useMutation({ onSuccess: () => { toast.success("Tour iniciado. O cronômetro está rodando."); refresh(); }, onError: error => toast.error(error.message) });
  const endPresentation = trpc.captures.endPresentation.useMutation({ onSuccess: result => { toast.success(`Apresentação encerrada: ${result.durationMinutes} minutos registrados.`); refresh(); }, onError: error => toast.error(error.message) });
  const markNoTour = trpc.captures.markNoTour.useMutation({ onSuccess: () => { toast.success("Sem-tour registrado com motivo e trilha de auditoria."); setNoTourOpen(null); setNoTourReason(""); refresh(); }, onError: error => toast.error(error.message) });

  const stages = useMemo(() => ({
    scheduled: queue.data?.filter(item => item.capture.presentationStatus === "scheduled") ?? [],
    checked_in: queue.data?.filter(item => item.capture.presentationStatus === "checked_in") ?? [],
    presented: queue.data?.filter(item => item.capture.presentationStatus === "presented") ?? [],
  }), [queue.data]);
  const inProgress = stages.presented.filter(item => !item.capture.presentationEndedAt);

  const assign = (item: QueueItem) => {
    const salesTable = tableDraft[item.capture.id] ?? item.capture.salesTable ?? "";
    if (!salesTable.trim()) { toast.error("Informe a mesa antes de entregar o casal para a sala."); return; }
    assignRoom.mutate({ id: item.capture.id, salesTable, linerId: linerDraft[item.capture.id] ? Number(linerDraft[item.capture.id]) : item.capture.linerId, closerId: closerDraft[item.capture.id] ? Number(closerDraft[item.capture.id]) : item.capture.closerId });
  };

  return <div className="space-y-7">
    <PageHeader eyebrow="Ritmo da operação" title="Sala de vendas" description="A recepção enxerga a fila do dia, confirma chegada, entrega mesa e equipe, mede o tour e registra sem-tour sem deixar buraco na história." />

    <div className="grid gap-4 lg:grid-cols-[1.2fr_repeat(3,minmax(0,1fr))]">
      <Card className="border-[#e8e1d4] bg-[#1d2b2a] text-white"><CardContent className="flex min-h-[146px] flex-col justify-between p-5"><DoorOpen className="h-5 w-5 text-[#e8d092]" /><div><p className="text-xs font-bold uppercase tracking-[.14em] text-white/55">Fila do dia</p><p className="mt-1 font-serif text-4xl">{queue.data?.length ?? 0}</p><p className="mt-1 text-sm text-white/65">casais em operação</p></div></CardContent></Card>
      <Card className="border-[#e8e1d4] bg-[#f7f4eb]"><CardContent className="p-5"><CalendarDays className="h-5 w-5 text-[#b18f4b]" /><p className="mt-5 text-xs font-bold uppercase tracking-[.14em] text-[#52615c]">Aguardando</p><p className="mt-1 font-serif text-4xl text-[#1d2b2a]">{stages.scheduled.length}</p><p className="mt-1 text-sm text-[#52615c]">ainda na fila</p></CardContent></Card>
      <Card className="border-[#e8e1d4] bg-[#e5efe4]"><CardContent className="p-5"><UserRoundCheck className="h-5 w-5 text-[#285043]" /><p className="mt-5 text-xs font-bold uppercase tracking-[.14em] text-[#3f6558]">Chegaram</p><p className="mt-1 font-serif text-4xl text-[#1d2b2a]">{stages.checked_in.length}</p><p className="mt-1 text-sm text-[#3f6558]">aguardando mesa</p></CardContent></Card>
      <Card className="border-[#e8e1d4] bg-[#eee9f7]"><CardContent className="p-5"><Clock3 className="h-5 w-5 text-[#5c477b]" /><p className="mt-5 text-xs font-bold uppercase tracking-[.14em] text-[#5c477b]">Em tour</p><p className="mt-1 font-serif text-4xl text-[#1d2b2a]">{inProgress.length}</p><p className="mt-1 text-sm text-[#5c477b]">cronômetros vivos</p></CardContent></Card>
    </div>

    <Card className="border-[#e8e1d4] bg-[#fcfbf7]"><CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-end md:justify-between"><div className="grid w-full gap-2 md:max-w-xs"><Label htmlFor="room-date">Dia da operação</Label><Input id="room-date" type="date" value={date} onChange={event => setDate(event.target.value)} /></div><div className="flex items-center gap-3"><p className="text-xs text-muted-foreground">Fila atualizada automaticamente a cada 5 segundos.</p><Button variant="outline" onClick={() => queue.refetch()} disabled={queue.isFetching}><RefreshCw className={`mr-2 h-4 w-4 ${queue.isFetching ? "animate-spin" : ""}`} />Atualizar</Button></div></CardContent></Card>

    {queue.isLoading ? <Card className="border-[#e8e1d4]"><CardContent className="p-10 text-center text-sm text-muted-foreground">Carregando a fila da sala…</CardContent></Card> : !queue.data?.length ? <EmptyState title="Nenhum casal operacional neste dia" body="As captações agendadas vão aparecer aqui quando tiverem data, hora e sala de vendas. Sem fantasma de planilha, graças a Deus." /> : <div className="grid gap-6 xl:grid-cols-3">
      {(["scheduled", "checked_in", "presented"] as const).map(status => <section key={status} className="min-w-0"><div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Badge className={statusCopy[status].tone}>{statusCopy[status].label}</Badge><span className="text-xs font-medium text-muted-foreground">{stages[status].length}</span></div></div><div className="space-y-3">{stages[status].map(item => <RoomCard key={item.capture.id} item={item} now={now} sellers={sellers} tableValue={tableDraft[item.capture.id] ?? item.capture.salesTable ?? ""} linerValue={linerDraft[item.capture.id] ?? (item.capture.linerId ? String(item.capture.linerId) : "")} closerValue={closerDraft[item.capture.id] ?? (item.capture.closerId ? String(item.capture.closerId) : "")} noTourOpen={noTourOpen === item.capture.id} noTourReason={noTourReason} pending={checkIn.isPending || assignRoom.isPending || startPresentation.isPending || endPresentation.isPending || markNoTour.isPending} onTableChange={value => setTableDraft(current => ({ ...current, [item.capture.id]: value }))} onLinerChange={value => setLinerDraft(current => ({ ...current, [item.capture.id]: value }))} onCloserChange={value => setCloserDraft(current => ({ ...current, [item.capture.id]: value }))} onCheckIn={() => checkIn.mutate({ id: item.capture.id })} onAssign={() => assign(item)} onStart={() => startPresentation.mutate({ id: item.capture.id })} onEnd={() => endPresentation.mutate({ id: item.capture.id })} onToggleNoTour={() => { setNoTourOpen(noTourOpen === item.capture.id ? null : item.capture.id); setNoTourReason(""); }} onNoTourReasonChange={setNoTourReason} onNoTour={() => markNoTour.mutate({ id: item.capture.id, reason: noTourReason })} />)}</div></section>)}
    </div>}
  </div>;
}

function RoomCard({ item, now, sellers, tableValue, linerValue, closerValue, noTourOpen, noTourReason, pending, onTableChange, onLinerChange, onCloserChange, onCheckIn, onAssign, onStart, onEnd, onToggleNoTour, onNoTourReasonChange, onNoTour }: { item: QueueItem; now: Date; sellers: Array<{ id: number; name: string | null }>; tableValue: string; linerValue: string; closerValue: string; noTourOpen: boolean; noTourReason: string; pending: boolean; onTableChange: (value: string) => void; onLinerChange: (value: string) => void; onCloserChange: (value: string) => void; onCheckIn: () => void; onAssign: () => void; onStart: () => void; onEnd: () => void; onToggleNoTour: () => void; onNoTourReasonChange: (value: string) => void; onNoTour: () => void }) {
  const capture = item.capture;
  const liveMinutes = capture.presentationStartedAt ? Math.max(0, Math.floor((now.getTime() - new Date(capture.presentationStartedAt).getTime()) / 60_000)) : item.durationMinutes;
  const scheduled = capture.scheduledAt ? new Date(capture.scheduledAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "Sem horário";
  const isTourOpen = capture.presentationStatus === "presented" && !capture.presentationEndedAt;
  return <Card data-testid="room-card" className="border-[#e8e1d4] bg-white"><CardContent className="space-y-4 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-serif text-lg text-[#1d2b2a]">{item.customer.fullName}</p><p className="mt-1 text-xs text-muted-foreground">{scheduled} · {item.campaign?.name ?? "Sem campanha"}</p></div>{isTourOpen ? <span className="shrink-0 rounded-full bg-[#eee9f7] px-2.5 py-1 text-xs font-semibold text-[#5c477b]">{minuteLabel(liveMinutes)}</span> : null}</div>
    <div className="grid grid-cols-2 gap-2 text-xs"><p className="rounded-lg bg-[#f7f4eb] px-2.5 py-2 text-[#52615c]"><span className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#8b806f]">Mesa</span>{capture.salesTable ?? "A definir"}</p><p className="rounded-lg bg-[#f7f4eb] px-2.5 py-2 text-[#52615c]"><span className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#8b806f]">Sala</span>{capture.salesRoom ?? "Não informada"}</p></div>
    {capture.presentationStatus === "scheduled" ? <div className="flex gap-2"><Button className="flex-1 bg-[#1d2b2a] hover:bg-[#29413e]" disabled={pending} onClick={onCheckIn}><UserRoundCheck className="mr-2 h-4 w-4" />Confirmar chegada</Button><Button variant="outline" size="icon" disabled={pending} onClick={onToggleNoTour} aria-label="Registrar sem-tour"><UserX className="h-4 w-4 text-[#a64943]" /></Button></div> : null}
    {capture.presentationStatus === "checked_in" ? <div className="space-y-3 border-t border-[#eee8dc] pt-4"><div className="grid gap-2"><Label htmlFor={`table-${capture.id}`}>Mesa</Label><Input id={`table-${capture.id}`} value={tableValue} onChange={event => onTableChange(event.target.value)} placeholder="Ex.: M-08" /></div><div className="grid grid-cols-2 gap-2"><div className="grid gap-2"><Label>Liner</Label><Select value={linerValue || undefined} onValueChange={onLinerChange}><SelectTrigger><SelectValue placeholder="Escolher" /></SelectTrigger><SelectContent>{sellers.map(seller => <SelectItem key={seller.id} value={String(seller.id)}>{seller.name ?? `Usuário #${seller.id}`}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-2"><Label>Fechador</Label><Select value={closerValue || undefined} onValueChange={onCloserChange}><SelectTrigger><SelectValue placeholder="Escolher" /></SelectTrigger><SelectContent>{sellers.map(seller => <SelectItem key={seller.id} value={String(seller.id)}>{seller.name ?? `Usuário #${seller.id}`}</SelectItem>)}</SelectContent></Select></div></div><div className="flex gap-2"><Button variant="outline" className="flex-1" disabled={pending} onClick={onAssign}><Armchair className="mr-2 h-4 w-4" />Salvar mesa</Button><Button className="flex-1 bg-[#1d2b2a] hover:bg-[#29413e]" disabled={pending || !capture.salesTable} onClick={onStart}><Play className="mr-2 h-4 w-4" />Iniciar tour</Button></div><Button variant="ghost" className="w-full text-[#a64943] hover:text-[#8b3732]" disabled={pending} onClick={onToggleNoTour}><UserX className="mr-2 h-4 w-4" />Registrar sem-tour</Button></div> : null}
    {isTourOpen ? <div className="border-t border-[#eee8dc] pt-4"><p className="mb-3 text-xs text-[#5c477b]">Em tour com {personName(capture.linerId, sellers)} e {personName(capture.closerId, sellers)}.</p><Button className="w-full bg-[#5c477b] hover:bg-[#4b3968]" disabled={pending} onClick={onEnd}><Square className="mr-2 h-4 w-4" />Encerrar apresentação</Button></div> : null}
    {capture.presentationStatus === "presented" && capture.presentationEndedAt ? <div className="flex items-center gap-2 border-t border-[#eee8dc] pt-3 text-xs text-[#285043]"><CheckCircle2 className="h-4 w-4" />Tour registrado em {minuteLabel(item.durationMinutes)}.</div> : null}
    {noTourOpen ? <div className="space-y-3 border-t border-[#f0ddd8] pt-4"><Label htmlFor={`reason-${capture.id}`}>Motivo do sem-tour *</Label><Textarea id={`reason-${capture.id}`} value={noTourReason} onChange={event => onNoTourReasonChange(event.target.value)} placeholder="Ex.: casal desistiu, condição de entrada, indisponibilidade…" /><Button className="w-full bg-[#a64943] hover:bg-[#8b3732]" disabled={pending || noTourReason.trim().length < 3} onClick={onNoTour}><UserX className="mr-2 h-4 w-4" />Confirmar sem-tour</Button></div> : null}
  </CardContent></Card>;
}
