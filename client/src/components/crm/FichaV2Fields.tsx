import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type FichaV2Form = { visitMode: string; holderAge: string; partnerPhone: string };

/**
 * Ficha do captador v2 (26/10), só com CAPTURE_FICHA_V2_ENABLED ligada no servidor (captures.visitRule.fichaV2). Tour direto = visita de hoje, sem horário (a data e hora
 * do atendimento ficam travadas); agendamento = precisa de data e hora. Idade do titular e 2º telefone (cônjuge) são opcionais.
 */
export function FichaV2Fields({ form, onChange }: { form: FichaV2Form; onChange: (key: keyof FichaV2Form, value: string) => void }) {
  return <section aria-label="Ficha do captador v2" data-testid="ficha-v2" className="space-y-3 border border-[#c9a557]/40 bg-[#fffdf6] px-4 py-3">
    <p className="text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">Tipo de visita</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="grid gap-2">
        <Label>Visita</Label>
        <Select value={form.visitMode || undefined} onValueChange={value => onChange("visitMode", value)}>
          <SelectTrigger className="w-full min-w-0"><SelectValue placeholder="Tour direto ou agendamento" /></SelectTrigger>
          <SelectContent><SelectItem value="tour_direto">Tour direto (hoje, sem horário)</SelectItem><SelectItem value="agendamento">Agendamento (data e hora)</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="grid gap-2"><Label htmlFor="holder-age">Idade do titular</Label><Input id="holder-age" type="number" inputMode="numeric" min={0} max={120} step={1} value={form.holderAge} onChange={e => onChange("holderAge", e.target.value)} /></div>
      <div className="grid gap-2"><Label htmlFor="partner-phone">2º telefone (cônjuge)</Label><Input id="partner-phone" type="tel" inputMode="tel" maxLength={32} value={form.partnerPhone} onChange={e => onChange("partnerPhone", e.target.value)} /></div>
    </div>
    {form.visitMode === "tour_direto" ? <p className="text-xs text-muted-foreground">Tour direto não tem horário: o casal entra na fila de hoje.</p> : null}
  </section>;
}
