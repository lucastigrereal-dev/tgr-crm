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
import { Armchair, CalendarDays, CheckCircle2, Clock3, DoorOpen, Play, RefreshCw, Square, UserRoundCheck, UserX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const statusCopy = {
  scheduled: { label: "Na fila", tone: "bg-[#e6eef5] text-[#315d7e]" },
  checked_in: { label: "Chegou", tone: "bg-[#e5efe4] text-[#285043]" },
  presented: { label: "Em apresentação", tone: "bg-[#ece8f6] text-[#5c477b]" },
} as const;

type RouterOutput = inferRouterOutputs<AppRouter>;
type QueueItem = RouterOutput["captures"]["receptionQueue"][number];
type Operator = { id: number; name: string | null };

function todayLocal() { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); }
function minuteLabel(minutes: number) { if (minutes <= 0) return "agora"; const hours = Math.floor(minutes / 60); return hours ? `${hours}h ${minutes % 60}min` : `${minutes} min`; }
function personName(id: number | null, operators: Operator[]) { return operators.find(operator => operator.id === id)?.name ?? "Não atribuído"; }

function OperatorSelect({ label, value, operators, onChange }: { label: string; value: string; operators: Operator[]; onChange: (value: string) => void }) {
  return <div className="grid gap-2"><Label>{label}</Label><Select value={value || undefined} onValueChange={onChange}><SelectTrigger><SelectValue placeholder="Escolher" /></SelectTrigger><SelectContent>{operators.map(operator => <SelectItem key={operator.id} value={String(operator.id)}>{operator.name ?? `Usuário #${operator.id}`}</SelectItem>)}</SelectContent></Select></div>;
}

