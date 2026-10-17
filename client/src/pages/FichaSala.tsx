import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader } from "@/components/crm/ui";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
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
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "seller";
  const isAdmin = user?.role === "admin";
  const sheet = trpc.captureSheet.byCode.useQuery({ code });
  const roles = trpc.captureSheet.roles.list.useQuery();
  const [roleId, setRoleId] = useState("");
  const [person, setPerson] = useState("");
  const [extras, setExtras] = useState({ secondVehicleModel: "", secondVehicleYear: "", guest1Name: "", guest2Name: "", pepOfferedBy: "", captureKind: "" });
  const saved = sheet.data?.capture;
  const savedKey = saved ? `${sheet.data?.captureId}|${saved.secondVehicleModel}|${saved.secondVehicleYear}|${saved.guest1Name}|${saved.guest2Name}|${saved.pepOfferedBy}|${saved.captureKind}` : "";
  // Mostra o que já está gravado nos campos da sala; recarrega quando a ficha muda no servidor.
  useEffect(() => { if (saved) setExtras({ secondVehicleModel: saved.secondVehicleModel ?? "", secondVehicleYear: saved.secondVehicleYear ? String(saved.secondVehicleYear) : "", guest1Name: saved.guest1Name ?? "", guest2Name: saved.guest2Name ?? "", pepOfferedBy: saved.pepOfferedBy ?? "", captureKind: saved.captureKind ?? "" }); }, [savedKey]);
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
      <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#b18f4b]">{data.sheetSettings.brandName ? `${data.sheetSettings.brandName} · ` : ""}Ficha de atendimento</p><p className="text-xs">Promotor: {text(team.promoter ?? team.members.find(member => member.code === "promotor_marketing")?.name)}</p><h2 className="font-serif text-2xl">{customer.fullName}</h2><p className="text-sm">{text(customer.phone)}{data.contacts.filter(contact => contact.kind !== "email")[0] ? ` / ${data.contacts.filter(contact => contact.kind !== "email")[0].value}` : ""} · {text(customer.city)}{customer.state ? `/${customer.state}` : ""}</p></div>
        <div className="text-center"><p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#6b756f]">Código do casal</p><p aria-label={`Código do casal ${code}`} className="font-mono text-3xl font-bold tracking-wider">{code}</p><div className="mt-2 flex h-28 w-28 items-center justify-center rounded border border-dashed border-[#c9c2b2] p-1 text-[10px] text-[#6b756f] ml-auto">Cole aqui o QR da recepção</div></div></div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 sm:grid-cols-3">
        <Field label="Sala" value={text(capture.salesRoom)} /><Field label="Ficha criada em" value={when(capture.createdAt)} /><Field label="CPF" value={text(customer.documentNumber)} /><Field label="Check-in" value={when(capture.checkedInAt)} />
        <Field label="Ordem de chegada" value={text(derived.arrivalOrder)} /><Field label="Local de captação" value={text(capture.captureLocation)} /><Field label="Locomoção" value={text(capture.transportation)} />
        <Field label="Cônjuge" value={text(capture.partnerName)} /><Field label="Idade do cônjuge" value={text(capture.partnerAge)} /><Field label="Relacionamento" value={`${text(capture.relationshipStatus)}${derived.relationshipDays != null ? ` · ${derived.relationshipDays} dias` : ""}`} />
        <Field label="Renda média mensal" value={capture.averageIncome ? Number(capture.averageIncome).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—"} /><Field label="Filhos" value={text(capture.childrenCount)} /><Field label="Aposentado (titular)" value={yesNo(capture.retiredPrimary)} /><Field label="Aposentado (cônjuge)" value={yesNo(capture.retiredPartner)} />
        <Field label="Veículo" value={[capture.vehicleBrand, capture.vehicleModel, capture.vehicleYear].filter(Boolean).join(" ") || "—"} /><Field label="2º veículo" value={[capture.secondVehicleModel, capture.secondVehicleYear].filter(Boolean).join(" ") || "—"} /><Field label="Hospedagem" value={text(capture.lodgingLocation)} />
        <Field label="Idade do titular" value={text(customer.age)} /><Field label="Profissão do titular" value={`${text(customer.occupation)}${capture.primaryProfessionNotes ? ` · ${capture.primaryProfessionNotes}` : ""}`} /><Field label="Profissão do cônjuge" value={`${text(capture.partnerProfession)}${capture.partnerProfessionNotes ? ` · ${capture.partnerProfessionNotes}` : ""}`} />
        <Field label="Tipo de captação" value={text(capture.captureKind)} /><Field label="E-mail" value={text(customer.email ?? data.contacts.find(contact => contact.kind === "email")?.value)} /><Field label="Telefone 2" value={text(data.contacts.find(contact => contact.kind !== "email")?.value)} />
        <Field label="Nomes dos filhos" value={text(capture.childrenNames)} /><Field label="Tipo do veículo" value={[capture.vehicleKind, capture.secondVehicleKind].filter(Boolean).join(" / ") || "—"} /><Field label="Cônjuge homem" value={capture.maleSpouse === "titular" ? "Titular" : capture.maleSpouse === "conjuge" ? "Cônjuge" : "—"} />
        <Field label="Trabalha com cartão de crédito" value={yesNo(capture.hasCreditCard)} /><Field label="Casa própria" value={yesNo(capture.ownsHome)} /><Field label="Imóvel na cidade" value={yesNo(capture.ownsPropertyInCity)} />
        <Field label="Últimos destinos de férias" value={text(capture.lastTrip)} /><Field label="Viagem dos sonhos" value={text(capture.dreamTrips)} /><Field label="Já assistiu apresentação de férias" value={yesNo(capture.watchedVacationPresentation)} />
        <Field label="Brindes" value={data.gifts.length ? data.gifts.join("; ") : text(capture.giftDescription)} />
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
      <div className="mt-3 h-24 rounded border border-dashed border-[#c9c2b2]" aria-label="Espaço para anotação à mão" />
      <p className="mt-3 text-[10px] leading-snug text-[#1d2b2a]"><b>Termo de ciência (texto provisório, a aprovar):</b> declaro estar ciente de que a apresentação tem duração mínima de {data.sheetSettings.minPresentationMinutes} minutos, contados da chegada do consultor, e de que a liberação da cortesia está vinculada a esse tempo.</p>
      <p className="mt-3 text-[10px] leading-snug text-[#6b756f]">Aviso de privacidade (texto provisório, a aprovar): seus dados, incluindo CPF e renda, são usados para o atendimento e a proposta comercial desta visita e ficam guardados com segurança. Esta ficha em papel deve ser devolvida à gerência no fim do dia. Pedidos sobre seus dados: fale com a recepção.</p>
      <div className="mt-6 grid grid-cols-2 gap-8 text-xs"><div className="border-t border-[#1d2b2a] pt-1">Ciente do casal (assinatura)</div><div className="border-t border-[#1d2b2a] pt-1">Gerente de sala</div></div>
    </div>
    <Card className="border-[#e8e1d4]"><CardContent className="space-y-2 p-5" aria-label="Casal qualificado">
      <p className="text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">Casal qualificado (cálculo provisório, o gerente confirma)</p>
      <p className="text-lg font-semibold" data-testid="nq-label">{data.nq.label}</p>
      <p className="text-sm text-muted-foreground">{data.nq.outcome === "qualificado" ? "Nenhum item de NQ." : data.nq.outcome === "nq_aceito" ? "Entra com NQ (dentro do limite). Confirme com o gerente." : "Acima do limite de NQ: cai como NT por perfil, se o gerente confirmar."}</p>
      <ul className="space-y-1 text-sm">{data.nq.criteria.map(criterion => <li key={criterion.key}><b>{criterion.status === "ok" ? "OK" : criterion.status === "nq" ? "NQ" : "Faltando"}</b> · {criterion.label} <span className="text-muted-foreground">({criterion.detail})</span></li>)}</ul>
    </CardContent></Card>
    {canEdit ? <Card className="border-[#e8e1d4]"><CardContent className="space-y-4 p-5">
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
        <div className="grid gap-1"><Label htmlFor="ficha-capture-kind">Tipo de captação</Label><Input id="ficha-capture-kind" value={extras.captureKind} onChange={event => setExtras({ ...extras, captureKind: event.target.value })} placeholder="Ex.: tour direto" /></div>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <label className="grid gap-1">Qual cônjuge é o homem<select aria-label="Cônjuge homem" className="rounded border px-2 py-1 text-sm" value={capture.maleSpouse ?? ""} onChange={event => updateExtras.mutate({ captureId: data.captureId, maleSpouse: event.target.value ? (event.target.value as "titular" | "conjuge") : null })}><option value="">Não informado</option><option value="titular">Titular</option><option value="conjuge">Cônjuge</option></select></label>
        <label className="grid gap-1">Veículo é<select aria-label="Tipo do veículo" className="rounded border px-2 py-1 text-sm" value={capture.vehicleKind ?? ""} onChange={event => updateExtras.mutate({ captureId: data.captureId, vehicleKind: event.target.value ? (event.target.value as "carro" | "moto") : null })}><option value="">Não informado</option><option value="carro">Carro</option><option value="moto">Moto</option></select></label>
        <label className="grid gap-1">2º veículo é<select aria-label="Tipo do 2º veículo" className="rounded border px-2 py-1 text-sm" value={capture.secondVehicleKind ?? ""} onChange={event => updateExtras.mutate({ captureId: data.captureId, secondVehicleKind: event.target.value ? (event.target.value as "carro" | "moto") : null })}><option value="">Não informado</option><option value="carro">Carro</option><option value="moto">Moto</option></select></label>
        <span className="inline-flex items-center gap-1">Já assistiu apresentação de férias: <b>{yesNo(capture.watchedVacationPresentation)}</b><Button size="sm" variant="outline" disabled={capture.watchedVacationPresentation === true} onClick={() => updateExtras.mutate({ captureId: data.captureId, watchedVacationPresentation: true })}>Sim</Button><Button size="sm" variant="outline" disabled={capture.watchedVacationPresentation === false} onClick={() => updateExtras.mutate({ captureId: data.captureId, watchedVacationPresentation: false })}>Não</Button></span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => updateExtras.mutate({ captureId: data.captureId, secondVehicleModel: extras.secondVehicleModel, secondVehicleYear: extras.secondVehicleYear ? Number(extras.secondVehicleYear) : null, guest1Name: extras.guest1Name, guest2Name: extras.guest2Name, captureKind: extras.captureKind })} disabled={updateExtras.isPending}>Salvar campos</Button>
        <span className="inline-flex items-center gap-1 text-xs">Titular aposentado: <b>{yesNo(capture.retiredPrimary)}</b><Button size="sm" variant="outline" disabled={capture.retiredPrimary === true} onClick={() => updateExtras.mutate({ captureId: data.captureId, retiredPrimary: true })}>Sim</Button><Button size="sm" variant="outline" disabled={capture.retiredPrimary === false} onClick={() => updateExtras.mutate({ captureId: data.captureId, retiredPrimary: false })}>Não</Button></span>
        <span className="inline-flex items-center gap-1 text-xs">Cônjuge aposentado: <b>{yesNo(capture.retiredPartner)}</b><Button size="sm" variant="outline" disabled={capture.retiredPartner === true} onClick={() => updateExtras.mutate({ captureId: data.captureId, retiredPartner: true })}>Sim</Button><Button size="sm" variant="outline" disabled={capture.retiredPartner === false} onClick={() => updateExtras.mutate({ captureId: data.captureId, retiredPartner: false })}>Não</Button></span>
        <Button variant="outline" onClick={() => updateExtras.mutate({ captureId: data.captureId, pepOffered: true, pepOfferedBy: extras.pepOfferedBy })}>Registrar oferta de PEP</Button>
        <Button variant="outline" disabled={capture.pepOffered === false} onClick={() => updateExtras.mutate({ captureId: data.captureId, pepOffered: false })}>Sem oferta de PEP</Button>
        <Button variant="outline" disabled={!capture.pepOffered} onClick={() => updateExtras.mutate({ captureId: data.captureId, pepResult: "accepted" })}>PEP aceito</Button>
        <Button variant="outline" disabled={!capture.pepOffered} onClick={() => updateExtras.mutate({ captureId: data.captureId, pepResult: "declined" })}>PEP recusado</Button>
      </div>
    </CardContent></Card> : null}
    {isAdmin ? <><TrocarCodigo captureId={data.captureId} onDone={newCode => { window.location.href = `/ficha?codigo=${encodeURIComponent(newCode)}`; }} /><PapeisAdmin /><LimitesAdmin /></> : null}
  </div>;
}

