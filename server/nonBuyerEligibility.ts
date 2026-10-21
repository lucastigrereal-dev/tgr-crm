import { and, eq, inArray, sql } from "drizzle-orm";
import { captureErasureRequests, captureRecords, contracts, customerContactOptouts, customers, opportunities, proposals } from "../drizzle/schema";
import type { getDb } from "./db";

/**
 * C2/C3, fatia 1: elegibilidade de NÃO-COMPRADOR para o Recovery (desenho: docs/audit/ETAPA2_I_DESENHO_ELEGIBILIDADE_RECOVERY.md §3.3).
 * SOMENTE LEITURA e sem efeito: função pura + carregador de fatos. Não grava, não emite evento, não chama ninguém e NÃO consulta a flag
 * (RECOVERY_ELIGIBILITY_ENABLED vale nos chamadores das próximas fatias: projeção, hooks, reconciliação e entrega).
 * Decisão do Lucas (21/10): a FICHA é o consentimento de contato do Recovery; por isso NÃO há gate de "ciente" nem de canal (pendência dele: canais e texto
 * do ciente). Opt-out entra como fato de entrada (`optedOut`), lido de customer_contact_optouts (PROPOSTA 0080) só com `readOptOut`; o receptor recovery.opted_out.v1 grava nela (recoveryOptOutReceiver.ts).
 */
export type EligibilityFacts = {
  presentationStatus: string;
  presentationEndedAt: Date | null;
  ntKind: string | null;
  ntMotiveId: number | null;
  commercialOutcome: "vendeu" | "caiu_em_mesa" | null;
  captureAnonymized: boolean;
  customerAnonymized: boolean;
  erasurePending: boolean;
  optedOut: boolean;
  /** contracts.status de TODOS os contratos do cliente. */
  contractStatuses: string[];
  /** proposals.status das propostas do cliente (proposals não tem customerId: vem de opportunities.customerId). */
  proposalStatuses: string[];
  /** opportunities.stage de TODAS as oportunidades do cliente. */
  opportunityStages: string[];
};

/** Motivos que tiram (ou impedem) o casal do feed; casam com `reason` de crm.non_buyer.eligibility_revoked.v1 quando existe equivalente. */
export type IneligibleReason = "attendance_not_finished" | "anonymized" | "erasure" | "opt_out" | "sale_in_progress";
export type Eligibility = { eligible: true; branch: "closed" | "no_tour"; reasons: [] } | { eligible: false; branch: null; reasons: IneligibleReason[] };

// Enums conferidos em drizzle/schema.ts. `closed` bloqueia: cliente que cumpriu o contrato não é não-comprador (decisão: Opus, 21/10).
const BLOCKING_CONTRACT = (status: string) => status !== "cancelled";
const BLOCKING_PROPOSAL = new Set(["draft", "sent", "approved"]);
// O CRM cria oportunidade `new`/`qualified` para TODA ficha captada: só bloqueia a partir de `proposal`.
const BLOCKING_STAGE = new Set(["proposal", "negotiation", "won"]);

export function saleInProgress(facts: Pick<EligibilityFacts, "contractStatuses" | "proposalStatuses" | "opportunityStages" | "commercialOutcome">) {
  return facts.commercialOutcome === "vendeu" || facts.contractStatuses.some(BLOCKING_CONTRACT) || facts.proposalStatuses.some(s => BLOCKING_PROPOSAL.has(s)) || facts.opportunityStages.some(s => BLOCKING_STAGE.has(s));
}

export function evaluateNonBuyerEligibility(facts: EligibilityFacts): Eligibility {
  const reasons: IneligibleReason[] = [];
  // Ramo A: atendimento ENCERRADO (só endPresentation grava presentationEndedAt; `presented` é atendimento em andamento). Ramo B: não-tour com tipo e motivo.
  const closed = facts.presentationStatus === "closed" && facts.presentationEndedAt != null;
  const noTour = facts.presentationStatus === "no_tour" && facts.ntKind != null && facts.ntMotiveId != null;
  if (!closed && !noTour) reasons.push("attendance_not_finished");
  if (facts.captureAnonymized || facts.customerAnonymized) reasons.push("anonymized");
  if (facts.erasurePending) reasons.push("erasure");
  if (facts.optedOut) reasons.push("opt_out");
  if (saleInProgress(facts)) reasons.push("sale_in_progress");
  if (reasons.length) return { eligible: false, branch: null, reasons };
  return { eligible: true, branch: closed ? "closed" : "no_tour", reasons: [] };
}

