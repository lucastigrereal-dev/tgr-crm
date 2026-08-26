import { EmptyState, PageHeader, StatusPill, dateLabel, money } from "@/components/crm/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, CalendarClock, CheckCircle2, FileUp, MessageSquarePlus, Paperclip, Radar, ShieldCheck, Sparkles } from "lucide-react";
import { ChangeEvent, FormEvent, useState } from "react";
import { Link, useRoute } from "wouter";
import { toast } from "sonner";

type InteractionType = "call" | "whatsapp" | "email" | "meeting" | "note";
type Direction = "incoming" | "outgoing" | "internal";

export default function CustomerDetail() {
  const [, params] = useRoute("/clientes/:id");
  const id = Number(params?.id ?? 0);
  const [interactionOpen, setInteractionOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [interactionType, setInteractionType] = useState<InteractionType>("note");
  const [direction, setDirection] = useState<Direction>("internal");
  const [profileStatus, setProfileStatus] = useState<"prospect" | "active" | "inactive">("prospect");
  const [category, setCategory] = useState("Documento pessoal");
  const [file, setFile] = useState<File | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantQuestion, setAssistantQuestion] = useState("");
  const [assistantResult, setAssistantResult] = useState<{ answer: string; confidence: "high" | "medium" | "low"; evidence: Array<{ id: string; kind: string; title: string; detail: string }>; recommendedActions: Array<{ title: string; rationale: string; requiresHumanApproval: true }>; limitations: string[] } | null>(null);
  const utils = trpc.useUtils();
  const detail = trpc.customers.detail.useQuery({ id }, { enabled: Boolean(id) });
  const addInteraction = trpc.customers.addInteraction.useMutation({
    onSuccess: () => {
      utils.customers.detail.invalidate({ id });
      setInteractionOpen(false);
      toast.success("Interação registrada.");
    },
    onError: error => toast.error(error.message),
  });
  const upload = trpc.customers.uploadDocument.useMutation({
    onSuccess: () => {
      utils.customers.detail.invalidate({ id });
      setDocumentOpen(false);
      setFile(null);
      toast.success("Documento anexado com segurança.");
    },
    onError: error => toast.error(error.message),
  });
  const updateCustomer = trpc.customers.update.useMutation({
    onSuccess: () => {
      utils.customers.detail.invalidate({ id });
      utils.customers.list.invalidate();
      setEditOpen(false);
      toast.success("Cadastro atualizado.");
    },
    onError: error => toast.error(error.message),
  });
  const askAssistant = trpc.ai.analyzeCustomer.useMutation({
    onSuccess: result => setAssistantResult(result),
    onError: error => toast.error(error.message),
  });

  const submitInteraction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    addInteraction.mutate({
      customerId: id,
      type: interactionType,
      direction,
      subject: String(data.get("subject") ?? "") || undefined,
      content: String(data.get("content") ?? ""),
    });
  };

  const submitDocument = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const selectedFile = file;
    if (!selectedFile) {
      toast.error("Escolha um arquivo para anexar.");
      return;
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(selectedFile);
    });
    upload.mutate({
      customerId: id,
      category,
      filename: selectedFile.name,
      contentType: selectedFile.type || "application/octet-stream",
      base64,
    });
  };

  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    updateCustomer.mutate({
      id,
      data: {
        fullName: String(data.get("fullName") ?? ""),
        documentNumber: String(data.get("documentNumber") ?? "") || null,
        email: String(data.get("email") ?? ""),
        phone: String(data.get("phone") ?? "") || null,
        birthDate: String(data.get("birthDate") ?? "") || null,
        maritalStatus: String(data.get("maritalStatus") ?? "") || null,
        occupation: String(data.get("occupation") ?? "") || null,
        zipCode: String(data.get("zipCode") ?? "") || null,
        address: String(data.get("address") ?? "") || null,
        addressNumber: String(data.get("addressNumber") ?? "") || null,
        complement: String(data.get("complement") ?? "") || null,
        neighborhood: String(data.get("neighborhood") ?? "") || null,
        city: String(data.get("city") ?? "") || null,
        state: String(data.get("state") ?? "") || null,
        acquisitionSource: String(data.get("source") ?? "") || null,
        notes: String(data.get("notes") ?? "") || null,
        status: profileStatus,
      },
    });
  };

  const submitAssistant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!assistantQuestion.trim()) return toast.error("Escreva uma pergunta para a assistência.");
    askAssistant.mutate({ customerId: id, question: assistantQuestion });
  };

  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Abrindo ficha do cliente...</p>;
  if (!detail.data) {
    return <EmptyState title="Cliente não encontrado" body="Essa ficha não existe mais ou o endereço foi digitado errado." action={<Button asChild className="bg-[#1d2b2a]"><Link href="/clientes">Voltar para clientes</Link></Button>} />;
  }

  const { customer, interactions, documents, contracts, opportunities, reservations, relationshipTasks, radar, truncated, truncatedSources } = detail.data;
  const description = [customer.email, customer.phone, [customer.city, customer.state].filter(Boolean).join(" · ")].filter(Boolean).join("  •  ") || "Cadastre os contatos para qualificar o atendimento.";

  return <div className="space-y-8">
    <Link href="/clientes" className="inline-flex items-center gap-2 text-xs font-semibold text-[#8a6b2d]"><ArrowLeft className="h-3.5 w-3.5" />Clientes</Link>
    <PageHeader eyebrow="Ficha do associado" title={customer.fullName} description={description} action={<div className="flex flex-wrap gap-2">
      <Dialog open={assistantOpen} onOpenChange={open => { setAssistantOpen(open); if (!open) { setAssistantQuestion(""); setAssistantResult(null); } }}>
        <DialogTrigger asChild><Button variant="outline" className="rounded-xl border-[#b18f4b] text-[#5d461d] hover:bg-[#fff7e5]"><Sparkles className="mr-2 h-4 w-4" />Consultar IA</Button></DialogTrigger>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle className="font-serif text-2xl">Copiloto do associado</DialogTitle></DialogHeader>
          <div className="rounded-xl border border-[#eadbb8] bg-[#fffaf0] p-3 text-sm text-[#6b5324]"><div className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" />Consulta fundamentada e sem execução automática</div><p className="mt-1 text-xs leading-5">A IA só enxerga o contexto permitido para o seu perfil, cita as evidências usadas e sugere ações que exigem decisão humana.</p></div>
          <form className="grid gap-3 py-2" onSubmit={submitAssistant}><Label htmlFor="assistant-question">Pergunta sobre este associado</Label><Textarea id="assistant-question" value={assistantQuestion} onChange={event => setAssistantQuestion(event.target.value)} maxLength={800} required placeholder="Ex.: Qual é a próxima melhor ação para destravar este relacionamento?" /><Button disabled={askAssistant.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]"><Sparkles className="mr-2 h-4 w-4" />{askAssistant.isPending ? "Analisando evidências..." : "Analisar com evidências"}</Button></form>
          {assistantResult ? <div className="space-y-4 border-t border-[#eee9df] pt-4"><div className="rounded-2xl bg-[#f7f5ef] p-4"><div className="flex items-center justify-between gap-3"><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b18f4b]">Resposta fundamentada</p><Badge className="border-0 bg-[#eaf0ea] text-xs text-[#24403d]">Confiança {assistantResult.confidence === "high" ? "alta" : assistantResult.confidence === "medium" ? "média" : "baixa"}</Badge></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#1d2b2a]">{assistantResult.answer}</p></div>
            {assistantResult.recommendedActions.length ? <div><p className="text-sm font-semibold text-[#1d2b2a]">Ações sugeridas</p><div className="mt-2 space-y-2">{assistantResult.recommendedActions.map(action => <div key={action.title} className="rounded-xl border border-[#e8e3d9] p-3"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-[#1d2b2a]">{action.title}</p><Badge className="border-0 bg-[#fff2d8] text-[10px] text-[#6b5324]">Aprovação humana obrigatória</Badge></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{action.rationale}</p></div>)}</div></div> : null}
            {assistantResult.evidence.length ? <div><p className="text-sm font-semibold text-[#1d2b2a]">Evidências consultadas</p><div className="mt-2 space-y-2">{assistantResult.evidence.map(evidence => <div key={evidence.id} className="rounded-xl bg-[#faf8f3] p-3 text-xs"><p className="font-semibold text-[#1d2b2a]">{evidence.id} · {evidence.kind} · {evidence.title}</p><p className="mt-1 leading-5 text-muted-foreground">{evidence.detail}</p></div>)}</div></div> : null}
            {assistantResult.limitations.length ? <p className="rounded-xl border border-dashed border-[#d9cfbd] p-3 text-xs leading-5 text-muted-foreground">Limites: {assistantResult.limitations.join(" · ")}</p> : null}
          </div> : null}
        </DialogContent>
      </Dialog>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogTrigger asChild><Button variant="outline" className="rounded-xl border-[#d9cfbd]" onClick={() => setProfileStatus(customer.status)}>Editar cadastro</Button></DialogTrigger>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle className="font-serif text-2xl">Cadastro completo do associado</DialogTitle></DialogHeader>
          <form className="grid gap-4 py-2" onSubmit={submitProfile}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="grid gap-2 sm:col-span-2"><Label>Nome completo *</Label><Input name="fullName" required defaultValue={customer.fullName} /></div><div className="grid gap-2"><Label>CPF ou CNPJ</Label><Input name="documentNumber" defaultValue={customer.documentNumber || ""} /></div><div className="grid gap-2"><Label>Data de nascimento</Label><Input name="birthDate" type="date" defaultValue={customer.birthDate ? new Date(customer.birthDate).toISOString().slice(0, 10) : ""} /></div><div className="grid gap-2"><Label>E-mail</Label><Input name="email" type="email" defaultValue={customer.email || ""} /></div><div className="grid gap-2"><Label>Telefone</Label><Input name="phone" defaultValue={customer.phone || ""} /></div><div className="grid gap-2"><Label>Estado civil</Label><Input name="maritalStatus" defaultValue={customer.maritalStatus || ""} /></div><div className="grid gap-2"><Label>Profissão</Label><Input name="occupation" defaultValue={customer.occupation || ""} /></div></div>
            <div className="border-t border-[#eee9df] pt-4"><p className="mb-3 text-sm font-semibold text-[#1d2b2a]">Endereço</p><div className="grid grid-cols-6 gap-3"><div className="col-span-2 grid gap-2"><Label>CEP</Label><Input name="zipCode" defaultValue={customer.zipCode || ""} /></div><div className="col-span-4 grid gap-2"><Label>Logradouro</Label><Input name="address" defaultValue={customer.address || ""} /></div><div className="col-span-2 grid gap-2"><Label>Número</Label><Input name="addressNumber" defaultValue={customer.addressNumber || ""} /></div><div className="col-span-4 grid gap-2"><Label>Complemento</Label><Input name="complement" defaultValue={customer.complement || ""} /></div><div className="col-span-3 grid gap-2"><Label>Bairro</Label><Input name="neighborhood" defaultValue={customer.neighborhood || ""} /></div><div className="col-span-2 grid gap-2"><Label>Cidade</Label><Input name="city" defaultValue={customer.city || ""} /></div><div className="grid gap-2"><Label>UF</Label><Input name="state" maxLength={2} defaultValue={customer.state || ""} /></div></div></div>
            <div className="grid grid-cols-2 gap-4"><div className="grid gap-2"><Label>Origem</Label><Input name="source" defaultValue={customer.acquisitionSource || ""} /></div><div className="grid gap-2"><Label>Situação</Label><Select value={profileStatus} onValueChange={value => setProfileStatus(value as typeof profileStatus)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="prospect">Prospect</SelectItem><SelectItem value="active">Ativo</SelectItem><SelectItem value="inactive">Inativo</SelectItem></SelectContent></Select></div></div>
            <div className="grid gap-2"><Label>Observações</Label><Textarea name="notes" defaultValue={customer.notes || ""} /></div>
            <Button disabled={updateCustomer.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">{updateCustomer.isPending ? "Salvando..." : "Salvar cadastro completo"}</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={documentOpen} onOpenChange={setDocumentOpen}>
        <DialogTrigger asChild><Button variant="outline" className="rounded-xl border-[#d9cfbd]"><Paperclip className="mr-2 h-4 w-4" />Anexar documento</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-serif text-2xl">Anexar documento</DialogTitle></DialogHeader>
          <form className="grid gap-4 py-2" onSubmit={submitDocument}>
            <div className="grid gap-2"><Label>Categoria</Label><Select value={category} onValueChange={setCategory}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Documento pessoal">Documento pessoal</SelectItem><SelectItem value="Comprovante">Comprovante</SelectItem><SelectItem value="Contrato assinado">Contrato assinado</SelectItem><SelectItem value="Outro">Outro</SelectItem></SelectContent></Select></div>
            <div className="grid gap-2"><Label>Arquivo (máx. 5 MB)</Label><Input type="file" accept="application/pdf,image/*,.doc,.docx" onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)} /></div>
            <Button disabled={upload.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]"><FileUp className="mr-2 h-4 w-4" />{upload.isPending ? "Enviando..." : "Guardar documento"}</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={interactionOpen} onOpenChange={setInteractionOpen}>
        <DialogTrigger asChild><Button className="rounded-xl bg-[#1d2b2a] hover:bg-[#29413e]"><MessageSquarePlus className="mr-2 h-4 w-4" />Registrar interação</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-serif text-2xl">Novo registro de atendimento</DialogTitle></DialogHeader>
          <form className="grid gap-4 py-2" onSubmit={submitInteraction}>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2"><Label>Canal</Label><Select value={interactionType} onValueChange={value => setInteractionType(value as InteractionType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="note">Nota interna</SelectItem><SelectItem value="call">Ligação</SelectItem><SelectItem value="whatsapp">WhatsApp</SelectItem><SelectItem value="email">E-mail</SelectItem><SelectItem value="meeting">Reunião</SelectItem></SelectContent></Select></div>
              <div className="grid gap-2"><Label>Direção</Label><Select value={direction} onValueChange={value => setDirection(value as Direction)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="internal">Interna</SelectItem><SelectItem value="incoming">Recebida</SelectItem><SelectItem value="outgoing">Enviada</SelectItem></SelectContent></Select></div>
            </div>
            <div className="grid gap-2"><Label>Assunto</Label><Input name="subject" placeholder="Ex.: Confirmação de documentos" /></div>
            <div className="grid gap-2"><Label>Resumo *</Label><Textarea name="content" required placeholder="O que foi conversado, combinado ou solicitado?" /></div>
            <Button disabled={addInteraction.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]">{addInteraction.isPending ? "Registrando..." : "Salvar interação"}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>} />
    {truncated ? <div className="rounded-xl border border-[#ead8ad] bg-[#fff9e9] p-3 text-xs text-[#71531a]"><p className="font-semibold">Atenção: esta ficha usa histórico limitado.</p><p className="mt-1">Fontes no limite: {truncatedSources.join(", ")}. O radar e os contadores refletem apenas o recorte carregado.</p></div> : null}
    <div className="grid gap-5 xl:grid-cols-[1.1fr_1.9fr]">
      <div className="space-y-5">
        <Card className="overflow-hidden rounded-[1.35rem] border-[#e9e4da]"><CardHeader className="border-b border-[#eee9df] bg-[#faf8f3]"><div className="flex items-start justify-between gap-3"><div><CardTitle className="font-serif text-xl text-[#1d2b2a]">Radar de relacionamento</CardTitle><p className="mt-1 text-xs text-muted-foreground">Dados, cadência, vínculo, uso e financeiro numa leitura só.</p></div><Radar className="h-5 w-5 text-[#b18f4b]" /></div></CardHeader><CardContent className="space-y-4 p-5"><div className="flex items-end justify-between"><div><p className="text-3xl font-semibold text-[#1d2b2a]">{radar.score}<span className="text-base text-muted-foreground">/100</span></p><p className={`mt-1 text-xs font-bold uppercase tracking-[.12em] ${radar.label === "saudável" ? "text-[#2d675f]" : radar.label === "atenção" ? "text-[#8a6b2d]" : "text-[#a93b33]"}`}>{radar.label}</p></div><div className="h-2 w-24 overflow-hidden rounded-full bg-[#eee9df]"><div className="h-full bg-[#b18f4b]" style={{ width: `${radar.score}%` }} /></div></div><div className="space-y-2 border-t border-[#eee9df] pt-4">{radar.signals.map(signal => <p key={signal} className="text-xs leading-5 text-[#4f615e]">{signal}</p>)}</div><div className="space-y-2 border-t border-[#eee9df] pt-4">{radar.onboarding.map(item => <div key={item.label} className="flex items-center gap-2 text-xs"><CheckCircle2 className={`h-4 w-4 ${item.complete ? "text-[#2d675f]" : "text-[#c9c1b2]"}`} /><span className={item.complete ? "text-[#1d2b2a]" : "text-muted-foreground"}>{item.label}</span></div>)}</div></CardContent></Card>
        <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Cadastro</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><div className="flex justify-between gap-4"><span className="text-muted-foreground">Situação</span><StatusPill value={customer.status} /></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">Documento</span><span>{customer.documentNumber || "—"}</span></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">Origem</span><span>{customer.acquisitionSource || "—"}</span></div><div className="border-t border-[#eee9df] pt-3"><p className="text-xs text-muted-foreground">Endereço</p><p className="mt-1 leading-6">{[customer.address, customer.addressNumber, customer.neighborhood, customer.city, customer.state].filter(Boolean).join(", ") || "Não informado"}</p></div>{customer.notes ? <div className="border-t border-[#eee9df] pt-3"><p className="text-xs text-muted-foreground">Observações</p><p className="mt-1 leading-6">{customer.notes}</p></div> : null}</CardContent></Card>
        <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Documentos</CardTitle></CardHeader><CardContent className="space-y-2">{documents.length ? documents.map(document => <a key={document.id} href={`/manus-storage/${document.storageKey}`} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl bg-[#faf8f3] p-3 text-sm hover:bg-[#f3efe6]"><div><p className="font-medium text-[#1d2b2a]">{document.filename}</p><p className="mt-1 text-[11px] text-muted-foreground">{document.type} · {dateLabel(document.createdAt)}</p></div><Paperclip className="h-4 w-4 text-[#b18f4b]" /></a>) : <p className="rounded-xl bg-[#faf8f3] p-4 text-sm text-muted-foreground">Ainda não há anexos.</p>}</CardContent></Card>
      </div>
      <div className="space-y-5">
        <Card className="overflow-hidden rounded-[1.35rem] border-[#e9e4da]"><CardHeader className="border-b border-[#eee9df] bg-[#faf8f3]"><div className="flex items-start justify-between gap-3"><div><CardTitle className="font-serif text-xl text-[#1d2b2a]">Central de relacionamento</CardTitle><p className="mt-1 text-xs text-muted-foreground">Próximo contato, último contexto e operação do associado numa visão só.</p></div><CalendarClock className="h-5 w-5 text-[#b18f4b]" /></div></CardHeader><CardContent className="grid gap-5 p-5 md:grid-cols-3"><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b18f4b]">Próximas ações</p>{relationshipTasks.length ? <div className="mt-3 space-y-2">{relationshipTasks.slice(0, 4).map(task => <div key={task.id} className="rounded-xl bg-[#faf8f3] p-3"><p className="text-sm font-semibold text-[#1d2b2a]">{task.title}</p><p className="mt-1 text-xs text-muted-foreground">{task.dueAt ? `Até ${dateLabel(task.dueAt)}` : "Sem prazo"} · {task.status}</p></div>)}</div> : <p className="mt-3 text-sm text-muted-foreground">Nenhuma tarefa aberta para este associado.</p>}</div><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b18f4b]">Último contato</p>{interactions[0] ? <div className="mt-3 rounded-xl bg-[#faf8f3] p-3"><p className="text-sm font-semibold text-[#1d2b2a]">{interactions[0].subject || interactions[0].type}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{interactions[0].content}</p><p className="mt-2 text-[11px] text-muted-foreground">{dateLabel(interactions[0].occurredAt)}</p></div> : <p className="mt-3 text-sm text-muted-foreground">Registre o primeiro contato para começar a cadência.</p>}</div><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b18f4b]">Contexto operacional</p><div className="mt-3 space-y-2 text-sm"><p><strong>{contracts.filter(item => item.status === "active").length}</strong> contratos ativos</p><p><strong>{reservations.filter(item => new Date(item.checkIn) >= new Date()).length}</strong> reservas futuras</p><p><strong>{radar.signals.length}</strong> sinal{radar.signals.length === 1 ? "" : "is"} no radar</p></div></div></CardContent></Card>
        <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Histórico de interações</CardTitle></CardHeader><CardContent className="space-y-3">{interactions.length ? interactions.map(item => <article key={item.id} className="relative border-l border-[#d9cfbd] pb-4 pl-5 last:pb-0"><span className="absolute -left-1.5 top-1 h-3 w-3 rounded-full bg-[#c7a35a]" /><div className="flex items-start justify-between gap-4"><div><p className="text-sm font-semibold text-[#1d2b2a]">{item.subject || item.type.replaceAll("_", " ")}</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{item.content}</p></div><Badge className="border-0 bg-[#eef2ec] text-[10px] uppercase tracking-[.1em] text-[#24403d]">{item.direction}</Badge></div><p className="mt-2 text-[11px] text-muted-foreground">{dateLabel(item.occurredAt)}</p></article>) : <p className="rounded-xl bg-[#faf8f3] p-5 text-sm text-muted-foreground">Nenhum contato registrado. A primeira conversa começa aqui.</p>}</CardContent></Card>
        <div className="grid gap-5 md:grid-cols-2">
          <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Contratos</CardTitle></CardHeader><CardContent className="space-y-2">{contracts.length ? contracts.map(contract => <div key={contract.id} className="rounded-xl bg-[#faf8f3] p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{contract.number}</span><StatusPill value={contract.status} /></div><p className="mt-1 text-xs text-muted-foreground">{money(contract.totalAmount)} · {contract.usageModel.replaceAll("_", " ")}</p></div>) : <p className="text-sm text-muted-foreground">Sem contratos.</p>}</CardContent></Card>
          <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Comercial</CardTitle></CardHeader><CardContent className="space-y-2">{opportunities.length ? opportunities.map(opportunity => <div key={opportunity.id} className="rounded-xl bg-[#faf8f3] p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{opportunity.title}</span><StatusPill value={opportunity.stage} /></div><p className="mt-1 text-xs text-muted-foreground">{money(opportunity.expectedAmount)} · {opportunity.probability}%</p></div>) : <p className="text-sm text-muted-foreground">Sem oportunidades.</p>}</CardContent></Card>
        </div>
        {reservations.length ? <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Reservas recentes</CardTitle></CardHeader><CardContent className="space-y-2">{reservations.map(reservation => <div key={reservation.id} className="flex items-center justify-between rounded-xl bg-[#faf8f3] p-3 text-sm"><span>{dateLabel(reservation.checkIn)} → {dateLabel(reservation.checkOut)}</span><StatusPill value={reservation.status} /></div>)}</CardContent></Card> : null}
      </div>
    </div>
  </div>;
}
