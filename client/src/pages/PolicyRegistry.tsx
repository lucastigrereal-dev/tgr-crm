import { PageHeader } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

// WP11 (PRD §13): registro de política ABERTA — só status, vigência e aprovação. Nenhum valor é editado aqui e nenhum
// cálculo lê esta tela; APPROVED exige quem aprovou e a referência do documento aprovado.
const TYPE_LABEL: Record<string, string> = {
  commission: "Comissão", cancellation_terms: "Distrato / multa / devolução", monetary_index: "Índice de correção",
  delinquency: "Inadimplência", retention: "Retenção", messaging: "Mensagens", consent_final: "Consentimento final", contact_hours: "Horários de contato",
};
const NEXT: Record<string, string[]> = { DRAFT: ["UNAPPROVED", "RETIRED"], UNAPPROVED: ["DRAFT", "APPROVED", "RETIRED"], APPROVED: ["RETIRED"], RETIRED: [] };

export default function PolicyRegistry() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const resorts = trpc.operations.resorts.useQuery();
  const [resortId, setResortId] = useState("");
  const resortRows = resorts.data?.rows ?? [];
  useEffect(() => { if (!resortId && resortRows[0]) setResortId(String(resortRows[0].id)); }, [resortId, resortRows]);
  const list = trpc.policyRegistry.list.useQuery({ resortId: Number(resortId) || 1 }, { enabled: Boolean(resortId) });
  const refresh = () => utils.policyRegistry.list.invalidate();
  const seed = trpc.policyRegistry.seedOpen.useMutation({ onSuccess: r => { toast.success(`${r.created} política(s) aberta(s) registrada(s) como NÃO APROVADO.`); refresh(); }, onError: e => toast.error(e.message) });
  const transition = trpc.policyRegistry.transition.useMutation({ onSuccess: r => { toast.success(`Status alterado para ${r.status}.`); refresh(); }, onError: e => toast.error(e.message) });
  const [draft, setDraft] = useState<Record<number, { to: string; approver: string; receiptRef: string }>>({});

  return <div className="space-y-6">
    <PageHeader eyebrow="Governança" title="Registro de políticas" description="Políticas abertas do piloto: status, vigência e aprovação. Nenhum valor monetário é configurado aqui." />
    <Card><CardContent className="flex flex-wrap items-center gap-3 pt-6">
      <Select value={resortId} onValueChange={setResortId}><SelectTrigger className="w-72" aria-label="Empreendimento"><SelectValue placeholder="Empreendimento" /></SelectTrigger>
        <SelectContent>{resortRows.map(r => <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>)}</SelectContent></Select>
      {isAdmin && <Button variant="outline" disabled={!resortId || seed.isPending} onClick={() => seed.mutate({ resortId: Number(resortId) })}><ScrollText className="mr-2 h-4 w-4" />Registrar políticas abertas</Button>}
      <p className="text-xs text-muted-foreground">Aprovar exige o nome de quem aprovou e a referência do documento aprovado.</p>
    </CardContent></Card>
    <Card><CardContent className="overflow-x-auto pt-6">
      <table className="w-full text-sm"><thead><tr className="text-left text-muted-foreground"><th className="py-2">Política</th><th>Versão</th><th>Status</th><th>Vigência</th><th>Aprovador</th><th>Recibo</th>{isAdmin && <th>Ação</th>}</tr></thead>
        <tbody>{(list.data ?? []).map(row => {
          const d = draft[row.id] ?? { to: "", approver: "", receiptRef: "" };
          const set = (patch: Partial<typeof d>) => setDraft(current => ({ ...current, [row.id]: { ...d, ...patch } }));
          return <tr key={row.id} className="border-t align-top">
            <td className="py-2 font-medium">{TYPE_LABEL[row.policyType] ?? row.policyType}</td><td>{row.version}</td>
            <td><span className={row.status === "APPROVED" ? "font-semibold text-emerald-700" : row.status === "RETIRED" ? "text-muted-foreground" : "font-semibold text-amber-700"}>{row.status === "UNAPPROVED" ? "NÃO APROVADO" : row.status}</span></td>
            <td>{row.validFrom ? String(row.validFrom).slice(0, 10) : "—"} → {row.validTo ? String(row.validTo).slice(0, 10) : "—"}</td>
            <td>{row.approver ?? "—"}</td><td>{row.receiptRef ?? "—"}</td>
            {isAdmin && <td className="space-y-1">{NEXT[row.status]?.length ? <>
              <Select value={d.to} onValueChange={to => set({ to })}><SelectTrigger className="h-8 w-40" aria-label={`Novo status de ${row.policyType}`}><SelectValue placeholder="Mudar status" /></SelectTrigger>
                <SelectContent>{NEXT[row.status].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
              {d.to === "APPROVED" && <><Input className="h-8" placeholder="Quem aprovou" value={d.approver} onChange={e => set({ approver: e.target.value })} /><Input className="h-8" placeholder="Referência do documento aprovado" value={d.receiptRef} onChange={e => set({ receiptRef: e.target.value })} /></>}
              <Button size="sm" disabled={!d.to || transition.isPending} onClick={() => transition.mutate({ id: row.id, to: d.to as "DRAFT" | "UNAPPROVED" | "APPROVED" | "RETIRED", approver: d.approver || undefined, receiptRef: d.receiptRef || undefined })}>Aplicar</Button>
            </> : <span className="text-xs text-muted-foreground">final</span>}</td>}
          </tr>;
        })}</tbody></table>
      {list.data?.length === 0 && <p className="py-6 text-sm text-muted-foreground">Nenhuma política registrada para este empreendimento.{isAdmin ? " Use “Registrar políticas abertas”." : ""}</p>}
    </CardContent></Card>
  </div>;
}
