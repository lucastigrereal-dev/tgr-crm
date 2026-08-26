import { EmptyState, PageHeader, StatusPill, dateLabel } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { WaitlistDialog } from "@/components/WaitlistDialog";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { CalendarDays, Hammer, KeyRound, Plus, Settings2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const dayLabel = (date: Date) => new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit" }).format(date).replace(".", "");
type WaitlistOffer = { id: number; resortId: number | null; desiredCheckIn: Date; desiredCheckOut: Date; partySize: number };

function InventoryDialog() {
  const [open, setOpen] = useState(false);
  const [resortId, setResortId] = useState("");
  const [inventoryResort, setInventoryResort] = useState("all");
  const [inventoryStatus, setInventoryStatus] = useState<"all" | "active" | "maintenance" | "inactive">("all");
  const utils = trpc.useUtils();
  const resorts = trpc.operations.resorts.useQuery();
  const units = trpc.operations.units.useQuery({ resortId: inventoryResort === "all" ? undefined : Number(inventoryResort), status: inventoryStatus === "all" ? undefined : inventoryStatus });
  const createResort = trpc.operations.createResort.useMutation({ onSuccess: () => { utils.operations.resorts.invalidate(); toast.success("Empreendimento cadastrado."); } });
  const createUnit = trpc.operations.createUnit.useMutation({ onSuccess: () => { utils.operations.units.invalidate(); toast.success("Unidade cadastrada."); } });
  const updateUnit = trpc.operations.updateUnit.useMutation({ onSuccess: () => { utils.operations.units.invalidate(); toast.success("Status operacional da unidade atualizado."); }, onError: error => toast.error(error.message) });
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
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl"><DialogHeader><DialogTitle className="font-serif text-2xl">Empreendimentos & unidades</DialogTitle></DialogHeader>
      <div className="grid gap-8 py-2 md:grid-cols-2">
        <form className="grid gap-3" onSubmit={submitResort}><p className="text-sm font-semibold text-[#1d2b2a]">Novo empreendimento</p><Input name="name" required placeholder="Nome do empreendimento" /><div className="grid grid-cols-3 gap-2"><Input className="col-span-2" name="city" placeholder="Cidade" /><Input name="state" maxLength={2} placeholder="UF" /></div><Button disabled={createResort.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">Adicionar empreendimento</Button></form>
        <form className="grid gap-3 border-t pt-6 md:border-l md:border-t-0 md:pl-8 md:pt-0" onSubmit={submitUnit}><p className="text-sm font-semibold text-[#1d2b2a]">Nova unidade</p><Select value={resortId} onValueChange={setResortId}><SelectTrigger><SelectValue placeholder="Empreendimento" /></SelectTrigger><SelectContent>{resorts.data?.map(resort => <SelectItem key={resort.id} value={String(resort.id)}>{resort.name}</SelectItem>)}</SelectContent></Select><div className="grid grid-cols-2 gap-2"><Input name="code" required placeholder="Unidade 302" /><Input name="category" placeholder="Categoria" /></div><div className="grid grid-cols-2 gap-2"><Input name="capacity" type="number" min="1" defaultValue="2" /><Input name="beds" type="number" min="1" defaultValue="1" /></div><Button disabled={createUnit.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">Adicionar unidade</Button></form>
      </div>
      <div className="mt-3 rounded-2xl border border-[#e8e3d9]"><div className="flex flex-col gap-3 border-b border-[#eee9df] p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-[#1d2b2a]">Mapa operacional do inventário</p><p className="text-xs text-muted-foreground">Filtre e atualize o status sem procurar unidade em planilha jurássica.</p></div><div className="flex gap-2"><Select value={inventoryResort} onValueChange={setInventoryResort}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos os resorts</SelectItem>{resorts.data?.map(resort => <SelectItem key={resort.id} value={String(resort.id)}>{resort.name}</SelectItem>)}</SelectContent></Select><Select value={inventoryStatus} onValueChange={value => setInventoryStatus(value as typeof inventoryStatus)}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos status</SelectItem><SelectItem value="active">Ativas</SelectItem><SelectItem value="maintenance">Manutenção</SelectItem><SelectItem value="inactive">Inativas</SelectItem></SelectContent></Select></div></div><div className="max-h-64 overflow-y-auto">{units.data?.length ? units.data.map(({ unit, resortName }) => <div key={unit.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f0ece4] px-4 py-3 last:border-b-0"><div><p className="text-sm font-semibold text-[#1d2b2a]">{resortName} · {unit.code}</p><p className="text-xs text-muted-foreground">{unit.category || "Sem categoria"} · {unit.capacity} hóspedes · {unit.beds} camas</p></div><Select value={unit.status} onValueChange={status => updateUnit.mutate({ id: unit.id, code: unit.code, category: unit.category, capacity: unit.capacity, beds: unit.beds, status: status as "active" | "maintenance" | "inactive" })}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Ativa</SelectItem><SelectItem value="maintenance">Manutenção</SelectItem><SelectItem value="inactive">Inativa</SelectItem></SelectContent></Select></div>) : <p className="p-5 text-sm text-muted-foreground">Nenhuma unidade encontrada neste filtro.</p>}</div></div>
    </DialogContent>
  </Dialog>;
}

function OwnershipOperationsDialog() {
  const [open, setOpen] = useState(false);
  const [contractId, setContractId] = useState("");
  const [resortId, setResortId] = useState("none");
  const [unitId, setUnitId] = useState("none");
  const [entitlementType, setEntitlementType] = useState<"fixed_week" | "flexible_week" | "points" | "exchange">("flexible_week");
  const [maintenanceUnitId, setMaintenanceUnitId] = useState("");
  const utils = trpc.useUtils();
  const contracts = trpc.contracts.list.useQuery();
  const resorts = trpc.operations.resorts.useQuery();
  const units = trpc.operations.units.useQuery();
  const entitlements = trpc.ownership.listEntitlements.useQuery();
  const entitlementRows = entitlements.data?.rows ?? [];
  const maintenance = trpc.ownership.listMaintenanceBlocks.useQuery();
  const maintenanceRows = maintenance.data?.rows ?? [];
  const createEntitlement = trpc.ownership.createEntitlement.useMutation({ onSuccess: () => { utils.ownership.listEntitlements.invalidate(); toast.success("Direito de uso registrado e auditado."); setContractId(""); }, onError: error => toast.error(error.message) });
  const createMaintenance = trpc.ownership.createMaintenanceBlock.useMutation({ onSuccess: () => { utils.ownership.listMaintenanceBlocks.invalidate(); toast.success("Bloqueio de manutenção registrado no inventário."); setMaintenanceUnitId(""); }, onError: error => toast.error(error.message) });
  const eligibleUnits = units.data?.filter(item => resortId === "none" || item.unit.resortId === Number(resortId)) ?? [];
  const submitEntitlement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (!contractId) return toast.error("Selecione o contrato que receberá o direito.");
    createEntitlement.mutate({ contractId: Number(contractId), resortId: resortId === "none" ? null : Number(resortId), unitId: unitId === "none" ? null : Number(unitId), entitlementType, fixedWeek: entitlementType === "fixed_week" ? Number(data.get("fixedWeek") ?? 0) || null : null, annualPoints: entitlementType === "points" ? Number(data.get("annualPoints") ?? 0) : 0, priorityLevel: Number(data.get("priorityLevel") ?? 1), validFrom: String(data.get("validFrom") ?? "") || null, validUntil: String(data.get("validUntil") ?? "") || null });
  };
  const submitMaintenance = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (!maintenanceUnitId) return toast.error("Selecione a unidade para bloquear.");
    createMaintenance.mutate({ unitId: Number(maintenanceUnitId), startsAt: String(data.get("startsAt") ?? ""), endsAt: String(data.get("endsAt") ?? ""), reason: String(data.get("reason") ?? "") });
  };
  const contractNumber = (id: number) => contracts.data?.rows?.find(item => item.contract.id === id)?.contract.number ?? `Contrato #${id}`;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" className="rounded-xl border-[#d9cfbd]"><KeyRound className="mr-2 h-4 w-4" />Direitos & manutenção</Button></DialogTrigger>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl"><DialogHeader><DialogTitle className="font-serif text-2xl">Direitos de uso & integridade do inventário</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">Registre o que cada contrato pode usar e bloqueie unidade antes que uma manutenção vire overbooking com cheiro de enxofre.</p>
      <div className="grid gap-8 py-2 lg:grid-cols-2">
        <form className="grid gap-3 rounded-2xl border border-[#e8e3d9] bg-[#faf8f3] p-5" onSubmit={submitEntitlement}>
          <div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#b18f4b]">Direito do associado</p><p className="mt-1 text-sm font-semibold text-[#1d2b2a]">Vincular contrato ao uso</p></div>
          <Select value={contractId} onValueChange={setContractId}><SelectTrigger><SelectValue placeholder="Contrato" /></SelectTrigger><SelectContent>{contracts.data?.rows?.map(({ contract, customerName }) => <SelectItem key={contract.id} value={String(contract.id)}>{contract.number} · {customerName}</SelectItem>)}</SelectContent></Select>
          <div className="grid grid-cols-2 gap-2"><Select value={resortId} onValueChange={value => { setResortId(value); setUnitId("none"); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Qualquer empreendimento</SelectItem>{resorts.data?.map(resort => <SelectItem key={resort.id} value={String(resort.id)}>{resort.name}</SelectItem>)}</SelectContent></Select><Select value={unitId} onValueChange={setUnitId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Sem unidade fixa</SelectItem>{eligibleUnits.map(({ unit, resortName }) => <SelectItem key={unit.id} value={String(unit.id)}>{resortName} · {unit.code}</SelectItem>)}</SelectContent></Select></div>
          <Select value={entitlementType} onValueChange={value => setEntitlementType(value as typeof entitlementType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="flexible_week">Semana flexível</SelectItem><SelectItem value="fixed_week">Semana fixa</SelectItem><SelectItem value="points">Pontos</SelectItem><SelectItem value="exchange">Intercâmbio</SelectItem></SelectContent></Select>
          <div className="grid grid-cols-2 gap-2">{entitlementType === "fixed_week" ? <Input name="fixedWeek" type="number" min="1" max="53" placeholder="Semana (1–53)" required /> : entitlementType === "points" ? <Input name="annualPoints" type="number" min="1" placeholder="Pontos anuais" required /> : <Input disabled placeholder="Uso sem cota fixa" />}<Input name="priorityLevel" type="number" min="1" max="9" defaultValue="1" title="1 é maior prioridade" /></div>
          <div className="grid grid-cols-2 gap-2"><Input name="validFrom" type="date" /><Input name="validUntil" type="date" /></div>
          <Button disabled={createEntitlement.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">{createEntitlement.isPending ? "Registrando..." : "Registrar direito"}</Button>
        </form>
        <form className="grid gap-3 rounded-2xl border border-[#e8e3d9] bg-[#faf8f3] p-5" onSubmit={submitMaintenance}>
          <div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#b18f4b]">Proteção do inventário</p><p className="mt-1 text-sm font-semibold text-[#1d2b2a]">Bloquear manutenção</p></div>
          <Select value={maintenanceUnitId} onValueChange={setMaintenanceUnitId}><SelectTrigger><SelectValue placeholder="Unidade" /></SelectTrigger><SelectContent>{units.data?.map(({ unit, resortName }) => <SelectItem key={unit.id} value={String(unit.id)}>{resortName} · {unit.code}</SelectItem>)}</SelectContent></Select>
          <div className="grid grid-cols-2 gap-2"><div className="grid gap-1"><Label>Início</Label><Input name="startsAt" type="date" required /></div><div className="grid gap-1"><Label>Fim</Label><Input name="endsAt" type="date" required /></div></div>
          <Textarea name="reason" minLength={3} required placeholder="Motivo do bloqueio: revisão hidráulica, pintura..." />
          <Button disabled={createMaintenance.isPending} variant="outline" className="border-[#c9a75d] text-[#5d461d] hover:bg-[#fff7e5]">{createMaintenance.isPending ? "Bloqueando..." : "Bloquear unidade"}</Button>
        </form>
      </div>
      <div className="grid gap-5 lg:grid-cols-2"><div className="rounded-2xl border border-[#e8e3d9]"><div className="flex items-center gap-2 border-b border-[#eee9df] px-4 py-3"><KeyRound className="h-4 w-4 text-[#b18f4b]" /><p className="text-sm font-semibold text-[#1d2b2a]">Direitos cadastrados</p></div><div className="max-h-56 overflow-y-auto">{entitlements.data?.truncated ? <p className="m-4 rounded-xl border border-[#ead8ad] bg-[#fff9e9] p-3 text-xs text-[#71531a]">Atenção: direitos limitados por {entitlements.data.truncatedSources.join(", ")}. Exibindo apenas o recorte carregado.</p> : null}{entitlementRows.length ? entitlementRows.map(item => <div key={item.id} className="border-b border-[#f0ece4] px-4 py-3 text-sm last:border-b-0"><p className="font-semibold text-[#1d2b2a]">{contractNumber(item.contractId)} · {item.entitlementType.replace("_", " ")}</p><p className="mt-1 text-xs text-muted-foreground">Prioridade {item.priorityLevel} {item.fixedWeek ? `· Semana ${item.fixedWeek}` : ""} {item.annualPoints ? `· ${item.annualPoints} pontos` : ""}</p></div>) : <p className="p-5 text-sm text-muted-foreground">Nenhum direito cadastrado ainda.</p>}</div></div><div className="rounded-2xl border border-[#e8e3d9]"><div className="flex items-center gap-2 border-b border-[#eee9df] px-4 py-3"><Hammer className="h-4 w-4 text-[#b18f4b]" /><p className="text-sm font-semibold text-[#1d2b2a]">Bloqueios de manutenção</p></div><div className="max-h-56 overflow-y-auto">{maintenance.data?.truncated ? <p className="m-4 rounded-xl border border-[#ead8ad] bg-[#fff9e9] p-3 text-xs text-[#71531a]">Atenção: bloqueios limitados por {maintenance.data.truncatedSources.join(", ")}. Exibindo apenas o recorte carregado.</p> : null}{maintenanceRows.length ? maintenanceRows.map(({ block, unitCode, resortName }) => <div key={block.id} className="border-b border-[#f0ece4] px-4 py-3 text-sm last:border-b-0"><p className="font-semibold text-[#1d2b2a]">{resortName} · {unitCode}</p><p className="mt-1 text-xs text-muted-foreground">{dateLabel(block.startsAt)} → {dateLabel(block.endsAt)} · {block.reason}</p></div>) : <p className="p-5 text-sm text-muted-foreground">Nenhum bloqueio operacional ativo.</p>}</div></div></div>
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
        <div className="grid gap-2"><Label>Contrato vinculado</Label><Select value={contractId} onValueChange={setContractId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Sem vínculo</SelectItem>{contracts.data?.rows?.filter(item => !customerId || item.contract.customerId === Number(customerId)).map(({ contract }) => <SelectItem key={contract.id} value={String(contract.id)}>{contract.number}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-2"><Label>Unidade *</Label><Select value={unitId} onValueChange={setUnitId}><SelectTrigger><SelectValue placeholder="Selecione a unidade" /></SelectTrigger><SelectContent>{units.data?.filter(item => item.unit.status === "active").map(({ unit, resortName }) => <SelectItem key={unit.id} value={String(unit.id)}>{resortName} · {unit.code}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid grid-cols-2 gap-4"><div className="grid gap-2"><Label>Check-in *</Label><Input name="checkIn" type="date" required /></div><div className="grid gap-2"><Label>Check-out *</Label><Input name="checkOut" type="date" required /></div></div>
        <div className="grid grid-cols-2 gap-4"><div className="grid gap-2"><Label>Adultos</Label><Input name="adults" type="number" min="1" defaultValue="1" /></div><div className="grid gap-2"><Label>Crianças</Label><Input name="children" type="number" min="0" defaultValue="0" /></div></div>
        <div className="grid gap-2"><Label>Observações</Label><Textarea name="notes" /></div>
        <Button disabled={create.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">{create.isPending ? "Reservando..." : "Confirmar reserva"}</Button>
      </form>
    </DialogContent>
  </Dialog>;
}

function GuestsDialog({ reservationId, reservationStatus }: { reservationId: number; reservationStatus: "pending" | "confirmed" | "checked_in" | "completed" | "cancelled" }) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const guests = trpc.operations.reservationGuests.useQuery({ reservationId });
  const addGuest = trpc.operations.addReservationGuest.useMutation({ onSuccess: () => { utils.operations.reservationGuests.invalidate({ reservationId }); toast.success("Acompanhante registrado."); }, onError: error => toast.error(error.message) });
  const updatePresence = trpc.operations.updateGuestPresence.useMutation({ onSuccess: () => { utils.operations.reservationGuests.invalidate({ reservationId }); toast.success("Presença do acompanhante atualizada."); }, onError: error => toast.error(error.message) });
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); addGuest.mutate({ reservationId, fullName: String(data.get("fullName") ?? ""), documentNumber: String(data.get("documentNumber") ?? "") || null, relationship: String(data.get("relationship") ?? "") || null, birthDate: String(data.get("birthDate") ?? "") || null }); event.currentTarget.reset(); };
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button size="sm" variant="outline">Acompanhantes</Button></DialogTrigger><DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle className="font-serif text-2xl">Acompanhantes da reserva</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">Cadastre quem viaja e registre a presença individual quando a operação pedir. Sem lista no verso da comanda.</p><form className="grid gap-3 rounded-xl border border-[#e8e3d9] bg-[#faf8f3] p-4 sm:grid-cols-2" onSubmit={submit}><Input name="fullName" required placeholder="Nome completo" /><Input name="documentNumber" placeholder="CPF ou documento" /><Input name="relationship" placeholder="Vínculo: cônjuge, filho..." /><Input name="birthDate" type="date" /><Button className="sm:col-span-2" disabled={addGuest.isPending}>Adicionar acompanhante</Button></form><div className="mt-4 overflow-hidden rounded-xl border border-[#e8e3d9]">{guests.data?.length ? guests.data.map(guest => <div key={guest.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f0ece4] px-4 py-3 text-sm last:border-b-0"><div><p className="font-semibold text-[#1d2b2a]">{guest.fullName}</p><p className="text-xs text-muted-foreground">{guest.relationship || "Acompanhante"}{guest.documentNumber ? ` · ${guest.documentNumber}` : ""}</p></div><div className="flex gap-2">{reservationStatus === "checked_in" && !guest.checkedInAt ? <Button size="sm" variant="outline" onClick={() => updatePresence.mutate({ id: guest.id, action: "check_in" })}>Chegou</Button> : null}{reservationStatus === "checked_in" && guest.checkedInAt && !guest.checkedOutAt ? <Button size="sm" variant="outline" onClick={() => updatePresence.mutate({ id: guest.id, action: "check_out" })}>Saiu</Button> : null}{guest.checkedOutAt ? <span className="text-xs font-semibold text-[#2d675f]">Saída registrada</span> : guest.checkedInAt ? <span className="text-xs font-semibold text-[#2d675f]">Presente</span> : <span className="text-xs text-muted-foreground">Aguardando chegada</span>}</div></div>) : <p className="p-5 text-sm text-muted-foreground">Ainda não há acompanhantes cadastrados.</p>}</div></DialogContent></Dialog>;
}

function WaitlistConversionDialog({ item }: { item: WaitlistOffer }) {
  const [open, setOpen] = useState(false); const [unitId, setUnitId] = useState(""); const utils = trpc.useUtils();
  const availabilityInput = useMemo(() => ({ checkIn: isoDay(new Date(item.desiredCheckIn)), checkOut: isoDay(new Date(item.desiredCheckOut)), resortId: item.resortId ?? undefined }), [item.desiredCheckIn, item.desiredCheckOut, item.resortId]);
  const available = trpc.operations.availableUnits.useQuery(availabilityInput, { enabled: open });
  const convert = trpc.operations.convertWaitlistToReservation.useMutation({ onSuccess: () => { utils.operations.waitlist.invalidate(); utils.operations.reservations.invalidate(); setOpen(false); setUnitId(""); toast.success("Oferta convertida em reserva confirmada."); }, onError: error => toast.error(error.message) });
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button size="sm" className="bg-[#1d2b2a] hover:bg-[#29413e]">Confirmar reserva</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle className="font-serif text-2xl">Converter oferta em reserva</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">Selecione a unidade disponível para o período solicitado. A ação cria a reserva e encerra a posição na fila.</p><div className="grid gap-3 py-2"><div className="rounded-xl bg-[#faf8f3] p-3 text-sm"><p className="font-semibold text-[#1d2b2a]">{dateLabel(item.desiredCheckIn)} → {dateLabel(item.desiredCheckOut)}</p><p className="text-xs text-muted-foreground">{item.partySize} pessoas</p></div><Select value={unitId} onValueChange={setUnitId}><SelectTrigger><SelectValue placeholder={available.isLoading ? "Buscando disponibilidade..." : "Unidade disponível"} /></SelectTrigger><SelectContent>{available.data?.map(({ unit, resortName }) => <SelectItem key={unit.id} value={String(unit.id)}>{resortName} · {unit.code} · até {unit.capacity} hóspedes</SelectItem>)}</SelectContent></Select><Button disabled={!unitId || convert.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]" onClick={() => convert.mutate({ waitlistId: item.id, unitId: Number(unitId) })}>{convert.isPending ? "Confirmando..." : "Criar reserva confirmada"}</Button></div></DialogContent></Dialog>;
}

export default function Reservations() {
  const [reservationSearch, setReservationSearch] = useState("");
  const [reservationStatus, setReservationStatus] = useState<"all" | "pending" | "confirmed" | "checked_in" | "completed" | "cancelled">("all");
  const [waitlistSearch, setWaitlistSearch] = useState("");
  const [waitlistStatus, setWaitlistStatus] = useState<"all" | "waiting" | "offered">("all");
  const debouncedReservationSearch = useDebouncedValue(reservationSearch);
  const debouncedWaitlistSearch = useDebouncedValue(waitlistSearch);
  const units = trpc.operations.units.useQuery();
  const reservations = trpc.operations.reservations.useQuery({
    status: reservationStatus === "all" ? undefined : reservationStatus,
    search: debouncedReservationSearch.trim() || undefined,
  });
  const reservationRows = reservations.data?.rows ?? [];
  const waitlist = trpc.operations.waitlist.useQuery({ search: debouncedWaitlistSearch.trim() || undefined, status: waitlistStatus === "all" ? undefined : waitlistStatus });
  const waitlistRows = waitlist.data?.rows ?? [];
  const utils = trpc.useUtils();
  const updateStatus = trpc.operations.updateReservationStatus.useMutation({
    onSuccess: () => { utils.operations.reservations.invalidate(); toast.success("Status da reserva atualizado."); },
    onError: error => toast.error(error.message),
  });
  const updateWaitlist = trpc.operations.updateWaitlistStatus.useMutation({ onSuccess: () => { utils.operations.waitlist.invalidate(); toast.success("Situação da fila atualizada."); }, onError: error => toast.error(error.message) });
  const days = useMemo(() => Array.from({ length: 8 }, (_, index) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + index); return date; }), []);
  const bookingByUnitDay = useMemo(() => {
    const index = new Map<string, (typeof reservationRows)[number]>();
    for (const item of reservationRows) {
      if (item.reservation.status === "cancelled") continue;
      const checkIn = new Date(item.reservation.checkIn);
      const checkOut = new Date(item.reservation.checkOut);
      for (const day of days) if (checkIn <= day && checkOut > day) index.set(`${item.reservation.unitId}:${isoDay(day)}`, item);
    }
    return index;
  }, [days, reservationRows]);
  return <div className="space-y-8">
    <PageHeader eyebrow="Utilização" title="Reservas & disponibilidade" description="Acompanhe unidades, períodos e hóspedes em um calendário objetivo — sem overbooking de susto às vésperas do check-in." action={<div className="flex flex-wrap gap-2"><InventoryDialog /><OwnershipOperationsDialog /><WaitlistDialog /><NewReservationDialog /></div>} />
    {!units.data?.length ? <EmptyState title="Seu inventário ainda está vazio" body="Cadastre o empreendimento e as unidades primeiro. Depois o calendário começa a trabalhar sem te deixar na mão." action={<InventoryDialog />} /> : <div className="space-y-5">
      <Card className="overflow-hidden rounded-[1.5rem] border-[#e8e3d9]"><CardHeader><div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#b18f4b]">Próximos oito dias</p><CardTitle className="mt-1 font-serif text-2xl text-[#1d2b2a]">Mapa de disponibilidade</CardTitle></div></CardHeader><CardContent className="overflow-x-auto"><div className="min-w-[840px]"><div className="grid grid-cols-[190px_repeat(8,minmax(76px,1fr))] border-b border-[#eee9df] text-center text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground"><div className="p-3 text-left">Unidade</div>{days.map(day => <div key={isoDay(day)} className="border-l border-[#eee9df] p-3">{dayLabel(day)}</div>)}</div>{units.data.map(({ unit, resortName }) => <div key={unit.id} className="grid min-h-16 grid-cols-[190px_repeat(8,minmax(76px,1fr))] border-b border-[#f0ece4] last:border-b-0"><div className="flex flex-col justify-center bg-[#faf8f3] px-3"><span className="text-sm font-semibold text-[#1d2b2a]">{unit.code}</span><span className="text-[11px] text-muted-foreground">{resortName}</span></div>{days.map(day => { const booking = bookingByUnitDay.get(`${unit.id}:${isoDay(day)}`); return <div key={isoDay(day)} className="border-l border-[#f0ece4] p-1.5">{booking ? <div title={booking.customerName} className="h-full min-h-12 rounded-lg bg-[#2d675f] p-1.5 text-[9px] font-semibold leading-tight text-white">{booking.customerName.split(" ")[0]}</div> : <div className="h-full min-h-12 rounded-lg bg-[#eaf0ea]" />}</div>; })}</div>)}</div></CardContent></Card>
      <div className="overflow-hidden rounded-[1.35rem] border border-[#e9e4da] bg-white"><div className="flex flex-col gap-3 border-b border-[#eee9df] bg-[#faf8f3] px-6 py-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b18f4b]">Lista de espera priorizada</p><p className="mt-1 text-sm font-semibold text-[#1d2b2a]">Ofertas pendentes de disponibilidade</p></div><div className="flex flex-col gap-2 sm:flex-row"><Input value={waitlistSearch} onChange={event => setWaitlistSearch(event.target.value)} placeholder="Buscar associado ou resort" className="w-full sm:w-56" /><Select value={waitlistStatus} onValueChange={value => setWaitlistStatus(value as typeof waitlistStatus)}><SelectTrigger className="w-full sm:w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Ativas</SelectItem><SelectItem value="waiting">Aguardando</SelectItem><SelectItem value="offered">Ofertadas</SelectItem></SelectContent></Select></div><span className="text-xs text-muted-foreground">{waitlistRows.length}{waitlist.data?.truncated ? "+" : ""} na fila</span></div>{waitlist.data?.truncated ? <p className="mx-6 mt-4 rounded-xl border border-[#ead8ad] bg-[#fff9e9] p-3 text-xs text-[#71531a]">Atenção: fila limitada por {waitlist.data.truncatedSources.join(", ")}. A lista exibida é apenas o recorte priorizado.</p> : null}{waitlistRows.length ? waitlistRows.map(({ item, customerName, resortName }) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f0ece4] px-6 py-4 text-sm last:border-b-0"><div><p className="font-semibold text-[#1d2b2a]">{customerName} · prioridade {item.priorityScore}</p><p className="text-xs text-muted-foreground">{resortName || "Qualquer empreendimento"} · {dateLabel(item.desiredCheckIn)} → {dateLabel(item.desiredCheckOut)} · {item.partySize} pessoas</p></div><div className="flex items-center gap-2"><StatusPill value={item.status} />{item.status === "waiting" ? <Button size="sm" variant="outline" onClick={() => updateWaitlist.mutate({ id: item.id, status: "offered" })}>Ofertar vaga</Button> : <WaitlistConversionDialog item={item} />}</div></div>) : <div className="p-6 text-sm text-muted-foreground">{waitlistSearch.trim() || waitlistStatus !== "all" ? "Nenhuma posição encontrada neste filtro." : "Nenhum associado aguardando vaga."}</div>}</div>
      <div className="overflow-hidden rounded-[1.35rem] border border-[#e9e4da] bg-white"><div className="flex flex-col gap-3 border-b border-[#eee9df] bg-[#faf8f3] px-6 py-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b18f4b]">Recorte operacional</p><p className="mt-1 text-sm font-semibold text-[#1d2b2a]">Busque por hóspede, unidade ou contrato</p></div><div className="flex flex-col gap-2 sm:flex-row"><Input value={reservationSearch} onChange={event => setReservationSearch(event.target.value)} placeholder="Pesquisar reserva" className="w-full sm:w-56" /><Select value={reservationStatus} onValueChange={value => setReservationStatus(value as typeof reservationStatus)}><SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos os status</SelectItem><SelectItem value="pending">Pendentes</SelectItem><SelectItem value="confirmed">Confirmadas</SelectItem><SelectItem value="checked_in">Em hospedagem</SelectItem><SelectItem value="completed">Concluídas</SelectItem><SelectItem value="cancelled">Canceladas</SelectItem></SelectContent></Select></div></div><div className="grid grid-cols-[1.35fr_1fr_1fr_1fr_auto_auto] gap-4 border-b border-[#eee9df] bg-[#faf8f3] px-6 py-3 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground"><span>Hóspede</span><span>Unidade</span><span>Período</span><span>Contrato</span><span>Status</span><span>Ação</span></div>{reservations.data?.truncated ? <p className="mx-6 mt-4 rounded-xl border border-[#ead8ad] bg-[#fff9e9] p-3 text-xs text-[#71531a]">Atenção: reservas limitadas por {reservations.data.truncatedSources.join(", ")}. A lista e o calendário cobrem apenas o recorte carregado.</p> : null}{reservationRows.length ? reservationRows.map(({ reservation, customerName, unitCode, resortName, contractNumber }) => <div key={reservation.id} className="grid grid-cols-[1.35fr_1fr_1fr_1fr_auto_auto] items-center gap-4 px-6 py-4 text-sm hover:bg-[#fdfcf9]"><span className="font-semibold text-[#1d2b2a]">{customerName}</span><span>{resortName} · {unitCode}</span><span className="text-xs text-muted-foreground">{dateLabel(reservation.checkIn)} → {dateLabel(reservation.checkOut)}</span><span>{contractNumber || "—"}</span><StatusPill value={reservation.status} /><div className="flex flex-wrap gap-2"><GuestsDialog reservationId={reservation.id} reservationStatus={reservation.status} />{reservation.status === "confirmed" ? <Button size="sm" variant="outline" onClick={() => updateStatus.mutate({ id: reservation.id, status: "checked_in" })}>Check-in</Button> : reservation.status === "checked_in" ? <Button size="sm" className="bg-[#1d2b2a] hover:bg-[#29413e]" onClick={() => updateStatus.mutate({ id: reservation.id, status: "completed" })}>Check-out</Button> : null}</div></div>) : <div className="p-8 text-center text-sm text-muted-foreground">{reservationSearch.trim() || reservationStatus !== "all" ? "Nenhuma reserva encontrada neste filtro." : "Nenhuma reserva criada ainda."}</div>}</div>
    </div>}
  </div>;
}
