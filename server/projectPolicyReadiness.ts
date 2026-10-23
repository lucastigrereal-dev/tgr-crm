import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { commercialFractions, commercialPolicyVersions, commercialProjectSettings, resorts } from "../drizzle/schema";
import { commissionPolicySchema } from "../shared/projectPolicySchemas";
import { resolveCommissionPolicy } from "./commissionPolicyVersion";
import type { getDb } from "./db";
import { parseCancellationPolicy, parseRequiredContractDocuments } from "./projectPolicy";
import { saleTermsPolicySchema } from "./saleTermsPolicy";

/**
 * F1.12: política do projeto completa ANTES do 1º dia. Na homologação a comissão V1 ficou bloqueada por `incomplete_project_policy` (sales_commissions = 0) porque ninguém
 * conferiu a configuração do empreendimento antes de vender. Este checklist usa as MESMAS leituras dos motores (comissão: `resolveCommissionPolicy`; venda: a política `sale_terms`
 * vigente), então "completo" aqui é exatamente "não bloqueia" lá. `blocking` impede o dia 1; `warning` pede atenção, mas não trava.
 */
export type ReadinessSeverity = "blocking" | "warning";
export type ReadinessCheck = {
  key: "commission_policy" | "commission_rates" | "sale_terms_policy" | "cancellation_policy" | "contract_documents" | "inventory" | "project_mapping";
  severity: ReadinessSeverity;
  ok: boolean;
  /** Código estável: `incomplete_project_policy`, `SALE_TERMS_POLICY_MISSING` e `SALE_TERMS_POLICY_AMBIGUOUS` são os que o motor grava/recusa; `SALE_TERMS_POLICY_INVALID` é só do checklist (no receptor, `parseSaleTermsPolicy` lança ZodError e cai na falha genérica, sem este código). */
  code: string | null;
  /** true = `code` é um código que o motor/receptor realmente grava ou recusa; false = rótulo só do checklist (ex.: SALE_TERMS_POLICY_INVALID). Quem automatiza sobre `--json` deve usar este campo, não o prefixo do código. */
  engineCode: boolean;
  label: string;
  detail: string;
};
export type ProjectReadiness = { resortId: number; resortName: string; ready: boolean; blocking: number; warnings: number; checks: ReadinessCheck[] };

const COMMISSION_FIELD_LABELS: Record<string, string> = {
  cancellationDeadlineDay: "dia do prazo de cancelamento", expectedPaymentDay: "dia previsto do pagamento", eligiblePaymentMethods: "formas de pagamento elegíveis", basis: "base de cálculo (eligible_receipt)",
  linerRate: "percentual do consultor", closerRate: "percentual do fechador", ftbRate: "percentual do FTB",
};

/** Campos que faltam ou estão inválidos na política de comissão (texto bruto do cadastro). Vazio = completa. Não altera nada. */
export function commissionPolicyGaps(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return ["política de comissão não cadastrada"];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return ["JSON ilegível"]; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["JSON deve ser um objeto"];
  const parsed = commissionPolicySchema.safeParse(value);
  if (parsed.success) return [];
  const gaps = parsed.error.issues.map(issue => {
    const field = String(issue.path[0] ?? "");
    if (issue.code === "unrecognized_keys") return `campo(s) desconhecido(s): ${(issue as { keys?: string[] }).keys?.join(", ") ?? "?"}`;
    return COMMISSION_FIELD_LABELS[field] ?? (field || "política");
  });
  return Array.from(new Set(gaps));
}

export type ReadinessInput = {
  resort: { id: number; name: string; externalKey: string | null };
  commission: { source: "versioned" | "legacy" | "none"; complete: boolean; gaps: string[]; allRatesZero: boolean };
  settings: { cancellationPolicy: string | null; requiredContractDocuments: string | null } | null;
  saleTerms: "ok" | "missing" | "ambiguous" | "invalid";
  availableFractions: number;
};

