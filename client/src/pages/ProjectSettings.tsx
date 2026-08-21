import { PageHeader } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";

type SettingsForm = { cancellationPolicy: string; requiredCaptureFields: string; requiredContractDocuments: string; commercialRoles: string; commissionPolicy: string };
const emptyForm: SettingsForm = { cancellationPolicy: "", requiredCaptureFields: "", requiredContractDocuments: "", commercialRoles: "", commissionPolicy: "" };

export default function ProjectSettings() {
  const list = trpc.projectSettings.list.useQuery();
  const utils = trpc.useUtils();
  const [resortId, setResortId] = useState("");
  const [form, setForm] = useState<SettingsForm>(emptyForm);
  const selected = list.data?.find(item => String(item.resort.id) === resortId);
  useEffect(() => { if (!resortId && list.data?.[0]) setResortId(String(list.data[0].resort.id)); }, [list.data, resortId]);
  useEffect(() => { const s = selected?.settings; setForm({ cancellationPolicy: s?.cancellationPolicy || "", requiredCaptureFields: s?.requiredCaptureFields || "", requiredContractDocuments: s?.requiredContractDocuments || "", commercialRoles: s?.commercialRoles || "", commissionPolicy: s?.commissionPolicy || "" }); }, [selected?.settings, resortId]);
  const save = trpc.projectSettings.upsert.useMutation({ onSuccess: () => utils.projectSettings.list.invalidate() });
  const fields: Array<[keyof SettingsForm, string, string]> = [
    ["cancellationPolicy", "Distrato e multa", "Ex.: {\"penaltyRate\":0.1,\"penaltyBase\":\"paid\",\"refundMode\":\"after_penalty\"}"],
    ["requiredCaptureFields", "Campos obrigatórios da ficha", "Ex.: [\"vehicle\", \"homeOwnership\"]"],
    ["requiredContractDocuments", "Documentos obrigatórios do contrato", "Ex.: [\"Contrato assinado\", \"RG / CPF\", \"Comprovante\"]"],
    ["commercialRoles", "Papéis: corretor, captador, liner, fechador", "Defina os papéis válidos deste empreendimento"],
    ["commissionPolicy", "Divisão e calendário de comissão", "Ex.: {\"linerRate\":0.02,\"closerRate\":0.03,\"ftbRate\":0.04}"],
  ];
  return <div className="space-y-6"><PageHeader eyebrow="Administração" title="Regras por empreendimento" description="Cada projeto manda nas suas regras; o motor do TGR executa sem cirurgia de código." /><Card><CardContent className="space-y-5 p-6"><Select value={resortId} onValueChange={setResortId}><SelectTrigger><SelectValue placeholder="Selecione o empreendimento" /></SelectTrigger><SelectContent>{list.data?.map(item => <SelectItem key={item.resort.id} value={String(item.resort.id)}>{item.resort.name}</SelectItem>)}</SelectContent></Select>{fields.map(([key, label, placeholder]) => <div key={key}><p className="mb-2 text-sm font-semibold">{label}</p><Textarea value={form[key]} onChange={event => setForm(value => ({ ...value, [key]: event.target.value }))} placeholder={placeholder} /></div>)}<Button disabled={!resortId || save.isPending} onClick={() => save.mutate({ resortId: Number(resortId), ...form })}><Save className="mr-2 h-4 w-4" />{save.isPending ? "Salvando..." : "Salvar regras do projeto"}</Button></CardContent></Card></div>;
}
