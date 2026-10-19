import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { billingRecords, installments, paymentGatewayIssueIntents } from "../drizzle/schema";
import { asaasBillingType, findAsaasPaymentsByReference, getAsaasIdentificationField, getAsaasPixQrCode, type AsaasConfig, type GatewayBillingType } from "./paymentGateway";
import { txAudit, txEvent } from "./txOutbox";
import { processAsaasWebhook } from "./paymentGatewayWebhook";

/** Estados do Asaas que significam dinheiro recebido: a recuperação deve liquidar, não só recriar a cobrança como "gerada". */
const REMOTE_PAID = ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"];

/**
 * CRM-A10: recuperação durável de cobrança Asaas órfã.
 *
 * `issueGatewayBilling` chama o gateway dentro da transação local. Se a transação falhar depois
 * que o Asaas criou a cobrança, a cobrança existe só do lado remoto. A intenção gravada antes da
 * chamada (fora da transação) permite reconstruir o registro local a partir do gateway, usando a
 * referência externa determinística. Nada aqui cria cobrança nova no gateway: só lê e reconcilia.
 */
export const GATEWAY_INTENT_MIN_AGE_MS = 10 * 60_000;
export const GATEWAY_INTENT_MAX_ATTEMPTS = 10;
const CLOSED_INSTALLMENT = ["paid", "cancelled", "renegotiated"];

type Db = NonNullable<Awaited<ReturnType<typeof import("./db").getDb>>>;

export async function registerIssueIntent(db: Db, input: { installmentId: number; type: GatewayBillingType; externalReference: string; actorUserId: number }) {
  await db.insert(paymentGatewayIssueIntents).values({ gatewayProvider: "asaas", installmentId: input.installmentId, type: input.type, externalReference: input.externalReference, actorUserId: input.actorUserId, status: "pending" })
    .onDuplicateKeyUpdate({ set: { status: "pending", externalReference: input.externalReference, actorUserId: input.actorUserId, attempts: 0, lastError: null, gatewayPaymentId: null, updatedAt: new Date() } });
}

export async function markIssueIntentRecorded(tx: Pick<Db, "update">, input: { installmentId: number; type: GatewayBillingType; gatewayPaymentId: string; status?: "recorded" | "recovered" }) {
  await tx.update(paymentGatewayIssueIntents).set({ status: input.status ?? "recorded", gatewayPaymentId: input.gatewayPaymentId, lastError: null })
    .where(and(eq(paymentGatewayIssueIntents.gatewayProvider, "asaas"), eq(paymentGatewayIssueIntents.installmentId, input.installmentId), eq(paymentGatewayIssueIntents.type, input.type)));
}

export type OrphanRecoveryResult = { scanned: number; recovered: number; recorded: number; abandoned: number; manualReview: number; failed: number };