function TrocarCodigo({ captureId, onDone }: { captureId: number; onDone: (code: string) => void }) {
  const [code, setCode] = useState("");
  const change = trpc.captureSheet.setCoupleCode.useMutation({ onSuccess: result => { toast.success("Código trocado."); onDone(result.code); }, onError: error => toast.error(error.message) });
  return <Card className="border-[#e8e1d4]"><CardContent className="flex flex-wrap items-end gap-3 p-5">
    <div className="grid gap-1"><Label htmlFor="ficha-new-code">Corrigir código do casal (só administração)</Label><Input id="ficha-new-code" className="w-64" value={code} onChange={event => setCode(event.target.value)} /></div>
    <Button variant="outline" disabled={change.isPending || code.trim().length < 4} onClick={() => change.mutate({ captureId, coupleCode: code })}>Trocar código</Button>
    <p className="w-full text-xs text-muted-foreground">Fichas já impressas com o código antigo deixam de abrir por ele. A troca fica na trilha.</p>
  </CardContent></Card>;
}

function PapeisAdmin() {
  const utils = trpc.useUtils();
  const roles = trpc.captureSheet.roles.list.useQuery({ includeInactive: true });
  const [form, setForm] = useState({ code: "", label: "", kind: "support" as "presentation" | "support" });
  const refresh = () => { void utils.captureSheet.roles.list.invalidate(); };
  const upsert = trpc.captureSheet.roles.upsert.useMutation({ onSuccess: () => { toast.success("Papéis atualizados."); setForm({ code: "", label: "", kind: "support" }); refresh(); }, onError: error => toast.error(error.message) });
  return <Card className="border-[#e8e1d4]"><CardContent className="space-y-3 p-5">
    <p className="text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">Papéis da equipe (administração)</p>
    <ul className="space-y-1 text-sm">{(roles.data ?? []).map(role => <li key={role.id} className="flex items-center justify-between gap-3"><span className={role.active ? "" : "text-muted-foreground line-through"}>{role.label} <span className="text-xs text-muted-foreground">({role.code} · {role.kind === "support" ? "apoio" : "atendimento"})</span></span><Button size="sm" variant="outline" onClick={() => upsert.mutate({ id: role.id, code: role.code, label: role.label, kind: role.kind, sortOrder: role.sortOrder, active: !role.active })}>{role.active ? "Desativar" : "Reativar"}</Button></li>)}</ul>
    <div className="flex flex-wrap items-end gap-3 border-t border-[#ece6da] pt-3">
      <div className="grid gap-1"><Label htmlFor="role-code">Código (a-z, 0-9, _)</Label><Input id="role-code" className="w-44" value={form.code} onChange={event => setForm({ ...form, code: event.target.value })} /></div>
      <div className="grid gap-1"><Label htmlFor="role-label">Nome do papel</Label><Input id="role-label" className="w-56" value={form.label} onChange={event => setForm({ ...form, label: event.target.value })} /></div>
      <Button disabled={upsert.isPending || form.code.trim().length < 2 || form.label.trim().length < 2} onClick={() => upsert.mutate({ code: form.code, label: form.label, kind: form.kind, sortOrder: 500, active: true })}>Criar papel</Button>
    </div>
  </CardContent></Card>;
}

