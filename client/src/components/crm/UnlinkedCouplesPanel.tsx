import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";

const clock = (value?: string | Date | null) => (value ? new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—");

/**
 * F1.4: casal sem vínculo é alerta, nunca DEAD silencioso. Mostra (1) códigos que o Sales tentou entregar e nenhuma ficha tem e (2) fichas que já chegaram e ainda não têm
 * o código do casal. Quem pode ligar (administração e vendedor) escolhe o código da lista e liga na hora; os demais perfis avisam o gerente. Some quando está tudo ligado.
 */
export function UnlinkedCouplesPanel() {
  const { user } = useAuth();
  const canLink = user?.role === "admin" || user?.role === "seller";
  const utils = trpc.useUtils();
  const unlinked = trpc.captureSheet.unlinked.useQuery(undefined, { refetchInterval: 15_000 });
  const [pick, setPick] = useState<Record<number, string>>({});
  const link = trpc.captureSheet.setCoupleCode.useMutation({ onSuccess: () => { toast.success("Código ligado à ficha. O Sales reenvia os tempos sozinho."); void utils.captureSheet.unlinked.invalidate(); }, onError: error => toast.error(error.message) });
  const data = unlinked.data;
  if (!data || data.total === 0) return null;
  return <Card data-testid="unlinked-couples" className="rounded-xl border-[#e6c9a8] bg-[#fff8ee] shadow-none"><CardContent className="space-y-4 p-5">
    <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#a2661b]" /><div><p className="font-semibold text-[#5c3b0c]">Casais sem vínculo com a ficha ({data.total})</p><p className="text-sm text-[#7a5a2b]">Enquanto o código do casal não estiver ligado à ficha, os tempos da sala não entram no CRM. O Sales continua tentando por algumas horas: ligou, entra sozinho.</p></div></div>
    {data.codesWithoutCapture.length ? <div className="space-y-1" data-testid="codes-without-capture"><p className="text-xs font-bold uppercase tracking-[.12em] text-[#8b6a35]">Códigos do Sales sem ficha</p><ul className="space-y-1 text-sm">{data.codesWithoutCapture.map(item => <li key={item.coupleCode} className="flex flex-wrap items-center gap-2"><span className="font-mono">{item.coupleCode}</span><span className="text-xs text-muted-foreground">{item.attempts} tentativa(s) · última às {clock(item.lastSeenAt)}</span></li>)}</ul></div> : null}
    {data.capturesWithoutCode.length ? <div className="space-y-2" data-testid="captures-without-code"><p className="text-xs font-bold uppercase tracking-[.12em] text-[#8b6a35]">Fichas que chegaram e estão sem código</p><ul className="space-y-2 text-sm">{data.capturesWithoutCode.map(item => <li key={item.captureId} className="flex flex-wrap items-center gap-2">
      <span className="min-w-40 font-medium">{item.customerName}</span><span className="text-xs text-muted-foreground">chegou às {clock(item.checkedInAt)}{item.salesRoom ? ` · ${item.salesRoom}` : ""}</span>
      <Link href={`/ficha?captura=${item.captureId}`} className="text-xs underline">Abrir ficha</Link>
      {canLink && data.codesWithoutCapture.length ? <>
        <Select value={pick[item.captureId] || undefined} onValueChange={value => setPick(current => ({ ...current, [item.captureId]: value }))}><SelectTrigger className="h-8 w-48" aria-label="Código do casal"><SelectValue placeholder="Código do casal" /></SelectTrigger><SelectContent>{data.codesWithoutCapture.map(code => <SelectItem key={code.coupleCode} value={code.coupleCode}>{code.coupleCode}</SelectItem>)}</SelectContent></Select>
        <Button size="sm" variant="outline" disabled={link.isPending || !pick[item.captureId]} onClick={() => { if (window.confirm("Ligar este código a esta ficha? Confira o casal na tela da sala antes: os tempos vão para esta ficha.")) link.mutate({ captureId: item.captureId, coupleCode: pick[item.captureId]! }); }}>Ligar</Button>
      </> : null}
    </li>)}</ul>{!canLink ? <p className="text-xs text-muted-foreground">Peça ao gerente ou ao vendedor para ligar o código à ficha.</p> : null}</div> : null}
  </CardContent></Card>;
}
