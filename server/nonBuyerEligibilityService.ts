import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { captureRecords, nonBuyerEligibilityState } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getDb } from "./db";
import { logger } from "./logger";
import { getFreshReader, withFreshTimeout } from "./nonBuyerFreshReader";
import { evaluateNonBuyerEligibility, loadEligibilityFacts, mergeBlockingFacts, type IneligibleReason } from "./nonBuyerEligibility";
import { isDeadlockError, isLockWaitTimeoutError, withDeadlockRetry } from "./mysqlErrors";
import { txEvent, type Tx } from "./txOutbox";

/**
 * C2/C3 fatia 3: projeção `non_buyer_eligibility_state` + serviço de reavaliação + reconciliação (desenho §3.4). Tabela PROPOSTA (0080): só existe depois do GO.
 * DESLIGADO por padrão (RECOVERY_ELIGIBILITY_ENABLED=false): `reevaluateIfEnabled*` não toca em nada e o job nem sobe. Eventos de saída para o Recovery NÃO existem aqui
 * (fatia 5, exige contrato novo com a Suite): a transição só grava um evento INTERNO sem PII em domain_events (`non_buyer.eligible` / `non_buyer.eligibility_revoked`),
 * que nenhuma ponte drena (todas filtram por lista de nomes).
 *
 * ORDEM DE LOCKS (para os ganchos da fatia 4 não darem deadlock com a reconciliação nem entre si):
 *  1. O gancho roda DEPOIS da escrita de negócio, na MESMA transação, como seu ÚLTIMO passo; ela já segura os locks das suas linhas de negócio (contrato, proposta,
 *     oportunidade, ficha). O serviço nunca pede lock de linha de negócio: lê os fatos SEM lock (SELECT consistente).
 *  2. Único lock que o serviço adquire: a linha de `non_buyer_eligibility_state` da ficha (SELECT ... FOR UPDATE; criada ANTES, se faltar, por INSERT ... ON DUPLICATE KEY no-op
 *     SÓ SE a linha não existir (um SELECT simples antes evita queimar AUTO_INCREMENT) e então lida com FOR UPDATE; a ordem inversa dá deadlock por lock de gap). Vários casais do mesmo cliente (reavaliação por contrato/proposta/oportunidade): sempre em ORDEM CRESCENTE de captureId.
 *  3. Nada espera linha de negócio enquanto segura linha de estado (leituras sem lock não esperam). Logo não há ciclo: quem segura estado nunca espera negócio, e quem espera
 *     estado (gancho, já segurando negócio) só espera alguém que termina sem esperar negócio. Reconciliação = uma transação curta POR FICHA (nunca segura mais de uma linha de estado).
 *  4. O serviço não abre transação própria quando recebe `tx` (usa a do chamador); o job abre uma por ficha, com `withDeadlockRetry`. Um gancho que levar deadlock repete a
 *     transação de negócio inteira (mesmo contrato dos demais ganchos do CRM).
 *  POOL (Opus): a leitura fresca do gancho NÃO usa o pool principal (limite 10): N ganchos segurando conexão com tx+locks e pedindo uma segunda esgotariam o pool e travariam
 *  sem timeout. Usa o pool dedicado de 3 conexões de nonBuyerFreshReader (autocommit, nunca segura lock) com timeout de 3s; estourou, o gancho falha e a reconciliação cobre.
 *  FALHA DO GANCHO: `eligibilityHook` roda o serviço num SAVEPOINT (`tx.transaction` aninhada); erro comum (tabela ausente, timeout da leitura fresca, falha de SQL) desfaz só o
 *  savepoint, é registrado sem PII e a transação de negócio segue e comita. Deadlock (1213) e lock wait timeout (1205) NÃO são engolidos: o InnoDB
 *  desfaz a transação de NEGÓCIO inteira (o ROLLBACK TO SAVEPOINT falharia), então o gancho RELANÇA e o erro sobe para o `withDeadlockRetry` da rota ou vira 5xx honesto;
 *  engolir devolveria sucesso sem o contrato/venda gravado (perda silenciosa).
 *  FRESCOR DOS FATOS (Codex P1 do #102): em REPEATABLE READ o snapshot nasce na primeira leitura sem lock, que pode ser ANTES de esperar o lock da linha de estado; o perdedor
 *  da corrida leria a projeção nova (FOR UPDATE) com fatos velhos e poderia emitir a transição inversa (ex.: opt-out concorrente com cancelamento de contrato => "elegível"
 *  depois do opt-out). Locking read nos fatos de negócio criaria ciclo (quem segura estado esperaria linha de negócio de quem espera estado), então:
 *   a) transação NOSSA (reconciliação): READ COMMITTED, cada leitura vê o último commit, e o lock do estado vem antes de qualquer fato;
 *   b) transação do GANCHO (isolamento do negócio, não nos pertence): depois de travar o estado, os fatos são lidos DE NOVO numa conexão separada em autocommit
 *      (`fresh`, leitura simples: não espera lock nenhum) e fundidos com os da transação por UNIÃO dos fatos que bloqueiam (mergeBlockingFacts). A transação enxerga as escritas
 *      do próprio gancho; a conexão separada enxerga todo commit anterior ao lock. O pior caso é ADIAR uma elegibilidade para a reconciliação, nunca emitir elegível a quem
 *      já fez opt-out, comprou ou foi anonimizado. Quem comitar depois reavalia com o mesmo método e enxerga o nosso commit.
 */
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type HookTarget = { captureId: number } | { customerId: number } | { customerIds: number[] };