export function evaluateProjectReadiness(input: ReadinessInput): ProjectReadiness {
  const checks: ReadinessCheck[] = [];
  const commissionDetail = input.commission.complete
    ? `Política completa (${input.commission.source === "versioned" ? "versão vigente" : "cadastro do empreendimento"}).`
    : `Falta: ${input.commission.gaps.join("; ")}. Sem ela a comissão automática fica bloqueada (incomplete_project_policy).`;
  checks.push({ key: "commission_policy", severity: "blocking", ok: input.commission.complete, code: input.commission.complete ? null : "incomplete_project_policy", engineCode: !input.commission.complete, label: "Política de comissão V1 completa", detail: commissionDetail });
  checks.push({ key: "commission_rates", severity: "warning", ok: !input.commission.complete || !input.commission.allRatesZero, code: null, engineCode: false, label: "Percentual de comissão acima de 0%", detail: !input.commission.complete ? "Depende da política de comissão estar completa." : input.commission.allRatesZero ? "Todos os percentuais estão em 0%: nenhuma comissão será lançada (ADR-010). Confirme que é isso mesmo." : "Pelo menos um percentual acima de 0%." });
  const saleTermsCode = { ok: null, missing: "SALE_TERMS_POLICY_MISSING", ambiguous: "SALE_TERMS_POLICY_AMBIGUOUS", invalid: "SALE_TERMS_POLICY_INVALID" } as const;
  const saleTermsDetail = { ok: "Política de condições da venda vigente e única.", missing: "Sem política sale_terms vigente: o CRM recusa toda venda do Sales deste empreendimento.", ambiguous: "Duas políticas sale_terms com a mesma vigência: o CRM recusa a venda até sobrar uma.", invalid: "A política sale_terms vigente não passa na validação (modelo de uso e parcelas do saldo): a venda falha." } as const;
  checks.push({ key: "sale_terms_policy", severity: "blocking", ok: input.saleTerms === "ok", code: saleTermsCode[input.saleTerms], engineCode: input.saleTerms === "missing" || input.saleTerms === "ambiguous", label: "Condições da venda (sale_terms) vigentes", detail: saleTermsDetail[input.saleTerms] });
  const cancellation = parseCancellationPolicy(input.settings?.cancellationPolicy);
  const cancellationOk = cancellation.penaltyRate !== undefined && cancellation.penaltyBase !== undefined && cancellation.refundMode !== undefined;
  checks.push({ key: "cancellation_policy", severity: "warning", ok: cancellationOk, code: null, engineCode: false, label: "Distrato: multa, base e reembolso definidos", detail: cancellationOk ? "Multa, base e reembolso definidos." : "Falta multa, base da multa ou regra de reembolso; o distrato dependeria de decisão manual." });
  const documents = parseRequiredContractDocuments(input.settings?.requiredContractDocuments);
  checks.push({ key: "contract_documents", severity: "warning", ok: documents.length > 0, code: null, engineCode: false, label: "Documentos obrigatórios do contrato listados", detail: documents.length ? `${documents.length} documento(s) obrigatório(s).` : "Nenhum documento obrigatório definido: a conferência do administrativo não tem lista para checar." });
  checks.push({ key: "inventory", severity: "warning", ok: input.availableFractions > 0, code: input.availableFractions > 0 ? null : "INSUFFICIENT_INVENTORY", engineCode: input.availableFractions <= 0, label: "Cotas disponíveis para vender", detail: input.availableFractions > 0 ? `${input.availableFractions} cota(s) disponível(is).` : "Nenhuma cota disponível: toda venda será recusada por falta de estoque." });
  checks.push({ key: "project_mapping", severity: "warning", ok: Boolean(input.resort.externalKey), code: input.resort.externalKey ? null : "PROJECT_NOT_MAPPED", engineCode: !input.resort.externalKey, label: "Empreendimento ligado ao projeto do Sales", detail: input.resort.externalKey ? "Chave externa do projeto gravada." : "Sem chave do projeto do Sales: a primeira venda casa pelo NOME exato do empreendimento e grava a chave; nome diferente é recusado." });
  const blocking = checks.filter(check => check.severity === "blocking" && !check.ok).length;
  const warnings = checks.filter(check => check.severity === "warning" && !check.ok).length;
  return { resortId: input.resort.id, resortName: input.resort.name, ready: blocking === 0, blocking, warnings, checks };
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Condições da venda vigentes agora, com a mesma regra do receptor da venda: a mais recente por vigência; empate na mesma vigência = ambígua; JSON fora do esquema = inválida. */
async function saleTermsState(db: Db, resortId: number, now: Date): Promise<ReadinessInput["saleTerms"]> {
  const rows = await db.select().from(commercialPolicyVersions).where(and(
    eq(commercialPolicyVersions.resortId, resortId), eq(commercialPolicyVersions.policyType, "sale_terms"),
    lte(commercialPolicyVersions.effectiveAt, now), or(isNull(commercialPolicyVersions.retiredAt), gt(commercialPolicyVersions.retiredAt, now)),
  )).orderBy(desc(commercialPolicyVersions.effectiveAt), desc(commercialPolicyVersions.id)).limit(2);
  const current = rows[0];
  if (!current) return "missing";
  if (rows[1] && rows[1].effectiveAt.getTime() === current.effectiveAt.getTime()) return "ambiguous";
  try { return saleTermsPolicySchema.safeParse(JSON.parse(current.policyJson)).success ? "ok" : "invalid"; } catch { return "invalid"; }
}

/** Checklist de todos os empreendimentos ativos (ou de um só). Somente leitura. */
export async function loadProjectReadiness(db: Db, options: { resortId?: number; now?: Date } = {}): Promise<ProjectReadiness[]> {
  const now = options.now ?? new Date();
  const rows = await db.select({ resort: resorts, settings: commercialProjectSettings }).from(resorts)
    .leftJoin(commercialProjectSettings, eq(commercialProjectSettings.resortId, resorts.id))
    .where(options.resortId ? eq(resorts.id, options.resortId) : eq(resorts.status, "active"));
  const available = await db.select({ resortId: commercialFractions.resortId, total: sql<number>`COUNT(*)` }).from(commercialFractions).where(eq(commercialFractions.status, "available")).groupBy(commercialFractions.resortId);
  const availableBy = new Map(available.map(row => [row.resortId, Number(row.total)]));
  const out: ProjectReadiness[] = [];
  for (const { resort, settings } of rows) {
    const resolved = await resolveCommissionPolicy(db, resort.id, now);
    const raw = settings?.commissionPolicy;
    const policy = resolved.policy;
    out.push(evaluateProjectReadiness({
      resort: { id: resort.id, name: resort.name, externalKey: resort.externalKey },
      commission: {
        source: resolved.source, complete: Boolean(policy),
        // Com versão vigente ilegível o motor bloqueia (não cai no legado): o motivo é da versão, não do cadastro.
        gaps: policy ? [] : resolved.source === "versioned" ? ["a versão de comissão vigente está incompleta ou ilegível"] : commissionPolicyGaps(raw),
        allRatesZero: policy ? [policy.linerRate, policy.closerRate, policy.ftbRate].every(rate => rate === 0) : false,
      },
      settings: settings ? { cancellationPolicy: settings.cancellationPolicy, requiredContractDocuments: settings.requiredContractDocuments } : null,
      saleTerms: await saleTermsState(db, resort.id, now),
      availableFractions: availableBy.get(resort.id) ?? 0,
    }));
  }
  return out.sort((a, b) => a.resortName.localeCompare(b.resortName, "pt-BR"));
}
