import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, CircleAlert, OctagonAlert } from "lucide-react";

/**
 * F1.12: checklist de política do projeto antes do 1º dia. Lê o mesmo cálculo do script `pnpm policy:readiness`, que usa as leituras dos motores
 * (comissão V1, condições da venda). Item BLOQUEANTE em aberto = o dia 1 não deve começar para este empreendimento.
 */
export function ProjectReadinessChecklist({ resortId }: { resortId: number | null }) {
  const readiness = trpc.projectSettings.readiness.useQuery({ resortId: resortId ?? undefined }, { enabled: resortId !== null });
  const project = readiness.data?.[0];
  if (resortId === null || !project) return null;
  return <Card data-testid="project-readiness" className={project.ready ? "border-[#cfe0d4] bg-[#f4faf5]" : "border-[#e6c9a8] bg-[#fff8ee]"}><CardContent className="space-y-3 p-5">
    <p className="font-semibold">{project.ready ? "Pronto para o 1º dia" : `Não está pronto para o 1º dia (${project.blocking} bloqueio(s))`}{project.warnings ? ` · ${project.warnings} aviso(s)` : ""}</p>
    <ul className="space-y-2 text-sm">{project.checks.map(check => <li key={check.key} data-testid={`readiness-${check.key}`} className="flex items-start gap-2">
      {check.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#285043]" /> : check.severity === "blocking" ? <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#a64943]" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#a2661b]" />}
      <span><b>{check.label}</b>{check.severity === "blocking" && !check.ok ? " · bloqueia" : ""}<span className="block text-xs text-muted-foreground">{check.detail}{check.code ? ` (${check.code})` : ""}</span></span>
    </li>)}</ul>
  </CardContent></Card>;
}
