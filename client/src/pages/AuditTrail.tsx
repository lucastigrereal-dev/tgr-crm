import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/crm/ui";
import { trpc } from "@/lib/trpc";

const dateTime = (value: Date | string) => new Date(value).toLocaleString("pt-BR");

// Tela de auditoria: a trilha append-only do CRM (quem fez o quê, em qual registro, quando), só leitura, só admin.
export default function AuditTrail() {
  const [entityType, setEntityType] = useState("all");
  const [entityId, setEntityId] = useState("");
  const [action, setAction] = useState("");
  const filters = { entityType: entityType === "all" ? undefined : entityType, entityId: entityId.trim() || undefined, action: action.trim() || undefined, limit: 50 };
  const trail = trpc.auditTrail.list.useInfiniteQuery(filters, { getNextPageParam: page => page.nextCursor ?? undefined });
  const rows = trail.data?.pages.flatMap(page => page.rows) ?? [];
  const typeList = trpc.auditTrail.entityTypes.useQuery(undefined, { staleTime: 5 * 60_000, refetchOnWindowFocus: false });
  const entityTypes = typeList.data ?? [];

  return <div className="space-y-6">
    <PageHeader eyebrow="Admin" title="Auditoria" description="Tudo o que o sistema registrou: quem fez, em qual registro e quando. A trilha só cresce; ninguém edita nem apaga por aqui." action={<Button size="sm" variant="outline" disabled={trail.isFetching} onClick={() => void trail.refetch()}>{trail.isFetching ? "Atualizando..." : "Atualizar"}</Button>} />
    <div className="flex flex-col gap-2 sm:flex-row">
      <Select value={entityType} onValueChange={setEntityType}><SelectTrigger className="w-full sm:w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos os tipos</SelectItem>{entityTypes.map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select>
      <Input value={entityId} onChange={event => setEntityId(event.target.value)} placeholder="Número do registro" className="w-full sm:w-44" />
      <Input value={action} onChange={event => setAction(event.target.value)} placeholder="Ação (começa com...)" className="w-full sm:w-56" />
    </div>
    {trail.isError && <p className="text-sm text-[#8a3b2d]">Não foi possível carregar a auditoria: {trail.error.message}</p>}
    <Card className="rounded-xl"><CardContent className="space-y-1 pt-6">
      {trail.isLoading && <p className="text-sm text-muted-foreground">Carregando...</p>}
      {!trail.isLoading && rows.length === 0 && <p className="text-sm text-muted-foreground">Nada registrado neste recorte.</p>}
      {rows.map(row => <div key={row.id} className="border-b border-[#f0ece4] py-2 text-sm last:border-b-0">
        <p><strong>{row.action}</strong> · {row.entityType} {row.entityId} · <span className="text-muted-foreground">{dateTime(row.createdAt)} · {row.actorName ?? (row.actorUserId ? `usuário ${row.actorUserId}` : "sistema")}</span></p>
        {row.summary && <p className="text-xs text-muted-foreground">{row.summary}</p>}
      </div>)}
      {trail.hasNextPage && <div className="pt-3"><Button size="sm" variant="outline" disabled={trail.isFetchingNextPage} onClick={() => void trail.fetchNextPage()}>{trail.isFetchingNextPage ? "Carregando..." : "Carregar mais"}</Button></div>}
    </CardContent></Card>
  </div>;
}