function LigarCodigo({ captureId }: { captureId: number }) {
  const { user } = useAuth();
  const canLink = user?.role === "admin" || user?.role === "seller";
  const utils = trpc.useUtils();
  const current = trpc.captureSheet.codeOf.useQuery({ captureId });
  const [code, setCode] = useState("");
  const link = trpc.captureSheet.setCoupleCode.useMutation({ onSuccess: () => { toast.success("Código ligado à ficha."); void utils.captureSheet.codeOf.invalidate({ captureId }); }, onError: error => toast.error(error.message) });
  if (current.isLoading) return <p className="text-sm text-muted-foreground">Carregando...</p>;
  if (current.data?.coupleCode) return <FichaImpressa code={current.data.coupleCode} />;
  if (!canLink) return <Card className="border-[#e8e1d4]"><CardContent className="p-5"><p className="text-sm">Esta ficha ainda não tem o código do casal. Peça para o gerente ou o vendedor ligar o código.</p></CardContent></Card>;
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

const settingLabels: Array<{ key: "nq_min_man_age" | "nq_min_relationship_months" | "nq_min_vehicle_year" | "nq_min_income" | "nq_max_items_accepted" | "min_presentation_minutes"; label: string; pick: (s: { nq: { minManAge: number; minRelationshipMonths: number; minVehicleYear: number; minIncome: number; maxItemsAccepted: number }; minPresentationMinutes: number }) => number }> = [
  { key: "nq_min_man_age", label: "Idade do homem acima de (anos)", pick: s => s.nq.minManAge },
  { key: "nq_min_relationship_months", label: "Relacionamento acima de (meses)", pick: s => s.nq.minRelationshipMonths },
  { key: "nq_min_vehicle_year", label: "Carro a partir do ano", pick: s => s.nq.minVehicleYear },
  { key: "nq_min_income", label: "Renda a partir de (R$)", pick: s => s.nq.minIncome },
  { key: "nq_max_items_accepted", label: "Itens de NQ que ainda entram", pick: s => s.nq.maxItemsAccepted },
  { key: "min_presentation_minutes", label: "Mínimo da apresentação (minutos, termo)", pick: s => s.minPresentationMinutes },
];

function LimitesAdmin() {
  const utils = trpc.useUtils();
  const settings = trpc.captureSheet.settings.get.useQuery();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = trpc.captureSheet.settings.set.useMutation({ onSuccess: () => { toast.success("Limite atualizado."); void utils.captureSheet.settings.get.invalidate(); void utils.captureSheet.byCode.invalidate(); }, onError: error => toast.error(error.message) });
  if (!settings.data) return null;
  return <Card className="border-[#e8e1d4]"><CardContent className="space-y-3 p-5">
    <p className="text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">Limites provisórios do casal qualificado e do termo (administração)</p>
    <div className="grid gap-3 sm:grid-cols-3">{settingLabels.map(item => <div key={item.key} className="grid gap-1"><Label htmlFor={`limit-${item.key}`}>{item.label}</Label><div className="flex gap-2"><Input id={`limit-${item.key}`} type="number" value={draft[item.key] ?? String(item.pick(settings.data))} onChange={event => setDraft({ ...draft, [item.key]: event.target.value })} /><Button size="sm" variant="outline" disabled={save.isPending || draft[item.key] == null} onClick={() => save.mutate({ key: item.key, value: draft[item.key] })}>Salvar</Button></div></div>)}</div>
    <div className="flex flex-wrap items-end gap-2 border-t border-[#ece6da] pt-3"><div className="grid gap-1"><Label htmlFor="limit-brand">Marca no cabeçalho da ficha</Label><Input id="limit-brand" className="w-64" value={draft.brand_name ?? settings.data.brandName} onChange={event => setDraft({ ...draft, brand_name: event.target.value })} /></div><Button size="sm" variant="outline" disabled={save.isPending || draft.brand_name == null} onClick={() => save.mutate({ key: "brand_name", value: draft.brand_name })}>Salvar marca</Button></div>
    <p className="text-xs text-muted-foreground">Tudo provisório até o Lucas homologar. Cada troca fica na trilha com o valor antigo e o novo.</p>
  </CardContent></Card>;
}