export type RevokedReason = IneligibleReason;
// Prioridade do motivo único do evento de revogação (o desenho lista opt_out | anonymized | erasure | sale_validated | sale_in_progress | notice_invalid; o mapeamento
// para os nomes de saída e a distinção sale_validated x sale_in_progress ficam para a fatia 5).
const REASON_PRIORITY: IneligibleReason[] = ["anonymized", "erasure", "opt_out", "sale_in_progress", "attendance_not_finished"];
export const primaryReason = (reasons: IneligibleReason[]): IneligibleReason => REASON_PRIORITY.find(reason => reasons.includes(reason)) ?? reasons[0]!;

export type ReevaluationResult = { captureId: number; changed: boolean; eligible: boolean; seq: number; eventId: string | null };

/** Garante e TRAVA a linha de estado da ficha (única aquisição de lock do serviço). */
async function lockState(tx: Tx, captureId: number, customerId: number) {
  // 1) SELECT simples SEM lock: se a linha existe, não há INSERT (INSERT ... ON DUPLICATE KEY consome AUTO_INCREMENT mesmo quando a linha já existe; a reconciliação de 10 min
  //    sobre todas as fichas estouraria o int). 2) Só se faltar: INSERT ... ON DUPLICATE KEY (no-op) ANTES do SELECT ... FOR UPDATE: o FOR UPDATE numa linha inexistente pega
  //    lock de GAP nas duas transações e o INSERT seguinte de ambas dá deadlock (reproduzido em teste). 3) SELECT ... FOR UPDATE: o único lock.
  const [present] = await tx.select({ id: nonBuyerEligibilityState.id }).from(nonBuyerEligibilityState).where(eq(nonBuyerEligibilityState.captureId, captureId)).limit(1);
  if (!present) await tx.insert(nonBuyerEligibilityState).values({ captureId, customerId }).onDuplicateKeyUpdate({ set: { captureId: sql`captureId` } });
  const [row] = await tx.select().from(nonBuyerEligibilityState).where(eq(nonBuyerEligibilityState.captureId, captureId)).limit(1).for("update");
  return row!;
}

/** Reavalia UMA ficha dentro da transação do chamador; emite no máximo um evento interno (a DIFERENÇA em relação à projeção). */
export async function reevaluateCapture(tx: Tx, captureId: number, options: { now?: Date; fresh?: Db } = {}): Promise<ReevaluationResult | null> {
  const now = options.now ?? new Date();
  const [capture] = await tx.select({ customerId: captureRecords.customerId }).from(captureRecords).where(eq(captureRecords.id, captureId)).limit(1);
  if (!capture) return null;
  const state = await lockState(tx, captureId, capture.customerId);
  // Só DEPOIS do lock do estado. `fresh` (hooks) = leitura sem lock em outra conexão com o último commit; ver "FRESCOR DOS FATOS".
  const own = (await loadEligibilityFacts(tx, captureId, { readOptOut: true }))!;
  const fresh = options.fresh ? await withFreshTimeout(loadEligibilityFacts(options.fresh, captureId, { readOptOut: true })) : null;
  const verdict = evaluateNonBuyerEligibility(fresh ? mergeBlockingFacts(own, fresh) : own);
  if (verdict.eligible === state.eligible) return { captureId, changed: false, eligible: state.eligible, seq: state.seq, eventId: null };
  const seq = state.seq + 1;
  const kind = verdict.eligible ? "eligible" : "revoked";
  const eventId = `crm-nb-${captureId}-${kind}-${seq}`;
  const reason = verdict.eligible ? null : primaryReason(verdict.reasons);
  await tx.update(nonBuyerEligibilityState).set({ eligible: verdict.eligible, seq, lastReason: reason, lastEmittedAt: now }).where(eq(nonBuyerEligibilityState.id, state.id));
  await txEvent(tx, {
    eventName: verdict.eligible ? "non_buyer.eligible" : "non_buyer.eligibility_revoked", aggregateType: "capture", aggregateId: captureId, actorUserId: null, idempotencyKey: eventId,
    // Sem PII: ids, sequência, ramo e motivo. Nome e telefone nunca entram aqui (montados na entrega, fatia 5).
    payload: { eventId, captureId, customerId: capture.customerId, seq, ...(verdict.eligible ? { branch: verdict.branch } : { reason }) },
  });
  return { captureId, changed: true, eligible: verdict.eligible, seq, eventId };
}

