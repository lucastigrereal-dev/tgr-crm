import { PageHeader } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";

type SettingsForm = { cancellationPolicy: string; requiredCaptureFields: string; requiredContractDocuments: string; commercialRoles: string; commissionPolicy: string };
const FIELD_LABELS: Record<string, string> = { cancellationPolicy: "Distrato e multa", requiredCaptureFields: "Campos obrigatórios da ficha", requiredContractDocuments: "Documentos do contrato", commercialRoles: "Papéis", commissionPolicy: "Comissão" };
const emptyForm: SettingsForm = { cancellationPolicy: "", requiredCaptureFields: "", requiredContractDocuments: "", commercialRoles: "", commissionPolicy: "" };

export default function ProjectSettings() {
  const list = trpc.projectSettings.list.useQuery();
  const utils = trpc.useUtils();
  const [resortId, setResortId] = useState("");
  const [form, setForm] = useState<SettingsForm>(emptyForm);
  const settingsRows = list.data?.rows ?? [];
  const selected = settingsRows.find(item => String(item.resort.id) === resortId);
  useEffect(() => { if (!resortId && settingsRows[0]) setResortId(String(settingsRows[0].resort.id)); }, [resortId, settingsRows]);
  useEffect(() => { const s = selected?.settings; setForm({ cancellationPolicy: s?.cancellationPolicy || "", requiredCaptureFields: s?.requiredCaptureFields || "", requiredContractDocuments: s?.requiredContractDocuments || "", commercialRoles: s?.commercialRoles || "", commissionPolicy: s?.commissionPolicy || "" }); }, [selected?.settings, resortId]);
  const [note, setNote] = useState("");
  const history = trpc.projectSettings.history.useQuery({ resortId: Number(resortId) }, { enabled: Boolean(resortId) });
  const save = trpc.projectSettings.upsert.useMutation({ onSuccess: () => { setNote(""); void utils.projectSettings.list.invalidate(); void utils.projectSettings.history.invalidate(); } });
  const fields: Array<[keyof SettingsForm, string, string]> = [
    ["cancellationPolicy", "Distrato e multa", "Ex.: {\"penaltyRate\":0.1,\"penaltyBase\":\"paid\",\"refundMode\":\"after_penalty\"}"],
    ["requiredCaptureFields", "Campos obrigatórios da ficha", "Ex.: [\"vehicle\", \"homeOwnership\"]"],
    ["requiredContractDocuments", "Documentos obrigatórios do contrato", "Ex.: [\"Contrato assinado\", \"RG / CPF\", \"Comprovante\"]"],
    ["commercialRoles", "Papéis: corretor, captador, liner, fechador", "Defina os papéis válidos deste empreendimento"],
    ["commissionPolicy", "Divisão e calendário de comissão", "Ex.: {\"linerRate\":0.02,\"closerRate\":0.03,\"ftbRate\":0.04}"],
  ];
  return <div className="space-y-6"><PageHeader eyebrow="Administração" title="Regras por empreendimento" description="Cada projeto manda nas suas regras; o motor do TGR executa sem cirurgia de código." /><Card><CardContent className="space-y-5 p-6"><Select value={resortId} onValueChange={setResortId}><SelectTrigger><SelectValue placeholder="Selecione o empreendimento" /></SelectTrigger><SelectContent>{settingsRows.map(item => <SelectItem key={item.resort.id} value={String(item.resort.id)}>{item.resort.name}</SelectItem>)}</SelectContent></Select>{list.data?.truncated ? <p className="rounded-xl border border-[#ead8ad] bg-[#fff9e9] p-3 text-xs text-[#71531a]">Atenção: catálogo limitado por {list.data.truncatedSources.join(", ")}. Exibindo apenas o recorte carregado.</p> : null}{fields.map(([key, label, placeholder]) => <div key={key}><p className="mb-2 text-sm font-semibold">{label}</p><Textarea value={form[key]} onChange={event => setForm(value => ({ ...value, [key]: event.target.value }))} placeholder={placeholder} /></div>)}<div><p className="mb-2 text-sm font-semibold">Motivo da mudança (fica no histórico)</p><input className="w-full rounded-md border p-2 text-sm" value={note} maxLength={500} onChange={event => setNote(event.target.value)} /></div><Button disabled={!resortId || save.isPending} onClick={() => save.mutate({ resortId: Number(resortId), ...form, ...(note.trim() ? { note: note.trim() } : {}) })}><Save className="mr-2 h-4 w-4" />{save.isPending ? "Salvando..." : "Salvar regras do projeto"}</Button><div><p className="mb-2 text-sm font-semibold">Histórico de mudanças</p>{history.data?.length ? <ul className="space-y-2 text-xs">{history.data.map(item => <li key={item.id} className="rounded-lg border p-2"><strong>{new Date(item.createdAt).toLocaleString("pt-BR")}</strong> · {item.actorName ?? "usuário removido"}{item.note ? ` · ${item.note}` : ""}{item.changes ? Object.entries(item.changes).map(([field, change]) => <div key={field}>{FIELD_LABELS[field] ?? field}: <code>{change.from ?? "(vazio)"}</code> → <code>{change.to ?? "(vazio)"}</code></div>) : <div className="text-muted-foreground">Registro antigo, sem detalhe de/para.</div>}</li>)}</ul> : <p className="text-xs text-muted-foreground">Nenhuma mudança registrada.</p>}</div></CardContent></Card></div>;
}