export default function SalesRoom() {
  const utils = trpc.useUtils();
  const [date, setDate] = useState(todayLocal);
  const [now, setNow] = useState(() => new Date());
  const [tableDraft, setTableDraft] = useState<Record<number, string>>({});
  const [linerDraft, setLinerDraft] = useState<Record<number, string>>({});
  const [closerDraft, setCloserDraft] = useState<Record<number, string>>({});
  const [managerDraft, setManagerDraft] = useState<Record<number, string>>({});
  const [noTourOpen, setNoTourOpen] = useState<number | null>(null);
  const [noTourReason, setNoTourReason] = useState("");
  const queue = trpc.captures.receptionQueue.useQuery({ date }, { refetchInterval: 5_000 });
  const selectors = trpc.captures.selectors.useQuery();
  const operators = selectors.data?.sellers ?? [];

  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") return;
    const source = new window.EventSource(`/api/realtime/sales-room?date=${encodeURIComponent(date)}`);
    const refreshFromRealtime = () => { void utils.captures.receptionQueue.invalidate({ date }); };
    const eventTypes = ["capture.created", "capture.checked_in", "capture.room.assigned", "capture.presentation.started", "capture.presentation.ended", "capture.no_tour", "capture.status.updated"];
    eventTypes.forEach(type => source.addEventListener(type, refreshFromRealtime));
    return () => { eventTypes.forEach(type => source.removeEventListener(type, refreshFromRealtime)); source.close(); };
  }, [date, utils]);
  const refresh = () => { utils.captures.receptionQueue.invalidate(); utils.captures.list.invalidate(); };
  const checkIn = trpc.captures.checkIn.useMutation({ onSuccess: () => { toast.success("Chegada registrada. Agora a recepção manda o casal para a mesa."); refresh(); }, onError: error => toast.error(error.message) });
  const assignRoom = trpc.captures.assignRoom.useMutation({ onSuccess: () => { toast.success("Mesa, time e gerente de sala atribuídos."); refresh(); }, onError: error => toast.error(error.message) });
  const startPresentation = trpc.captures.startPresentation.useMutation({ onSuccess: () => { toast.success("Tour iniciado. O cronômetro está rodando."); refresh(); }, onError: error => toast.error(error.message) });
  const endPresentation = trpc.captures.endPresentation.useMutation({ onSuccess: result => { toast.success(`Apresentação encerrada: ${result.durationMinutes} minutos registrados.`); refresh(); }, onError: error => toast.error(error.message) });
  const markNoTour = trpc.captures.markNoTour.useMutation({ onSuccess: () => { toast.success("Sem-tour registrado com motivo e trilha de auditoria."); setNoTourOpen(null); setNoTourReason(""); refresh(); }, onError: error => toast.error(error.message) });

  const stages = useMemo(() => ({ scheduled: queue.data?.filter(item => item.capture.presentationStatus === "scheduled") ?? [], checked_in: queue.data?.filter(item => item.capture.presentationStatus === "checked_in") ?? [], presented: queue.data?.filter(item => item.capture.presentationStatus === "presented") ?? [] }), [queue.data]);
  const inProgress = stages.presented.filter(item => !item.capture.presentationEndedAt);
  const assign = (item: QueueItem) => {
    const salesTable = tableDraft[item.capture.id] ?? item.capture.salesTable ?? "";
    if (!salesTable.trim()) { toast.error("Informe a mesa antes de entregar o casal para a sala."); return; }
    assignRoom.mutate({ id: item.capture.id, salesTable, linerId: linerDraft[item.capture.id] ? Number(linerDraft[item.capture.id]) : item.capture.linerId, closerId: closerDraft[item.capture.id] ? Number(closerDraft[item.capture.id]) : item.capture.closerId, roomManagerId: managerDraft[item.capture.id] ? Number(managerDraft[item.capture.id]) : item.capture.roomManagerId });
  };
  const pending = checkIn.isPending || assignRoom.isPending || startPresentation.isPending || endPresentation.isPending || markNoTour.isPending;

  return <div className="space-y-6">
    <PageHeader eyebrow="Fila viva · operação do dia" title="Sala de vendas" description="Chegada, mesa, time e tour em uma fila só. Cada casal tem estado, relógio e próximo responsável — sem grito atravessado no salão." />
    <div className="grid gap-4 lg:grid-cols-[1.2fr_repeat(3,minmax(0,1fr))]">
      <MetricCard dark icon={<DoorOpen className="h-5 w-5 text-[#e8d092]" />} label="Fila do dia" value={queue.data?.length ?? 0} detail="casais em operação" />
      <MetricCard icon={<CalendarDays className="h-5 w-5 text-[#b18f4b]" />} label="Aguardando" value={stages.scheduled.length} detail="ainda na fila" />
      <MetricCard tone="green" icon={<UserRoundCheck className="h-5 w-5 text-[#285043]" />} label="Chegaram" value={stages.checked_in.length} detail="aguardando mesa" />
      <MetricCard tone="purple" icon={<Clock3 className="h-5 w-5 text-[#5c477b]" />} label="Em tour" value={inProgress.length} detail="cronômetros vivos" />
    </div>
    <Card className="rounded-xl border-[#e4ddcf] bg-[#fcfbf7] shadow-none"><CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-end md:justify-between"><div className="grid w-full gap-2 md:max-w-xs"><Label htmlFor="room-date" className="tgr-data-label">Dia da operação</Label><Input id="room-date" type="date" value={date} onChange={event => setDate(event.target.value)} /></div><div className="flex flex-wrap items-center gap-3"><p className="text-xs text-muted-foreground">Atualização automática a cada 5 segundos.</p><Button variant="outline" className="tgr-focus-ring" onClick={() => queue.refetch()} disabled={queue.isFetching}><RefreshCw className={`mr-2 h-4 w-4 ${queue.isFetching ? "animate-spin" : ""}`} />Atualizar</Button></div></CardContent></Card>
    {queue.isLoading ? <Card className="rounded-xl border-[#e8e1d4]"><CardContent className="p-10 text-center text-sm text-muted-foreground">Carregando a fila da sala…</CardContent></Card> : !queue.data?.length ? <EmptyState title="Nenhum casal operacional neste dia" body="As captações agendadas vão aparecer aqui quando tiverem data, hora e sala de vendas. Sem fantasma de planilha, graças a Deus." /> : <div className="grid gap-5 xl:grid-cols-3">{(["scheduled", "checked_in", "presented"] as const).map(status => <section key={status} className="min-w-0 rounded-xl border border-[#e6dfd2] bg-[#fdfcf9] p-3"><div className="mb-3 flex items-center justify-between gap-2 border-b border-[#ebe5da] pb-3"><Badge className={statusCopy[status].tone}>{statusCopy[status].label}</Badge><span className="rounded-md bg-[#f1ede4] px-2 py-1 text-xs font-semibold tabular-nums text-[#52615c]">{stages[status].length}</span></div><div className="space-y-3">{stages[status].map(item => <RoomCard key={item.capture.id} item={item} now={now} operators={operators} tableValue={tableDraft[item.capture.id] ?? item.capture.salesTable ?? ""} linerValue={linerDraft[item.capture.id] ?? (item.capture.linerId ? String(item.capture.linerId) : "")} closerValue={closerDraft[item.capture.id] ?? (item.capture.closerId ? String(item.capture.closerId) : "")} managerValue={managerDraft[item.capture.id] ?? (item.capture.roomManagerId ? String(item.capture.roomManagerId) : "")} noTourOpen={noTourOpen === item.capture.id} noTourReason={noTourReason} pending={pending} onTableChange={value => setTableDraft(current => ({ ...current, [item.capture.id]: value }))} onLinerChange={value => setLinerDraft(current => ({ ...current, [item.capture.id]: value }))} onCloserChange={value => setCloserDraft(current => ({ ...current, [item.capture.id]: value }))} onManagerChange={value => setManagerDraft(current => ({ ...current, [item.capture.id]: value }))} onCheckIn={() => checkIn.mutate({ id: item.capture.id })} onAssign={() => assign(item)} onStart={() => startPresentation.mutate({ id: item.capture.id })} onEnd={() => endPresentation.mutate({ id: item.capture.id })} onToggleNoTour={() => { setNoTourOpen(noTourOpen === item.capture.id ? null : item.capture.id); setNoTourReason(""); }} onNoTourReasonChange={setNoTourReason} onNoTour={() => markNoTour.mutate({ id: item.capture.id, reason: noTourReason })} />)}</div></section>)}</div>}
  </div>;
}