/**
 * Funde os fatos lidos na transação do chamador (`own`: enxerga as ESCRITAS dele, mas em REPEATABLE READ pode ser um snapshot anterior a commits concorrentes) com os lidos
 * numa conexão separada em autocommit (`fresh`: enxerga o último commit, não as escritas ainda não comitadas do chamador). Fatos que BLOQUEIAM a elegibilidade valem se
 * QUALQUER um dos lados os vê (união: o erro possível é adiar uma elegibilidade para a reconciliação, nunca emitir elegível para quem fez opt-out/comprou/foi anonimizado).
 * O atendimento (status, tipo e motivo do não-tour) vem do `own`: é o que o gancho acabou de escrever e não pode ser sobrescrito por um commit anterior.
 */
export function mergeBlockingFacts(own: EligibilityFacts, fresh: EligibilityFacts): EligibilityFacts {
  return {
    ...own,
    commercialOutcome: own.commercialOutcome === "vendeu" || fresh.commercialOutcome === "vendeu" ? "vendeu" : own.commercialOutcome ?? fresh.commercialOutcome,
    captureAnonymized: own.captureAnonymized || fresh.captureAnonymized, customerAnonymized: own.customerAnonymized || fresh.customerAnonymized,
    erasurePending: own.erasurePending || fresh.erasurePending, optedOut: own.optedOut || fresh.optedOut,
    contractStatuses: [...own.contractStatuses, ...fresh.contractStatuses], proposalStatuses: [...own.proposalStatuses, ...fresh.proposalStatuses], opportunityStages: [...own.opportunityStages, ...fresh.opportunityStages],
  };
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Opt-out vigente do CLIENTE (vale para todas as fichas dele). A tabela é PROPOSTA (0080): `readOptOut` fica desligado até a migration existir e os chamadores
 * (fatias 3/4, atrás de RECOVERY_ELIGIBILITY_ENABLED) o ligarem; assim este módulo continua funcionando num banco sem a tabela.
 */
export async function hasContactOptOut(executor: Db | Tx, customerId: number): Promise<boolean> {
  const [row] = await executor.select({ id: customerContactOptouts.id }).from(customerContactOptouts).where(eq(customerContactOptouts.customerId, customerId)).limit(1);
  return row != null;
}

/** Lê os fatos do casal (ficha) no executor dado; `null` se a ficha não existe. Somente SELECT. */
export async function loadEligibilityFacts(executor: Db | Tx, captureId: number, options: { readOptOut?: boolean } = {}): Promise<EligibilityFacts | null> {
  const [row] = await executor.select({
    customerId: captureRecords.customerId, presentationStatus: captureRecords.presentationStatus, presentationEndedAt: captureRecords.presentationEndedAt,
    ntKind: captureRecords.ntKind, ntMotiveId: captureRecords.ntMotiveId, commercialOutcome: captureRecords.commercialOutcome,
    captureAnonymizedAt: captureRecords.anonymizedAt, customerAnonymizedAt: customers.anonymizedAt,
  }).from(captureRecords).innerJoin(customers, eq(customers.id, captureRecords.customerId)).where(eq(captureRecords.id, captureId)).limit(1);
  if (!row) return null;
  const [erasure] = await executor.select({ n: sql<number>`COUNT(*)` }).from(captureErasureRequests).where(and(eq(captureErasureRequests.customerId, row.customerId), eq(captureErasureRequests.status, "requested")));
  const contractRows = await executor.select({ status: contracts.status }).from(contracts).where(eq(contracts.customerId, row.customerId));
  const opportunityRows = await executor.select({ id: opportunities.id, stage: opportunities.stage }).from(opportunities).where(eq(opportunities.customerId, row.customerId));
  const proposalRows = opportunityRows.length
    ? await executor.select({ status: proposals.status }).from(proposals).where(inArray(proposals.opportunityId, opportunityRows.map(o => o.id)))
    : [];
  return {
    presentationStatus: row.presentationStatus, presentationEndedAt: row.presentationEndedAt, ntKind: row.ntKind, ntMotiveId: row.ntMotiveId, commercialOutcome: row.commercialOutcome,
    captureAnonymized: row.captureAnonymizedAt != null, customerAnonymized: row.customerAnonymizedAt != null, erasurePending: Number(erasure?.n ?? 0) > 0,
    optedOut: options.readOptOut ? await hasContactOptOut(executor, row.customerId) : false,
    contractStatuses: contractRows.map(r => r.status), proposalStatuses: proposalRows.map(r => r.status), opportunityStages: opportunityRows.map(r => r.stage),
  };
}

export async function evaluateCaptureEligibility(executor: Db | Tx, captureId: number, options: { readOptOut?: boolean } = {}): Promise<Eligibility | null> {
  const facts = await loadEligibilityFacts(executor, captureId, options);
  return facts ? evaluateNonBuyerEligibility(facts) : null;
}
