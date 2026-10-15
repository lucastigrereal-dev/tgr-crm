import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

// Portal do Proprietário: a administração gera o link de leitura e o envia pelo próprio time. O link aparece uma vez só.
export function OwnerPortalLinksCard({ customerId }: { customerId: number }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [days, setDays] = useState(30);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const links = trpc.ownerPortal.listLinks.useQuery({ customerId }, { enabled: isAdmin && customerId > 0 });
  const create = trpc.ownerPortal.createLink.useMutation({
    onSuccess: result => { setFreshUrl(`${window.location.origin}${result.path}`); void utils.ownerPortal.listLinks.invalidate({ customerId }); },
    onError: error => toast.error(error.message),
  });
  const revoke = trpc.ownerPortal.revokeLink.useMutation({
    onSuccess: () => { toast.success("Link revogado."); void utils.ownerPortal.listLinks.invalidate({ customerId }); },
    onError: error => toast.error(error.message),
  });
  if (!isAdmin) return null;

  const copyUrl = async () => {
    if (!freshUrl) return;
    try { await navigator.clipboard.writeText(freshUrl); toast.success("Link copiado. Envie ao associado pelo canal de atendimento."); } catch { toast.error("Não deu para copiar. Selecione e copie manualmente."); }
  };

  return <Card className="rounded-[1.35rem] border-[#e9e4da]">
    <CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Portal do associado</CardTitle><p className="text-xs text-muted-foreground">Link de leitura com contratos, parcelas e 2ª via. Sem CPF nem endereço.</p></CardHeader>
    <CardContent className="space-y-3">
      <div className="flex items-end gap-2">
        <label className="grid gap-1 text-xs text-muted-foreground">Validade (dias)<Input type="number" min={1} max={90} value={days} onChange={event => setDays(Math.min(90, Math.max(1, Number(event.target.value) || 1)))} className="h-9 w-24" /></label>
        <Button size="sm" disabled={create.isPending} onClick={() => create.mutate({ customerId, days })}>{create.isPending ? "Gerando..." : "Gerar link"}</Button>
      </div>
      {freshUrl && <div className="space-y-2 rounded-xl border border-[#ead8ad] bg-[#fff9e9] p-3 text-xs">
        <p className="font-semibold text-[#71531a]">Copie agora: este link não aparece de novo.</p>
        <Input readOnly value={freshUrl} onFocus={event => event.currentTarget.select()} className="h-8 text-xs" />
        <Button size="sm" variant="secondary" onClick={copyUrl}>Copiar link</Button>
      </div>}
      {(links.data ?? []).map(link => <div key={link.id} className="flex items-center justify-between gap-2 rounded-xl bg-[#faf8f3] p-3 text-xs">
        <div><p>Criado em {new Date(link.createdAt).toLocaleDateString("pt-BR")} · vale até {new Date(link.expiresAt).toLocaleDateString("pt-BR")}</p><p className="text-muted-foreground">{link.accessCount} acesso(s){link.lastAccessedAt ? ` · último ${new Date(link.lastAccessedAt).toLocaleString("pt-BR")}` : ""}</p></div>
        {link.active ? <Button size="sm" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate({ linkId: link.id })}>Revogar</Button> : <Badge variant="secondary">{link.revokedAt ? "Revogado" : "Expirado"}</Badge>}
      </div>)}
    </CardContent>
  </Card>;
}
