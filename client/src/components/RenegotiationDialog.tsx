import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { HandCoins } from "lucide-react";
import { FormEvent, useState } from "react";
import { toast } from "sonner";

export function RenegotiationDialog() {
  const [open, setOpen] = useState(false); const [installmentId, setInstallmentId] = useState(""); const [amount, setAmount] = useState(""); const [dueDate, setDueDate] = useState("");
  const installments = trpc.finance.installments.useQuery(); const utils = trpc.useUtils();
  const preview = trpc.finance.simulateRenegotiation.useQuery({ installmentId: Number(installmentId || 0), proposedAmount: Number(amount || 0), proposedDueDate: dueDate || "2000-01-01" }, { enabled: Boolean(installmentId && amount && dueDate) });
  const create = trpc.finance.createRenegotiation.useMutation({ onSuccess: () => { utils.finance.installments.invalidate(); setOpen(false); toast.success("Acordo salvo como rascunho para aprovação."); }, onError: error => toast.error(error.message) });
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!installmentId || !amount || !dueDate) return toast.error("Preencha a parcela, valor e vencimento."); create.mutate({ installmentId: Number(installmentId), proposedAmount: Number(amount), proposedDueDate: dueDate, notes: String(new FormData(event.currentTarget).get("notes") || "") || null }); };
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" className="rounded-xl border-[#d9cfbd]"><HandCoins className="mr-2 h-4 w-4" />Renegociar</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle className="font-serif text-2xl">Simular acordo</DialogTitle></DialogHeader><form className="grid gap-4" onSubmit={submit}><Select value={installmentId} onValueChange={setInstallmentId}><SelectTrigger><SelectValue placeholder="Parcela em aberto" /></SelectTrigger><SelectContent>{installments.data?.filter(item => item.installment.status !== "paid" && item.installment.status !== "cancelled").map(item => <SelectItem key={item.installment.id} value={String(item.installment.id)}>{item.customerName} · {item.contractNumber} · {Number(item.installment.amount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</SelectItem>)}</SelectContent></Select><div className="grid grid-cols-2 gap-3"><Input value={amount} onChange={event => setAmount(event.target.value)} type="number" min="0.01" step="0.01" placeholder="Novo valor" /><Input value={dueDate} onChange={event => setDueDate(event.target.value)} type="date" /></div>{preview.data ? <div className="rounded-xl bg-[#faf8f3] p-3 text-sm">Original: <strong>{preview.data.originalAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong><br />Desconto: <strong>{preview.data.discountAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong></div> : null}<Textarea name="notes" placeholder="Motivo e condições do acordo" /><Button type="submit" disabled={create.isPending || Boolean(preview.error)}>Salvar rascunho para aprovação</Button></form></DialogContent></Dialog>;
}