/** Reavaliação disparada por CLIENTE (contrato, proposta ou oportunidade só conhecem o cliente): todas as fichas dele, em ordem crescente de captureId. */
export async function reevaluateCustomer(tx: Tx, customerId: number, options: { now?: Date; fresh?: Db } = {}): Promise<ReevaluationResult[]> {
  const captures = await tx.select({ id: captureRecords.id }).from(captureRecords).where(eq(captureRecords.customerId, customerId)).orderBy(asc(captureRecords.id));
  const results: ReevaluationResult[] = [];
  for (const { id } of captures) { const result = await reevaluateCapture(tx, id, options); if (result) results.push(result); }
  return results;
}

/** Vários clientes (troca de cliente numa oportunidade): junta as fichas e reavalia em ORDEM GLOBAL crescente de captureId (A->B x B->A não formam ciclo). */
export async function reevaluateCustomers(tx: Tx, customerIds: number[], options: { now?: Date; fresh?: Db } = {}): Promise<ReevaluationResult[]> {
  const ids = Array.from(new Set(customerIds));
  if (ids.length === 0) return [];
  const captures = await tx.select({ id: captureRecords.id }).from(captureRecords).where(inArray(captureRecords.customerId, ids)).orderBy(asc(captureRecords.id));
  const results: ReevaluationResult[] = [];
  for (const { id } of captures) { const result = await reevaluateCapture(tx, id, options); if (result) results.push(result); }
  return results;
}

/** Porta dos ganchos (fatia 4): com a flag desligada não faz NADA (nem lê a tabela, que pode nem existir). */
export async function reevaluateIfEnabled(tx: Tx, target: HookTarget, enabled: boolean = ENV.recoveryEligibilityEnabled, fresh?: Db): Promise<ReevaluationResult[]> {
  if (!enabled) return [];
  // Leitura fresca num pool DEDICADO e pequeno (nonBuyerFreshReader), nunca no pool principal: ver "POOL" abaixo.
  const options = { fresh: fresh ?? (getFreshReader() as unknown as Db | undefined) };
  if (!options.fresh) throw new Error("DATABASE_URL ausente para a leitura fresca");
  if ("captureId" in target) { const result = await reevaluateCapture(tx, target.captureId, options); return result ? [result] : []; }
  if ("customerIds" in target) return reevaluateCustomers(tx, target.customerIds, options);
  return reevaluateCustomer(tx, target.customerId, options);
}

/**
 * Gancho transacional (fatia 4): chame como ÚLTIMO passo da transação de negócio, passando o `tx` dela. Com a flag desligada não faz nada. Falha comum de
 * elegibilidade não lança (a reconciliação converge depois); deadlock/lock timeout SOBEM (a transação de negócio já foi desfeita pelo MySQL).
 */
