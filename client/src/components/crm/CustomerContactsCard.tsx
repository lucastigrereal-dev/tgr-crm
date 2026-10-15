import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

type Kind = "phone" | "whatsapp" | "email" | "address";
const kindLabel: Record<Kind, string> = { phone: "Telefone", whatsapp: "WhatsApp", email: "E-mail", address: "Endereço" };
const placeholder: Record<Kind, string> = { phone: "(84) 99999-0000", whatsapp: "(84) 99999-0000", email: "nome@exemplo.com", address: "Rua, número, bairro, cidade/UF" };

// Contatos adicionais do associado: vários telefones, WhatsApp, e-mails e endereços. O preferencial de telefone e e-mail vira o contato principal da ficha.
export function CustomerContactsCard({ customerId }: { customerId: number }) {
  const [kind, setKind] = useState<Kind>("phone");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const utils = trpc.useUtils();
  const contacts = trpc.customerContacts.list.useQuery({ customerId }, { enabled: customerId > 0 });
  const refresh = () => { void utils.customerContacts.list.invalidate({ customerId }); void utils.customers.detail.invalidate({ id: customerId }); };
  const add = trpc.customerContacts.add.useMutation({ onSuccess: () => { setValue(""); setLabel(""); toast.success("Contato adicionado."); refresh(); }, onError: error => toast.error(error.message) });
  const setPreferred = trpc.customerContacts.setPreferred.useMutation({ onSuccess: () => { toast.success("Preferencial atualizado."); refresh(); }, onError: error => toast.error(error.message) });
  const archive = trpc.customerContacts.archive.useMutation({ onSuccess: () => { toast.success("Contato arquivado."); refresh(); }, onError: error => toast.error(error.message) });
  const submit = () => { if (!value.trim()) return toast.error("Informe o contato."); add.mutate({ customerId, kind, value, label: label.trim() || undefined }); };

  return <Card className="rounded-[1.35rem] border-[#e9e4da]">
    <CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Contatos</CardTitle><p className="text-xs text-muted-foreground">Telefones, WhatsApp, e-mails e endereços extras. O preferencial de telefone e e-mail passa a ser o principal da ficha.</p></CardHeader>
    <CardContent className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[130px_1fr_140px_auto]">
        <Select value={kind} onValueChange={next => setKind(next as Kind)}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent>{(Object.keys(kindLabel) as Kind[]).map(item => <SelectItem key={item} value={item}>{kindLabel[item]}</SelectItem>)}</SelectContent></Select>
        <Input value={value} onChange={event => setValue(event.target.value)} placeholder={placeholder[kind]} className="h-9" />
        <Input value={label} onChange={event => setLabel(event.target.value)} placeholder="Rótulo (ex.: trabalho)" maxLength={60} className="h-9" />
        <Button size="sm" className="h-9" disabled={add.isPending} onClick={submit}>{add.isPending ? "Salvando..." : "Adicionar"}</Button>
      </div>
      {(contacts.data?.length ?? 0) >= 200 && <p className="text-xs text-amber-700">Mostrando os 200 primeiros contatos desta ficha.</p>}
      {contacts.data?.length === 0 && <p className="text-xs text-muted-foreground">Nenhum contato extra ainda.</p>}
      {(contacts.data ?? []).map(contact => <div key={contact.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#faf8f3] p-3 text-sm">
        <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#b18f4b]">{kindLabel[contact.kind]}{contact.label ? ` · ${contact.label}` : ""}</p><p className="break-words text-[#1d2b2a]">{contact.value}</p></div>
        <div className="flex items-center gap-2">
          {contact.isPreferred ? <Badge className="bg-[#1d2b2a] text-white">Preferencial</Badge> : <Button size="sm" variant="outline" disabled={setPreferred.isPending} onClick={() => setPreferred.mutate({ contactId: contact.id })}>Tornar preferencial</Button>}
          <Button size="sm" variant="ghost" disabled={archive.isPending} onClick={() => { if (window.confirm("Arquivar este contato? Ele sai da lista, mas fica no histórico.")) archive.mutate({ contactId: contact.id }); }}>Arquivar</Button>
        </div>
      </div>)}
    </CardContent>
  </Card>;
}
