import { EmptyState, PageHeader, money, StatusPill, dateLabel } from "@/components/crm/ui";
import { RevenueQualityCard } from "@/components/crm/RevenueQualityCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, FileUp, Paperclip, RefreshCw } from "lucide-react";
import { ChangeEvent, FormEvent, useState } from "react";
import { Link, useRoute } from "wouter";
import { toast } from "sonner";

type ContractStatus = "draft" | "pending_signature" | "active" | "overdue" | "cancelled" | "closed";

export default function ContractDetail() {
  const [, params] = useRoute("/contratos/:id");
  const id = Number(params?.id ?? 0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [cancellationOpen, setCancellationOpen] = useState(false);
  const [status, setStatus] = useState<ContractStatus>("draft");
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState("Contrato");
  const [cancellationReason, setCancellationReason] = useState("");
  const utils = trpc.useUtils();
  const detail = trpc.contracts.detail.useQuery({ id }, { enabled: Boolean(id) });
  const cancellationSimulation = trpc.contracts.simulateCancellation.useQuery({ contractId: id }, { enabled: Boolean(id) });
  const updateStatus = trpc.contracts.updateStatus.useMutation({ onSuccess: () => { utils.contracts.detail.invalidate({ id }); utils.contracts.list.invalidate(); toast.success("Status do contrato atualizado."); }, onError: error => toast.error(error.message) });
  const upload = trpc.contracts.uploadDocument.useMutation({ onSuccess: () => { utils.contracts.detail.invalidate({ id }); setUploadOpen(false); setFile(null); toast.success("Documento contratual anexado."); }, onError: error => toast.error(error.message) });
  const requestCancellation = trpc.contracts.requestCancellation.useMutation({ onSuccess: () => { utils.contracts.detail.invalidate({ id }); setCancellationOpen(false); setCancellationReason(""); toast.success("Distrato enviado para aprovação humana."); }, onError: error => toast.error(error.message) });
  const decideCancellation = trpc.contracts.decideCancellation.useMutation({ onSuccess: () => { utils.contracts.detail.invalidate({ id }); toast.success("Decisão de distrato registrada."); }, onError: error => toast.error(error.message) });
  const executeCancellation = trpc.contracts.executeCancellation.useMutation({ onSuccess: () => { utils.contracts.detail.invalidate({ id }); utils.contracts.list.invalidate(); toast.success("Distrato aprovado executado com trilha auditável."); }, onError: error => toast.error(error.message) });

  const submitDocument = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) return toast.error("Escolha um arquivo.");
    const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
    upload.mutate({ contractId: id, category, filename: file.name, contentType: file.type || "application/octet-stream", base64, signed: category === "Contrato assinado" });
  };

  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Abrindo pasta contratual...</p>;
  if (!detail.data) return <EmptyState title="Contrato não encontrado" body="Esta pasta não existe mais ou o endereço foi digitado errado." action={<Button asChild className="bg-[#1d2b2a]"><Link href="/contratos">Voltar para contratos</Link></Button>} />;

  const { contract, customerName, customerEmail, customerPhone, installments, documents, cancellationRequests } = detail.data;
  const currentStatus = status === "draft" && contract.status !== "draft" ? contract.status : status;
  const latestCancellation = cancellationRequests[0];

  return <div className="space-y-8">
    <Link href="/contratos" className="inline-flex items-center gap-2 text-xs font-semibold text-[#8a6b2d]"><ArrowLeft className="h-3.5 w-3.5" />Contratos</Link>
    <PageHeader eyebrow="Pasta contratual" title={contract.number} description={`${customerName} · ${contract.usageModel.replaceAll("_", " ")} · ${money(contract.totalAmount)}`} action={<div className="flex flex-wrap gap-2">
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}><DialogTrigger asChild><Button variant="outline" className="rounded-xl border-[#d9cfbd]"><Paperclip className="mr-2 h-4 w-4" />Anexar documento</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle className="font-serif text-2xl">Anexo contratual</DialogTitle></DialogHeader><form className="grid gap-4 py-2" onSubmit={submitDocument}><div className="grid gap-2"><Label>Categoria</Label><Select value={category} onValueChange={setCategory}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Contrato">Contrato</SelectItem><SelectItem value="Contrato assinado">Contrato assinado</SelectItem><SelectItem value="Aditivo">Aditivo</SelectItem><SelectItem value="Comprovante">Comprovante</SelectItem></SelectContent></Select></div><div className="grid gap-2"><Label>Arquivo (máx. 5 MB)</Label><Input type="file" accept="application/pdf,image/*,.doc,.docx" onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)} /></div><Button disabled={upload.isPending} className="bg-[#1d2b2a] hover:bg-[#29413e]"><FileUp className="mr-2 h-4 w-4" />{upload.isPending ? "Enviando..." : "Guardar documento"}</Button></form></DialogContent></Dialog>
      <Select value={currentStatus} onValueChange={value => { const next = value as ContractStatus; setStatus(next); updateStatus.mutate({ id, status: next }); }}><SelectTrigger className="w-[190px] rounded-xl bg-[#1d2b2a] text-white"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">Rascunho</SelectItem><SelectItem value="pending_signature">Aguardando assinatura</SelectItem><SelectItem value="active">Ativo</SelectItem><SelectItem value="overdue">Inadimplente</SelectItem><SelectItem value="cancelled">Cancelado</SelectItem><SelectItem value="closed">Encerrado</SelectItem></SelectContent></Select>
    </div>} />
    <div className="grid gap-5 xl:grid-cols-[1.15fr_1.85fr]">
      <div className="space-y-5">
        <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Resumo</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><div className="flex items-center justify-between"><span className="text-muted-foreground">Status</span><StatusPill value={contract.status} /></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">Associado</span><span className="text-right font-medium">{customerName}</span></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">E-mail</span><span className="text-right">{customerEmail || "—"}</span></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">Telefone</span><span>{customerPhone || "—"}</span></div><div className="border-t border-[#eee9df] pt-3"><p className="text-xs text-muted-foreground">Valor contratado</p><p className="mt-1 font-serif text-3xl text-[#1d2b2a]">{money(contract.totalAmount)}</p></div></CardContent></Card>
        <RevenueQualityCard contractId={id} />
        <CancellationCard simulation={cancellationSimulation.data} request={latestCancellation} open={cancellationOpen} setOpen={setCancellationOpen} reason={cancellationReason} setReason={setCancellationReason} isCancelled={contract.status === "cancelled"} requestPending={requestCancellation.isPending} decisionPending={decideCancellation.isPending} executionPending={executeCancellation.isPending} onRequest={() => requestCancellation.mutate({ contractId: id, reason: cancellationReason })} onDecision={(decision) => decideCancellation.mutate({ requestId: latestCancellation.id, decision })} onExecute={() => executeCancellation.mutate({ requestId: latestCancellation.id })} />
        <DocumentsCard documents={documents} />
      </div>
      <Card className="overflow-hidden rounded-[1.35rem] border-[#e9e4da]"><CardHeader><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b18f4b]">Cronograma financeiro</p><CardTitle className="mt-1 font-serif text-2xl text-[#1d2b2a]">Parcelas</CardTitle></div><RefreshCw className="h-5 w-5 text-[#b18f4b]" /></div></CardHeader><CardContent className="p-0">{installments.map(item => <div key={item.id} className="grid grid-cols-[80px_1fr_1fr_auto] items-center gap-4 border-t border-[#f0ece4] px-6 py-4 text-sm"><span className="font-semibold text-[#1d2b2a]">#{item.sequence}</span><span>{dateLabel(item.dueDate)}</span><strong>{money(item.amount)}</strong><StatusPill value={item.status} /></div>)}</CardContent></Card>
    </div>
  </div>;
}

function CancellationCard({ simulation, request, open, setOpen, reason, setReason, isCancelled, requestPending, decisionPending, executionPending, onRequest, onDecision, onExecute }: { simulation?: { penalty: number; refund: number }; request?: { id: number; status: string; reason: string }; open: boolean; setOpen: (value: boolean) => void; reason: string; setReason: (value: string) => void; isCancelled: boolean; requestPending: boolean; decisionPending: boolean; executionPending: boolean; onRequest: () => void; onDecision: (value: "approved" | "rejected") => void; onExecute: () => void }) {
  return <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Distrato auditável</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><p className="text-muted-foreground">{simulation ? `Simulação: multa ${money(simulation.penalty)} · devolução ${money(simulation.refund)}.` : "Calculando impacto conforme a política do empreendimento..."}</p>{request ? <div className="rounded-xl bg-[#faf8f3] p-3"><p className="font-medium text-[#1d2b2a]">Solicitação #{request.id} · {request.status}</p><p className="mt-1 text-xs text-muted-foreground">{request.reason}</p>{request.status === "requested" && <div className="mt-3 grid grid-cols-2 gap-2"><Button variant="outline" disabled={decisionPending} onClick={() => onDecision("rejected")}>Rejeitar</Button><Button className="bg-[#1d2b2a] hover:bg-[#29413e]" disabled={decisionPending} onClick={() => onDecision("approved")}>Aprovar</Button></div>}{request.status === "approved" && <Button className="mt-3 w-full bg-[#9b3f32] hover:bg-[#7c3026]" disabled={executionPending} onClick={onExecute}>{executionPending ? "Executando..." : "Executar distrato aprovado"}</Button>}</div> : <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" className="w-full border-[#b18f4b] text-[#8a6b2d]" disabled={isCancelled}>Solicitar revisão de distrato</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle className="font-serif text-2xl">Solicitar distrato</DialogTitle></DialogHeader><div className="grid gap-4 py-2"><p className="text-sm text-muted-foreground">A solicitação congela esta simulação e exige aprovação humana antes de qualquer cancelamento.</p><textarea value={reason} onChange={event => setReason(event.target.value)} className="min-h-28 rounded-md border border-input bg-transparent p-3 text-sm" placeholder="Motivo documentado do distrato" /><Button disabled={reason.trim().length < 3 || requestPending} className="bg-[#1d2b2a] hover:bg-[#29413e]" onClick={onRequest}>{requestPending ? "Enviando..." : "Enviar para aprovação"}</Button></div></DialogContent></Dialog>}</CardContent></Card>;
}

function DocumentsCard({ documents }: { documents: Array<{ id: number; storageKey: string; filename: string; category: string; signed: boolean }> }) {
  return <Card className="rounded-[1.35rem] border-[#e9e4da]"><CardHeader><CardTitle className="font-serif text-xl text-[#1d2b2a]">Documentos</CardTitle></CardHeader><CardContent className="space-y-2">{documents.length ? documents.map(document => <a key={document.id} href={`/manus-storage/${document.storageKey}`} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl bg-[#faf8f3] p-3 text-sm hover:bg-[#f3efe6]"><div><p className="font-medium text-[#1d2b2a]">{document.filename}</p><p className="mt-1 text-[11px] text-muted-foreground">{document.category} · {document.signed ? "assinado" : "pendente"}</p></div><Paperclip className="h-4 w-4 text-[#b18f4b]" /></a>) : <p className="rounded-xl bg-[#faf8f3] p-4 text-sm text-muted-foreground">Nenhum documento anexado.</p>}</CardContent></Card>;
}