function MetricCard({ icon, label, value, detail, dark, tone }: { icon: React.ReactNode; label: string; value: number; detail: string; dark?: boolean; tone?: "green" | "purple" }) {
  const className = dark ? "border-[#e8e1d4] bg-[#1d2b2a] text-white" : tone === "green" ? "border-[#e8e1d4] bg-[#e5efe4]" : tone === "purple" ? "border-[#e8e1d4] bg-[#eee9f7]" : "border-[#e8e1d4] bg-[#f7f4eb]";
  return <Card className={`${className} rounded-xl shadow-none`}><CardContent className="p-5">{icon}<p className={`mt-5 text-[10px] font-bold uppercase tracking-[.14em] ${dark ? "text-white/55" : "text-[#52615c]"}`}>{label}</p><p className={`mt-1 font-serif text-4xl tabular-nums ${dark ? "text-white" : "text-[#1d2b2a]"}`}>{value}</p><p className={`mt-1 text-sm ${dark ? "text-white/65" : "text-[#52615c]"}`}>{detail}</p></CardContent></Card>;
}

function RoomCard({ item, now, operators, tableValue, linerValue, closerValue, managerValue, noTourOpen, noTourReason, pending, onTableChange, onLinerChange, onCloserChange, onManagerChange, onCheckIn, onAssign, onStart, onEnd, onToggleNoTour, onNoTourReasonChange, onNoTour }: { item: QueueItem; now: Date; operators: Operator[]; tableValue: string; linerValue: string; closerValue: string; managerValue: string; noTourOpen: boolean; noTourReason: string; pending: boolean; onTableChange: (value: string) => void; onLinerChange: (value: string) => void; onCloserChange: (value: string) => void; onManagerChange: (value: string) => void; onCheckIn: () => void; onAssign: () => void; onStart: () => void; onEnd: () => void; onToggleNoTour: () => void; onNoTourReasonChange: (value: string) => void; onNoTour: () => void }) {
  const capture = item.capture;
  const liveMinutes = capture.presentationStartedAt ? Math.max(0, Math.floor((now.getTime() - new Date(capture.presentationStartedAt).getTime()) / 60_000)) : item.durationMinutes;
  const scheduled = capture.scheduledAt ? new Date(capture.scheduledAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "Sem horário";
  const isTourOpen = capture.presentationStatus === "presented" && !capture.presentationEndedAt;
  return <Card data-testid="room-card" className="rounded-lg border-[#e8e1d4] bg-white shadow-none"><CardContent className="space-y-4 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-serif text-lg text-[#1d2b2a]">{item.customer.fullName}</p><p className="mt-1 text-xs text-muted-foreground">{scheduled} · {item.campaign?.name ?? "Sem campanha"}</p></div>{isTourOpen ? <span className="shrink-0 rounded-md bg-[#eee9f7] px-2.5 py-1 text-xs font-semibold tabular-nums text-[#5c477b]">{minuteLabel(liveMinutes)}</span> : null}</div><div className="grid grid-cols-2 gap-2 text-xs"><InfoBox label="Mesa" value={capture.salesTable ?? "A definir"} /><InfoBox label="Sala" value={capture.salesRoom ?? "Não informada"} /></div>{capture.presentationStatus === "scheduled" ? <div className="flex gap-2"><Button className="flex-1 bg-[#1d2b2a] hover:bg-[#29413e]" disabled={pending} onClick={onCheckIn}><UserRoundCheck className="mr-2 h-4 w-4" />Confirmar chegada</Button><Button variant="outline" size="icon" disabled={pending} onClick={onToggleNoTour} aria-label="Registrar sem-tour"><UserX className="h-4 w-4 text-[#a64943]" /></Button></div> : null}{capture.presentationStatus === "checked_in" ? <div className="space-y-3 border-t border-[#eee8dc] pt-4"><div className="grid gap-2"><Label htmlFor={`table-${capture.id}`}>Mesa</Label><Input id={`table-${capture.id}`} value={tableValue} onChange={event => onTableChange(event.target.value)} placeholder="Ex.: M-08" /></div><div className="grid gap-2"><div className="grid gap-2 sm:grid-cols-2"><OperatorSelect label="Liner" value={linerValue} operators={operators} onChange={onLinerChange} /><OperatorSelect label="Fechador" value={closerValue} operators={operators} onChange={onCloserChange} /></div><OperatorSelect label="Gerente de sala" value={managerValue} operators={operators} onChange={onManagerChange} /></div><div className="flex gap-2"><Button variant="outline" className="flex-1" disabled={pending} onClick={onAssign}><Armchair className="mr-2 h-4 w-4" />Salvar mesa</Button><Button className="flex-1 bg-[#1d2b2a] hover:bg-[#29413e]" disabled={pending || !capture.salesTable} onClick={onStart}><Play className="mr-2 h-4 w-4" />Iniciar tour</Button></div><Button variant="ghost" className="w-full text-[#a64943] hover:text-[#8b3732]" disabled={pending} onClick={onToggleNoTour}><UserX className="mr-2 h-4 w-4" />Registrar sem-tour</Button></div> : null}{isTourOpen ? <div className="border-t border-[#eee8dc] pt-4"><p className="mb-3 text-xs text-[#5c477b]">Em tour com {personName(capture.linerId, operators)}, {personName(capture.closerId, operators)} e gerência de {personName(capture.roomManagerId, operators)}.</p><Button className="w-full bg-[#5c477b] hover:bg-[#4b3968]" disabled={pending} onClick={onEnd}><Square className="mr-2 h-4 w-4" />Encerrar apresentação</Button></div> : null}{capture.presentationStatus === "presented" && capture.presentationEndedAt ? <div className="flex items-center gap-2 border-t border-[#eee8dc] pt-3 text-xs text-[#285043]"><CheckCircle2 className="h-4 w-4" />Tour registrado em {minuteLabel(item.durationMinutes)}.</div> : null}{noTourOpen ? <div className="space-y-3 border-t border-[#f0ddd8] pt-4"><Label htmlFor={`reason-${capture.id}`}>Motivo do sem-tour *</Label><Textarea id={`reason-${capture.id}`} value={noTourReason} onChange={event => onNoTourReasonChange(event.target.value)} placeholder="Ex.: casal desistiu, condição de entrada, indisponibilidade…" /><Button className="w-full bg-[#a64943] hover:bg-[#8b3732]" disabled={pending || noTourReason.trim().length < 3} onClick={onNoTour}><UserX className="mr-2 h-4 w-4" />Confirmar sem-tour</Button></div> : null}</CardContent></Card>;
}

function InfoBox({ label, value }: { label: string; value: string }) { return <p className="rounded-lg bg-[#f7f4eb] px-2.5 py-2 text-[#52615c]"><span className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#8b806f]">{label}</span>{value}</p>; }
