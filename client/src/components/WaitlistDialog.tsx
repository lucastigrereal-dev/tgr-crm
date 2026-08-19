import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { CalendarDays } from "lucide-react";
import { FormEvent, useState } from "react";
import { toast } from "sonner";

export function WaitlistDialog() {
  const [open, setOpen] = useState(false); const [customerId, setCustomerId] = useState(""); const [resortId, setResortId] = useState("none");
  const utils = trpc.useUtils(); const customers = trpc.customers.list.useQuery(); const resorts = trpc.operations.resorts.useQuery();
  const join = trpc.operations.joinWaitlist.useMutation({ onSuccess: () => { utils.operations.waitlist.invalidate(); setOpen(false); toast.success("Associado entrou na lista de espera."); }, onError: error => toast.error(error.message) });
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); if (!customerId) return toast.error("Selecione o associado."); join.mutate({ customerId: Number(customerId), resortId: resortId === "none" ? null : Number(resortId), desiredCheckIn: String(data.get("checkIn")), desiredCheckOut: String(data.get("checkOut")), partySize: Number(data.get("partySize") || 1), priorityScore: Number(data.get("priority") || 0), preferenceNotes: String(data.get("notes") || "") || null }); };
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" className="rounded-xl border-[#d9cfbd]"><CalendarDays className="mr-2 h-4 w-4" />Lista de espera</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle className="font-serif text-2xl">Entrar na lista de espera</DialogTitle></DialogHeader><form className="grid gap-4" onSubmit={submit}><Select value={customerId} onValueChange={setCustomerId}><SelectTrigger><SelectValue placeholder="Associado" /></SelectTrigger><SelectContent>{customers.data?.map(customer => <SelectItem key={customer.id} value={String(customer.id)}>{customer.fullName}</SelectItem>)}</SelectContent></Select><Select value={resortId} onValueChange={setResortId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Qualquer empreendimento</SelectItem>{resorts.data?.map(resort => <SelectItem key={resort.id} value={String(resort.id)}>{resort.name}</SelectItem>)}</SelectContent></Select><div className="grid grid-cols-2 gap-3"><Input name="checkIn" type="date" required /><Input name="checkOut" type="date" required /></div><div className="grid grid-cols-2 gap-3"><Input name="partySize" type="number" min="1" defaultValue="1" /><Input name="priority" type="number" min="0" defaultValue="0" /></div><Textarea name="notes" placeholder="Preferências e observações" /><Button type="submit">Entrar na fila</Button></form></DialogContent></Dialog>;
}
