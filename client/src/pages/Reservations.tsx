import { EmptyState, PageHeader, StatusPill, dateLabel } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { CalendarDays, Plus, Settings2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const dayLabel = (date: Date) => new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit" }).format(date).replace(".", "");

function InventoryDialog() {
  const [open, setOpen] = useState(false);
  const [resortId, setResortId] = useState("");
  const utils = trpc.useUtils();
  const resorts = trpc.operations.resorts.useQuery();
  const createResort = trpc.operations.createResort.useMutation({ onSuccess: () => { utils.operations.resorts.invalidate(); toast.success("Empreendimento cadastrado."); } });
  const createUnit = trpc.operations.createUnit.useMutation({ onSuccess: () => { utils.operations.units.invalidate(); toast.success("Unidade cadastrada."); } });
  const submitResort = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    createResort.mutate({ name: String(data.get("name") ?? ""), city: String(data.get("city") ?? ""), state: String(data.get("state") ?? "") });
  };
  const submitUnit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (!resortId) return toast.error("Selecione o empreendimento.");
    createUnit.mutate({ resortId: Number(resortId), code: String(data.get("code") ?? ""), category: String(data.get("category") ?? ""), capacity: Number(data.get("capacity") ?? 2), beds: Number(data.get("beds") ?? 1) });
  };
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" className="rounded-xl border-[#d9cfbd]"><Settings2 className="mr-2 h-4 w-4" />Inventário</Button></DialogTrigger>
    <DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle className="font-serif text-2xl">Empreendimentos & unidades</DialogTitle></DialogHeader>
      <div className="grid gap-8 py-2 md:grid-cols-2">
        <form className="grid gap-3" onSubmit={submitResort}><p className="text-sm font-semibold text-[#1d2b2a]">Novo empreendimento</p><Input name="name" required placeholder="Nome do empreendimento" /><div className="grid grid-cols-3 gap-2"><Input className="col-span-2" name="city" placeholder="Cidade" /><Input name="state" maxLength={2} placeholder="UF" /></div><Button disabled={createResort.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">Adicionar empreendimento</Button></form>
        <form className="grid gap-3 border-t pt-6 md:border-l md:border-t-0 md:pl-8 md:pt-0" onSubmit={submitUnit}><p className="text-sm font-semibold text-[#1d2b2a]">Nova unidade</p><Select value={resortId} onValueChange={setResortId}><SelectTrigger><SelectValue placeholder="Empreendimento" /></SelectTrigger><SelectContent>{resorts.data?.map(resort => <SelectItem key={resort.id} value={String(resort.id)}>{resort.name}</SelectItem>)}</SelectContent></Select><div className="grid grid-cols-2 gap-2"><Input name="code" required placeholder="Unidade 302" /><Input name="category" placeholder="Categoria" /></div><div className="grid grid-cols-2 gap-2"><Input name="capacity" type="number" min="1" defaultValue="2" /><Input name="beds" type="number" min="1" defaultValue="1" /></div><Button disabled={createUnit.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">Adicionar unidade</Button></form>
      </div>
    </DialogContent>
  </Dialog>;
}

function NewReservationDialog() {
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [contractId, setContractId] = useState("none");
  const [unitId, setUnitId] = useState("");
  const utils = trpc.useUtils();
  const customers = trpc.customers.list.useQuery();
  const contracts = trpc.contracts.list.useQuery();
  const units = trpc.operations.units.useQuery();
  const create = trpc.operations.createReservation.useMutation({ onSuccess: () => { utils.operations.reservations.invalidate(); setOpen(false); toast.success("Reserva criada e disponibilidade atualizada."); }, onError: error => toast.error(error.message) });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (!customerId || !unitId) return toast.error("Selecione cliente e unidade.");
    create.mutate({ customerId: Number(customerId), contractId: contractId === "none" ? null : Number(contractId), unitId: Number(unitId), checkIn: String(data.get("checkIn") ?? ""), checkOut: String(data.get("checkOut") ?? ""), adults: Number(data.get("adults") ?? 1), children: Number(data.get("children") ?? 0), notes: String(data.get("notes") ?? "") || null, status: "confirmed" });
  };
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button className="rounded-xl bg-[#1d2b2a] hover:bg-[#29413e]"><Plus className="mr-2 h-4 w-4" />Nova reserva</Button></DialogTrigger>
    <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle className="font-serif text-2xl">Nova reserva</DialogTitle></DialogHeader>
      <form className="grid gap-4 py-2" onSubmit={submit}>
        <div className="grid gap-2"><Label>Associado *</Label><Select value={customerId} onValueChange={setCustomerId}><SelectTrigger><SelectValue placeholder="Selecione um cliente" /></SelectTrigger><SelectContent>{customers.data?.map(customer => <SelectItem key={customer.id} value={String(customer.id)}>{customer.fullName}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-2"><Label>Contrato vinculado</Label><Select value={contractId} onValueChange={setContractId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Sem vínculo</SelectItem>{contracts.data?.filter(item => !customerId || item.contract.customerId === Number(customerId)).map(({ contract }) => <SelectItem key={contract.id} value={String(contract.id)}>{contract.number}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-2"><Label>Unidade *</Label><Select value={unitId} onValueChange={setUnitId}><SelectTrigger><SelectValue placeholder="Selecione a unidade" /></SelectTrigger><SelectContent>{units.data?.filter(item => item.unit.status === "active").map(({ unit, resortName }) => <SelectItem key={unit.id} value={String(unit.id)}>{resortName} · {unit.code}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid grid-cols-2 gap-4"><div className="grid gap-2"><Label>Check-in *</Label><Input name="checkIn" type="date" required /></div><div className="grid gap-2"><Label>Check-out *</Label><Input name="checkOut" type="date" required /></div></div>
        <div className="grid grid-cols-2 gap-4"><div className="grid gap-2"><Label>Adultos</Label><Input name="adults" type="number" min="1" defaultValue="1" /></div><div className="grid gap-2"><Label>Crianças</Label><Input name="children" type="number" min="0" defaultValue="0" /></div></div>
        <div className="grid gap-2"><Label>Observações</Label><Textarea name="notes" /></div>
        <Button disabled={create.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">{create.isPending ? "Reservando..." : "Confirmar reserva"}</Button>
      </form>
    </DialogContent>
  </Dialog>;
}

export default function Reservations() {
  const units = trpc.operations.units.useQuery();
  const reservations = trpc.operations.reservations.useQuery();
  const utils = trpc.useUtils();
  const updateStatus = trpc.operations.updateReservationStatus.useMutation({
    onSuccess: () => { utils.operations.reservations.invalidate(); toast.success("Status da reserva atualizado."); },
    onError: error => toast.error(error.message),
  });
  const days = useMemo(() => Array.from({ length: 8 }, (_, index) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + index); return date; }), []);
  return <div className="space-y-8">
    <PageHeader eyebrow="Utilização" title="Reservas & disponibilidade" description="Acompanhe unidades, períodos e hóspedes em um calendário objetivo — sem overbooking de susto às vésperas do check-in." action={<div className="flex gap-2"><InventoryDialog /><NewReservationDialog /></div>} />
    {!units.data?.length ? <EmptyState title="Seu inventário ainda está vazio" body="Cadastre o empreendimento e as unidades primeiro. Depois o calendário começa a trabalhar sem te deixar na mão." action={<InventoryDialog />} /> : <div className="space-y-5">
      <Card className="overflow-hidden rounded-[1.5rem] border-[#e8e3d9]"><CardHeader><div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#b18f4b]">Próximos oito dias</p><CardTitle className="mt-1 font-serif text-2xl text-[#1d2b2a]">Mapa de disponibilidade</CardTitle></div></CardHeader><CardContent className="overflow-x-auto"><div className="min-w-[840px]"><div className="grid grid-cols-[190px_repeat(8,minmax(76px,1fr))] border-b border-[#eee9df] text-center text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground"><div className="p-3 text-left">Unidade</div>{days.map(day => <div key={isoDay(day)} className="border-l border-[#eee9df] p-3">{dayLabel(day)}</div>)}</div>{units.data.map(({ unit, resortName }) => <div key={unit.id} className="grid min-h-16 grid-cols-[190px_repeat(8,minmax(76px,1fr))] border-b border-[#f0ece4] last:border-b-0"><div className="flex flex-col justify-center bg-[#faf8f3] px-3"><span className="text-sm font-semibold text-[#1d2b2a]">{unit.code}</span><span className="text-[11px] text-muted-foreground">{resortName}</span></div>{days.map(day => { const booking = reservations.data?.find(item => item.reservation.unitId === unit.id && new Date(item.reservation.checkIn) <= day && new Date(item.reservation.checkOut) > day && item.reservation.status !== "cancelled"); return <div key={isoDay(day)} className="border-l border-[#f0ece4] p-1.5">{booking ? <div title={booking.customerName} className="h-full min-h-12 rounded-lg bg-[#2d675f] p-1.5 text-[9px] font-semibold leading-tight text-white">{booking.customerName.split(" ")[0]}</div> : <div className="h-full min-h-12 rounded-lg bg-[#eaf0ea]" />}</div>; })}</div>)}</div></CardContent></Card>
      <div className="overflow-hidden rounded-[1.35rem] border border-[#e9e4da] bg-white"><div className="grid grid-cols-[1.35fr_1fr_1fr_1fr_auto_auto] gap-4 border-b border-[#eee9df] bg-[#faf8f3] px-6 py-3 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground"><span>Hóspede</span><span>Unidade</span><span>Período</span><span>Contrato</span><span>Status</span><span>Ação</span></div>{reservations.data?.length ? reservations.data.map(({ reservation, customerName, unitCode, resortName, contractNumber }) => <div key={reservation.id} className="grid grid-cols-[1.35fr_1fr_1fr_1fr_auto_auto] items-center gap-4 px-6 py-4 text-sm hover:bg-[#fdfcf9]"><span className="font-semibold text-[#1d2b2a]">{customerName}</span><span>{resortName} · {unitCode}</span><span className="text-xs text-muted-foreground">{dateLabel(reservation.checkIn)} → {dateLabel(reservation.checkOut)}</span><span>{contractNumber || "—"}</span><StatusPill value={reservation.status} /><div>{reservation.status === "confirmed" ? <Button size="sm" variant="outline" onClick={() => updateStatus.mutate({ id: reservation.id, status: "checked_in" })}>Check-in</Button> : reservation.status === "checked_in" ? <Button size="sm" className="bg-[#1d2b2a] hover:bg-[#29413e]" onClick={() => updateStatus.mutate({ id: reservation.id, status: "completed" })}>Check-out</Button> : <span className="text-xs text-muted-foreground">—</span>}</div></div>) : <div className="p-8 text-center text-sm text-muted-foreground">Nenhuma reserva criada ainda.</div>}</div>
    </div>}
  </div>;
}