export async function eligibilityHook(tx: Tx, target: HookTarget, enabled: boolean = ENV.recoveryEligibilityEnabled, fresh?: Db): Promise<void> {
  if (!enabled) return;
  // Erro ORIGINAL do serviço: quando o InnoDB já desfez a tx inteira (deadlock), o ROLLBACK TO SAVEPOINT do drizzle falha e esse erro (1305) MASCARA o deadlock; por isso o
  // original é guardado aqui dentro e é ele que decide.
  let original: unknown;
  try {
    await tx.transaction(async inner => {
      try { await reevaluateIfEnabled(inner as unknown as Tx, target, true, fresh); } catch (error) { original = error; throw error; }
    });
  } catch (error) {
    const fatal = [original, error].find(candidate => candidate !== undefined && (isDeadlockError(candidate) || isLockWaitTimeoutError(candidate)));
    if (fatal !== undefined) throw fatal;
    if (original !== undefined && error !== original) throw error; // o próprio ROLLBACK TO SAVEPOINT falhou: a tx de negócio está inutilizável, não há o que engolir
    logger.warn("Non-buyer eligibility hook failed; reconciliation will cover it", { errorName: error instanceof Error ? error.name : "non-Error", target: "captureId" in target ? `capture:${target.captureId}` : "customerId" in target ? `customer:${target.customerId}` : "customers" });
  }
}

/**
 * Para pontos de negócio que NÃO são transacionais (rotas de captação que usam `db.update` direto): roda a reavaliação numa transação PRÓPRIA e curta logo DEPOIS do
 * fato (best-effort; não lança). A janela entre o fato e este gancho é coberta pela reconciliação, como qualquer transição esquecida.
 */
export async function eligibilityHookAfterCommit(target: HookTarget, enabled: boolean = ENV.recoveryEligibilityEnabled): Promise<void> {
  if (!enabled) return;
  try {
    const db = await getDb();
    if (!db) return;
    await withDeadlockRetry(() => db.transaction(tx => reevaluateIfEnabled(tx, target, true)));
  } catch (error) {
    logger.warn("Non-buyer eligibility post-commit hook failed; reconciliation will cover it", { errorName: error instanceof Error ? error.name : "non-Error", target: "captureId" in target ? `capture:${target.captureId}` : "customerId" in target ? `customer:${target.customerId}` : "customers" });
  }
}

export type ReconciliationOutcome = { scanned: number; changed: number; eligible: number; revoked: number; nextCursor: number | null };

/**
 * Rede de segurança durável: percorre as fichas candidatas por cursor de captureId (encerradas/não-tour, ou já marcadas elegíveis na projeção, para poder revogar) e
 * reavalia cada uma em transação PRÓPRIA e curta. Idempotente: rodar de novo não emite nada que a projeção já reflita; recomeçar do zero após queda é seguro.
 */
export async function reconcileNonBuyerEligibility(db: Db, options: { afterCaptureId?: number; batchSize?: number; now?: () => Date } = {}): Promise<ReconciliationOutcome> {
  const batchSize = Math.max(1, Math.min(1000, options.batchSize ?? 200));
  const rows = await db.select({ id: captureRecords.id }).from(captureRecords)
    .leftJoin(nonBuyerEligibilityState, eq(nonBuyerEligibilityState.captureId, captureRecords.id))
    .where(and(gt(captureRecords.id, options.afterCaptureId ?? 0), or(inArray(captureRecords.presentationStatus, ["closed", "no_tour"]), eq(nonBuyerEligibilityState.eligible, true))))
    .orderBy(asc(captureRecords.id)).limit(batchSize);
  const outcome: ReconciliationOutcome = { scanned: rows.length, changed: 0, eligible: 0, revoked: 0, nextCursor: rows.length === batchSize ? rows[rows.length - 1]!.id : null };
  for (const { id } of rows) {
    // READ COMMITTED: transação nossa, cada leitura vê o último commit (ver "FRESCOR DOS FATOS"); o lock do estado ainda vem antes de qualquer fato.
    const result = await withDeadlockRetry(() => db.transaction(tx => reevaluateCapture(tx, id, { now: options.now?.() }), { isolationLevel: "read committed" }));
    if (result?.changed) { outcome.changed += 1; if (result.eligible) outcome.eligible += 1; else outcome.revoked += 1; }
  }
  return outcome;
}

/** Uma varredura completa (todas as páginas). */
export async function reconcileAllNonBuyerEligibility(db: Db, options: { batchSize?: number; now?: () => Date } = {}): Promise<ReconciliationOutcome> {
  const total: ReconciliationOutcome = { scanned: 0, changed: 0, eligible: 0, revoked: 0, nextCursor: null };
  let cursor: number | undefined;
  do {
    const page = await reconcileNonBuyerEligibility(db, { ...options, afterCaptureId: cursor });
    total.scanned += page.scanned; total.changed += page.changed; total.eligible += page.eligible; total.revoked += page.revoked;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return total;
}
