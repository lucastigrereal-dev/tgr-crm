import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { type GuestpassFields } from "@/lib/guestpassForm";
import { Search, Ticket, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type Candidate = { captureId: number; customerId: number; fullName: string; alreadyLinked: boolean };

/**
 * F1.8 / CRM-b: "Buscar passe" e "Preencher na hora". Só aparece com a flag do servidor ligada (guestpass.status). A busca é sob demanda: o CRM pergunta ao GuestPass
 * e preenche a ficha com nome, acompanhante, telefone, cidade e hospedagem; nada é salvo até a equipe lançar a ficha. Fichas candidatas pelo telefone são só sugestão,
 * a equipe decide se vincula o passe a uma delas. O Nº do passe vai junto com a ficha nova (vínculo 1:1).
 */
export function GuestpassLookup({ passRef, onFill, onPassRef }: { passRef: string | null; onFill: (fields: GuestpassFields) => void; onPassRef: (ref: string | null, fetchedAt?: string | null) => void }) {
  const status = trpc.guestpass.status.useQuery(undefined, { retry: false });
  const [value, setValue] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const lookup = trpc.guestpass.lookup.useMutation({
    onSuccess: result => {
      onFill(result.fields as GuestpassFields);
      if (result.linkedCaptureId) {
        // Passe já preso a outra ficha (1:1): lançar uma ficha nova com ele daria CONFLICT e desfaria a ficha toda. Preenche, mas não amarra o passe.
        onPassRef(null);
        setCandidates([]);
        toast.warning(`Este passe já está na ficha #${result.linkedCaptureId}. Abra essa ficha em vez de lançar outra; os campos foram preenchidos só para conferência.`);
        return;
      }
      setFetchedAt(result.fetchedAt);
      onPassRef(result.passRef, result.fetchedAt);
      setCandidates(result.candidates.filter(item => !item.alreadyLinked));
      toast.success("Dados do passe preenchidos. Confira com o casal antes de lançar.");
    },
    onError: error => { onPassRef(null); setCandidates([]); toast.error(error.message); },
  });
  const link = trpc.guestpass.link.useMutation({
    onSuccess: result => { toast.success(`Passe vinculado à ficha #${result.captureId}.`); setCandidates([]); onPassRef(null); },
    onError: error => toast.error(error.message),
  });
  if (!status.data?.enabled) return null;
  return <section aria-label="Buscar passe" className="space-y-3 border border-[#c9a557]/40 bg-[#fffdf6] px-4 py-3">
    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.12em] text-[#52615c]"><Ticket className="h-4 w-4" />Passe do GuestPass</p>
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1"><Label htmlFor="guestpass-ref">Nº do passe</Label><Input id="guestpass-ref" className="w-52" placeholder="GP-0A1B2C3D4E" value={value} onChange={e => setValue(e.target.value)} /></div>
      <Button type="button" variant="outline" size="sm" disabled={!value.trim() || lookup.isPending} onClick={() => lookup.mutate({ passRef: value })}><Search className="mr-2 h-3.5 w-3.5" />{lookup.isPending ? "Buscando..." : "Buscar passe"}</Button>
      {passRef ? <span className="flex items-center gap-2 text-xs text-[#285043]"><span data-testid="guestpass-badge" className="border border-[#c9a557] bg-[#c9a557]/15 px-2 py-0.5 font-bold uppercase tracking-[.1em]">do GuestPass</span>Ficha preenchida pelo passe {passRef}<Button type="button" size="sm" variant="ghost" aria-label="Soltar passe" onClick={() => { onPassRef(null); setCandidates([]); }}><X className="h-3.5 w-3.5" /></Button></span> : null}
    </div>
    {passRef && candidates.length ? <div className="space-y-2 border-t border-[#c9a557]/30 pt-2 text-sm">
      <p className="text-xs text-muted-foreground">Já existe ficha com este telefone. Se for o mesmo casal, ligue o passe a ela em vez de lançar outra.</p>
      {candidates.map(item => <div key={item.captureId} className="flex items-center justify-between gap-3"><span>Ficha #{item.captureId} · {item.fullName}</span><Button type="button" size="sm" variant="outline" disabled={link.isPending} onClick={() => link.mutate({ captureId: item.captureId, passRef, fetchedAt })}>Vincular a esta ficha</Button></div>)}
    </div> : null}
  </section>;
}