export async function recoverOrphanGatewayBillings(db: Db, config: AsaasConfig, options: { minAgeMs?: number; limit?: number; now?: Date } = {}): Promise<OrphanRecoveryResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.minAgeMs ?? GATEWAY_INTENT_MIN_AGE_MS));
  const result: OrphanRecoveryResult = { scanned: 0, recovered: 0, recorded: 0, abandoned: 0, manualReview: 0, failed: 0 };
  const intents = await db.select().from(paymentGatewayIssueIntents)
    .where(and(eq(paymentGatewayIssueIntents.status, "pending"), lte(paymentGatewayIssueIntents.updatedAt, cutoff)))
    .orderBy(paymentGatewayIssueIntents.updatedAt).limit(options.limit ?? 50);
  for (const intent of intents) {
    result.scanned += 1;
    try {
      const expectedType = asaasBillingType(intent.type);
      const remote = (await findAsaasPaymentsByReference(config, intent.externalReference)).data?.find(item => item.externalReference === intent.externalReference && item.billingType === expectedType);
      if (!remote) {
        await db.update(paymentGatewayIssueIntents).set({ status: "abandoned", lastError: null }).where(and(eq(paymentGatewayIssueIntents.id, intent.id), eq(paymentGatewayIssueIntents.status, "pending")));
        result.abandoned += 1;
        continue;
      }
      // Detalhes de boleto/PIX são lidos fora da transação (chamadas remotas somente leitura).
      const remotePaid = REMOTE_PAID.includes(String(remote.status ?? "").toUpperCase());
      const identification = intent.type === "boleto" ? await getAsaasIdentificationField(config, remote.id) : null;
      const pix = intent.type === "pix" ? await getAsaasPixQrCode(config, remote.id) : null;
      const outcome = await db.transaction(async tx => {
        const installment = (await tx.select().from(installments).where(eq(installments.id, intent.installmentId)).limit(1).for("update"))[0];
        const fresh = (await tx.select({ status: paymentGatewayIssueIntents.status }).from(paymentGatewayIssueIntents).where(eq(paymentGatewayIssueIntents.id, intent.id)).limit(1).for("update"))[0];
        if (!fresh || fresh.status !== "pending") return "skipped" as const;
        const local = (await tx.select({ id: billingRecords.id }).from(billingRecords).where(and(eq(billingRecords.gatewayProvider, "asaas"), eq(billingRecords.gatewayPaymentId, remote.id))).orderBy(desc(billingRecords.createdAt)).limit(1))[0];
        if (local) {
          if (remotePaid) return "settle_existing" as const;
          await markIssueIntentRecorded(tx, { installmentId: intent.installmentId, type: intent.type, gatewayPaymentId: remote.id });
          return "recorded" as const;
        }
        if (!installment || CLOSED_INSTALLMENT.includes(installment.status)) {
          // A cobrança remota existe, mas a parcela não aceita mais cobrança: decisão humana (cancelar no gateway).
          await tx.update(paymentGatewayIssueIntents).set({ status: "manual_review", gatewayPaymentId: remote.id, lastError: "parcela_encerrada" }).where(eq(paymentGatewayIssueIntents.id, intent.id));
          await txAudit(tx, { actorUserId: intent.actorUserId, entityType: "installment", entityId: intent.installmentId, action: "gateway_orphan_needs_review", summary: `Cobrança Asaas ${remote.id} existe no gateway, mas a parcela ${intent.installmentId} está encerrada: cancelar no gateway.`, idempotencyKey: `billing-orphan-review:${remote.id}` });
          return "manual_review" as const;
        }
        const outstanding = Number((Number(installment.amount) - Number(installment.paidAmount ?? 0)).toFixed(2));
        const created = await tx.insert(billingRecords).values({ installmentId: intent.installmentId, type: intent.type, status: "generated", gatewayProvider: "asaas", gatewayPaymentId: remote.id, gatewayStatus: remote.status || "PENDING", amount: (typeof remote.value === "number" ? remote.value : outstanding).toFixed(2), dueDate: installment.dueDate, externalReference: intent.externalReference, digitableLine: identification?.identificationField || null, pixCopyPaste: pix?.payload || null, pixQrCodeBase64: pix?.encodedImage || null, invoiceUrl: remote.invoiceUrl || null, bankSlipUrl: remote.bankSlipUrl || null, generatedAt: new Date() }).$returningId();
        const id = created[0]?.id;
        if (!id) throw new Error("billing_insert_failed");
        await txAudit(tx, { actorUserId: intent.actorUserId, entityType: "billing_record", entityId: id, action: "gateway_recovered", summary: `Cobrança ${intent.type.toUpperCase()} órfã do Asaas recuperada para a parcela ${intent.installmentId}.` });
        await txEvent(tx, { eventName: "financial.billing.created", aggregateType: "billing_record", aggregateId: id, actorUserId: intent.actorUserId, payload: { installmentId: intent.installmentId, gatewayProvider: "asaas", gatewayPaymentId: remote.id, type: intent.type, recovered: true }, idempotencyKey: `billing-recovered:${remote.id}` });
        // Cobrança já paga no gateway: a intenção só fecha depois da liquidação (abaixo), para um novo ciclo repetir se ela falhar.
        if (remotePaid) return "created_paid" as const;
        await markIssueIntentRecorded(tx, { installmentId: intent.installmentId, type: intent.type, gatewayPaymentId: remote.id, status: "recovered" });
        return "recovered" as const;
      });
      let finalOutcome: typeof outcome | "recovered" | "recorded" = outcome;
      if (outcome === "settle_existing" || outcome === "created_paid") {
        // Mesmo caminho do webhook (baixa, recebimento, comissão e fatos do Financial na mesma transação), idempotente por evento sintético.
        const settled = await processAsaasWebhook(config.webhookToken, { id: `recovery:${remote.id}`, event: remote.status === "CONFIRMED" ? "PAYMENT_CONFIRMED" : "PAYMENT_RECEIVED", payment: { id: remote.id, status: remote.status } });
        if (settled.status !== 200) throw new Error(`settle_failed_${settled.status}`);
        finalOutcome = outcome === "created_paid" ? "recovered" : "recorded";
        await markIssueIntentRecorded(db, { installmentId: intent.installmentId, type: intent.type, gatewayPaymentId: remote.id, status: finalOutcome });
      }
      if (finalOutcome === "recovered") result.recovered += 1;
      else if (finalOutcome === "recorded") result.recorded += 1;
      else if (finalOutcome === "manual_review") result.manualReview += 1;
    } catch (error) {
      result.failed += 1;
      const attempts = intent.attempts + 1;
      await db.update(paymentGatewayIssueIntents).set({ attempts, lastError: (error instanceof Error ? error.message : "erro").slice(0, 250), ...(attempts >= GATEWAY_INTENT_MAX_ATTEMPTS ? { status: "manual_review" as const } : {}) }).where(eq(paymentGatewayIssueIntents.id, intent.id)).catch(() => undefined);
    }
  }
  return result;
}

export type GatewayRecoveryJob = { stop: () => void; runOnce: () => Promise<OrphanRecoveryResult | null> };

export function startGatewayRecoveryJob(options: { getDb: () => Promise<Db | null>; getConfig: () => AsaasConfig | null; intervalMs?: number; minAgeMs?: number; onError?: (error: unknown) => void; onRun?: (result: OrphanRecoveryResult) => void }): GatewayRecoveryJob {
  let running = false;
  let stopped = false;
  const runOnce = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const config = options.getConfig();
      const db = await options.getDb();
      if (!config || !db) return null;
      const result = await recoverOrphanGatewayBillings(db, config, { minAgeMs: options.minAgeMs });
      options.onRun?.(result);
      return result;
    } catch (error) { options.onError?.(error); return null; } finally { running = false; }
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 5 * 60_000);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); }, runOnce };
}
