import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader } from "@/components/crm/ui";
import { trpc } from "@/lib/trpc";
import { Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { toast } from "sonner";

const when = (value?: string | Date | null) => (value ? new Date(value).toLocaleString("pt-BR") : "—");
const yesNo = (value?: boolean | null) => (value == null ? "—" : value ? "Sim" : "Não");
const text = (value?: string | number | null) => (value == null || value === "" ? "—" : String(value));

const printCss = `@media print { body * { visibility: hidden !important; } #ficha-print, #ficha-print * { visibility: visible !important; } #ficha-print { position: absolute; left: 0; top: 0; width: 100%; padding: 12mm; box-sizing: border-box; } @page { size: A4; margin: 0; } }`;

function Field({ label, value }: { label: string; value: string }) {
  return <div className="border-b border-[#d9d2c2] py-1.5"><p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#6b756f]">{label}</p><p className="min-h-5 text-sm text-[#1d2b2a]">{value}</p></div>;
}

function FichaImpressa({ code }: { code: string }) {
  const utils = trpc.useUtils();
  const sheet = trpc.captureSheet.byCode.useQuery({ code });
  const roles = trpc.captureSheet.roles.list.useQuery();
  const [roleId, setRoleId] = useState("");
  const [person, setPerson] = useState("");
  const [extras, setExtras] = useState({ secondVehicleModel: "", secondVehicleYear: "", guest1Name: "", guest2Name: "", pepOfferedBy: "" });
  const saved = sheet.data?.capture;
  const savedKey = saved ? `${sheet.data?.captureId}|${saved.secondVehicleModel}|${saved.secondVehicleYear}|${saved.guest1Name}|${saved.guest2Name}|${saved.pepOfferedBy}` : "";
  // Mostra o que já está gravado nos campos da sala; recarrega quando a ficha muda no servidor.
  useEffect(() => { if (saved) setExtras({ secondVehicleModel: saved.secondVehicleModel ?? "", secondVehicleYear: saved.secondVehicleYear ? String(saved.secondVehicleYear) : "", guest1Name: saved.guest1Name ?? "", guest2Name: saved.guest2Name ?? "", pepOfferedBy: saved.pepOfferedBy ?? "" }); }, [savedKey]);
  const refresh = () => utils.captureSheet.byCode.invalidate({ code });
  const fail = (error: { message: string }) => toast.error(error.message);
  const recordPrint = trpc.captureSheet.recordPrint.useMutation({ onSuccess: () => { void refresh(); }, onError: fail });
  const setMember = trpc.captureSheet.team.set.useMutation({ onSuccess: () => { setPerson(""); toast.success("Equipe atualizada."); void refresh(); }, onError: fail });
  const clearMember = trpc.captureSheet.team.clear.useMutation({ onSuccess: () => { void refresh(); }, onError: fail });
  const updateExtras = trpc.captureSheet.updateExtras.useMutation({ onSuccess: () => { toast.success("Ficha atualizada."); void refresh(); }, onError: fail });
  if (sheet.isLoading) return <p className="text-sm text-muted-foreground">Carregando a ficha...</p>;
  if (!sheet.data) return <EmptyState title="Ficha não encontrada" body={sheet.error?.message ?? "Nenhuma ficha com este código."} />;
  const data = sheet.data;
  const { capture, customer, team, derived } = data;
  const print = async () => { await recordPrint.mutateAsync({ code }); window.print(); };
  return <div className="space-y-6">
    <style>{printCss}</style>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">{data.printCount ? `Impressa ${data.printCount}x. Uma nova impressão fica registrada como reimpressão.` : "Ainda não impressa."}</p>
      <Button onClick={print} disabled={recordPrint.isPending}><Printer className="mr-2 h-4 w-4" />{data.printCount ? "Reimprimir ficha" : "Imprimir ficha"}</Button>
    </div>
    <div id="ficha-print" className="rounded-xl border border-[#e8e1d4] bg-white p-6 text-[#1d2b2a]">
      <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#b18f4b]">Ficha de atendimento</p><h2 className="font-serif text-2xl">{customer.fullName}</h2><p className="text-sm">{text(customer.phone)} · {text(customer.city)}{customer.state ? `/${customer.state}` : ""}</p></div>
        <div className="text-center"><p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#6b756f]">Código do casal</p><p aria-label={`Código do casal ${code}`} className="font-mono text-3xl font-bold tracking-wider">{code}</p><div className="mt-2 flex h-28 w-28 items-center justify-center rounded border border-dashed border-[#c9c2b2] p-1 text-[10px] text-[#6b756f] ml-auto">Cole aqui o QR da recepção</div></div></div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 sm:grid-cols-3">
        <Field label="Sala" value={text(capture.salesRoom)} /><Field label="Agendada" value={when(capture.scheduledAt)} /><Field label="Check-in" value={when(capture.checkedInAt)} />
        <Field label="Ordem de chegada" value={text(derived.arrivalOrder)} /><Field label="Local de captação" value={text(capture.captureLocation)} /><Field label="Locomoção" value={text(capture.transportation)} />
        <Field label="Cônjuge" value={text(capture.partnerName)} /><Field label="Idade do cônjuge" value={text(capture.partnerAge)} /><Field label="Relacionamento" value={`${text(capture.relationshipStatus)}${derived.relationshipDays != null ? ` · ${derived.relationshipDays} dias` : ""}`} />
        <Field label="Filhos" value={text(capture.childrenCount)} /><Field label="Aposentado (titular)" value={yesNo(capture.retiredPrimary)} /><Field label="Aposentado (cônjuge)" value={yesNo(capture.retiredPartner)} />
        <Field label="Veículo" value={[capture.vehicleBrand, capture.vehicleModel, capture.vehicleYear].filter(Boolean).join(" ") || "—"} /><Field label="2º veículo" value={[capture.secondVehicleModel, capture.secondVehicleYear].filter(Boolean).join(" ") || "—"} /><Field label="Hospedagem" value={text(capture.lodgingLocation)} />
        <Field label="Convidado 1" value={text(capture.guest1Name)} /><Field label="Convidado 2" value={text(capture.guest2Name)} /><Field label="Oferta de PEP" value={capture.pepOffered == null ? "—" : capture.pepOffered ? `Sim · ${text(capture.pepOfferedBy)} · ${capture.pepResult === "accepted" ? "aceitou" : capture.pepResult === "declined" ? "recusou" : "sem resultado"}` : "Não"} />
      </div>
      <p className="mt-4 text-[10px] font-bold uppercase tracking-[.1em] text-[#6b756f]">Equipe</p>
      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
        <Field label="Promotor" value={text(team.promoter)} /><Field label="Qualificador" value={text(team.qualifier)} /><Field label="Liner (consultor)" value={text(team.liner)} />
        <Field label="Closer (fechador)" value={text(team.closer)} /><Field label="Gerente de sala" value={text(team.roomManager)} />
        {team.members.map(member => <Field key={member.roleId} label={member.label} value={text(member.name)} />)}
      </div>
      <p className="mt-4 text-[10px] font-bold uppercase tracking-[.1em] text-[#6b756f]">Observações</p>
      <p className="whitespace-pre-wrap text-sm">{text(capture.notes)}</p>
      <div className="mt-3 h-32 rounded border border-dashed border-[#c9c2b2]" aria-label="Espaço para anotação à mão" />
    </div>
    <Card className="border-[#e8e1d4]"><CardContent className="space-y-4 p-5">
      <p className="text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">Equipe por papel</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1"><Label>Papel</Label><Select value={roleId || undefined} onValueChange={setRoleId}><SelectTrigger className="w-60"><SelectValue placeholder="Escolha o papel" /></SelectTrigger><SelectContent>{(roles.data ?? []).map(role => <SelectItem key={role.id} value={String(role.id)}>{role.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-1"><Label htmlFor="ficha-person-name">Nome da pessoa</Label><Input id="ficha-person-name" className="w-64" value={person} onChange={event => setPerson(event.target.value)} /></div>
        <Button disabled={!roleId || !person.trim() || setMember.isPending} onClick={() => setMember.mutate({ captureId: data.captureId, roleId: Number(roleId), personName: person })}>Atribuir</Button>
        {roleId && team.members.some(member => member.roleId === Number(roleId)) ? <Button variant="outline" onClick={() => clearMember.mutate({ captureId: data.captureId, roleId: Number(roleId) })}>Liberar papel</Button> : null}
      </div>
      <p className="border-t border-[#ece6da] pt-4 text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">Campos da sala</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1"><Label>2º veículo (modelo)</Label><Input value={extras.secondVehicleModel} onChange={event => setExtras({ ...extras, secondVehicleModel: event.target.value })} /></div>
        <div className="grid gap-1"><Label>2º veículo (ano)</Label><Input type="number" value={extras.secondVehicleYear} onChange={event => setExtras({ ...extras, secondVehicleYear: event.target.value })} /></div>
        <div className="grid gap-1"><Label>PEP oferecido por</Label><Input value={extras.pepOfferedBy} onChange={event => setExtras({ ...extras, pepOfferedBy: event.target.value })} /></div>
        <div className="grid gap-1"><Label>Convidado 1</Label><Input value={extras.guest1Name} onChange={event => setExtras({ ...extras, guest1Name: event.target.value })} /></div>
        <div className="grid gap-1"><Label>Convidado 2</Label><Input value={extras.guest2Name} onChange={event => setExtras({ ...extras, guest2Name: event.target.value })} /></div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => updateExtras.mutate({ captureId: data.captureId, secondVehicleModel: extras.secondVehicleModel, secondVehicleYear: extras.secondVehicleYear ? Number(extras.secondVehicleYear) : null, guest1Name: extras.guest1Name, guest2Name: extras.guest2Name })} disabled={updateExtras.isPending}>Salvar campos</Button>
        <Button variant="outline" onClick={() => updateExtras.mutate({ captureId: data.captureId, retiredPrimary: !capture.retiredPrimary })}>Titular aposentado: {yesNo(capture.retiredPrimary)}</Button>
        <Button variant="outline" onClick={() => updateExtras.mutate({ captureId: data.captureId, retiredPartner: !capture.retiredPartner })}>Cônjuge aposentado: {yesNo(capture.retiredPartner)}</Button>
        <Button variant="outline" onClick={() => updateExtras.mutate({ captureId: data.captureId, pepOffered: true, pepOfferedBy: extras.pepOfferedBy || undefined })}>Registrar oferta de PEP</Button>
        <Button variant="outline" disabled={!capture.pepOffered} onClick={() => updateExtras.mutate({ captureId: data.captureId, pepResult: "accepted" })}>PEP aceito</Button>
        <Button variant="outline" disabled={!capture.pepOffered} onClick={() => updateExtras.mutate({ captureId: data.captureId, pepResult: "declined" })}>PEP recusado</Button>
      </div>
    </CardContent></Card>
  </div>;
}

