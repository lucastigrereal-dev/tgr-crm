import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/crm/ui";
import { trpc } from "@/lib/trpc";
import { masterDataFieldLabel, masterDataFields, type MasterDataField } from "@shared/masterData";
import { useState } from "react";
import { toast } from "sonner";

// Dicionários de cadastro (TSE #25): o administrador fecha a lista de valores dos campos analíticos da captação.
export default function MasterData() {
  const [field, setField] = useState<MasterDataField>("captureLocation");
  const [value, setValue] = useState("");
  const utils = trpc.useUtils();
  const list = trpc.masterData.list.useQuery({ field, includeInactive: true });
  const coverage = trpc.masterData.coverage.useQuery({ field });
  const refresh = () => { void utils.masterData.list.invalidate(); void utils.masterData.coverage.invalidate({ field }); };
  const add = trpc.masterData.add.useMutation({ onSuccess: r => { setValue(""); toast.success(r.reactivated ? "Opção reativada." : "Opção incluída."); refresh(); }, onError: e => toast.error(e.message) });
  const setActive = trpc.masterData.setActive.useMutation({ onSuccess: () => refresh(), onError: e => toast.error(e.message) });
  const importExisting = trpc.masterData.importExisting.useMutation({ onSuccess: r => { toast.success(`${r.added} opção(ões) criadas a partir das fichas.`); refresh(); }, onError: e => toast.error(e.message) });
  const rows = list.data ?? [];
  const activeCount = rows.filter(row => row.active).length;

  return <div className="space-y-6">
    <PageHeader eyebrow="Admin" title="Dicionários de cadastro" description="Listas fechadas para os campos usados na análise da captação. Campo sem opção ativa continua livre; com opções, a ficha só aceita valores da lista." />
    <Card><CardContent className="space-y-4 pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={field} onValueChange={next => setField(next as MasterDataField)}><SelectTrigger className="w-64" aria-label="Campo"><SelectValue /></SelectTrigger>
          <SelectContent>{masterDataFields.map(item => <SelectItem key={item} value={item}>{masterDataFieldLabel[item]}</SelectItem>)}</SelectContent></Select>
        <Badge variant="outline">{activeCount ? `${activeCount} opção(ões) ativas: lista fechada` : "Sem opções ativas: campo livre"}</Badge>
        <Button size="sm" variant="outline" disabled={importExisting.isPending} onClick={() => importExisting.mutate({ field })}>{importExisting.isPending ? "Importando..." : "Criar a partir das fichas"}</Button>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (value.trim()) add.mutate({ field, value }); }}>
        <Input className="h-9 max-w-sm" value={value} maxLength={180} onChange={event => setValue(event.target.value)} placeholder={`Nova opção de ${masterDataFieldLabel[field].toLowerCase()}`} />
        <Button size="sm" className="h-9" type="submit" disabled={add.isPending || !value.trim()}>Incluir</Button>
      </form>
      {coverage.data && coverage.data.totalCaptures > 0 && <p className="text-xs text-muted-foreground">{coverage.data.outsideCaptures} de {coverage.data.totalCaptures} fichas usam um valor fora da lista ativa.{coverage.data.outside.length > 0 && ` Mais comuns: ${coverage.data.outside.slice(0, 5).map(row => `${row.value} (${row.total})`).join(", ")}.`}</p>}
      {rows.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma opção cadastrada para este campo.</p>}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(row => <div key={row.id} className="flex items-center justify-between gap-2 rounded-xl bg-[#faf8f3] p-3 text-sm">
          <span className={row.active ? "text-[#1d2b2a]" : "text-muted-foreground line-through"}>{row.value}</span>
          <Button size="sm" variant="ghost" disabled={setActive.isPending} onClick={() => setActive.mutate({ id: row.id, active: !row.active })}>{row.active ? "Desativar" : "Reativar"}</Button>
        </div>)}
      </div>
    </CardContent></Card>
  </div>;
}