function LigarCodigo({ captureId }: { captureId: number }) {
  const utils = trpc.useUtils();
  const current = trpc.captureSheet.codeOf.useQuery({ captureId });
  const [code, setCode] = useState("");
  const link = trpc.captureSheet.setCoupleCode.useMutation({ onSuccess: () => { toast.success("Código ligado à ficha."); void utils.captureSheet.codeOf.invalidate({ captureId }); }, onError: error => toast.error(error.message) });
  if (current.isLoading) return <p className="text-sm text-muted-foreground">Carregando...</p>;
  if (current.data?.coupleCode) return <FichaImpressa code={current.data.coupleCode} />;
  return <Card className="border-[#e8e1d4]"><CardContent className="space-y-3 p-5">
    <p className="text-sm">Esta ficha ainda não tem o código do casal. Leia o QR do casal (o mesmo do Sales Command) ou digite o código abaixo.</p>
    <div className="flex flex-wrap items-end gap-3"><div className="grid gap-1"><Label htmlFor="ficha-couple-code">Código do casal</Label><Input id="ficha-couple-code" className="w-64" value={code} onChange={event => setCode(event.target.value)} /></div><Button disabled={link.isPending || code.trim().length < 4} onClick={() => link.mutate({ captureId, coupleCode: code })}>Ligar à ficha</Button></div>
  </CardContent></Card>;
}

export default function FichaSala() {
  const params = new URLSearchParams(useSearch());
  const code = params.get("codigo");
  const captureId = Number(params.get("captura"));
  return <div className="space-y-6">
    <PageHeader eyebrow="Controle de sala" title="Ficha impressa" description="Ficha A4 do casal com o código do casal e espaço para o QR da recepção, equipe por papel e campos da sala. A impressão e a reimpressão ficam registradas." />
    {code ? <FichaImpressa code={code} /> : Number.isInteger(captureId) && captureId > 0 ? <LigarCodigo captureId={captureId} /> : <EmptyState title="Ficha não informada" body="Abra a ficha pela fila de captação." />}
  </div>;
}
