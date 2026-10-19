import { TRPCError } from "@trpc/server";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { auditLogs, domainEvents } from "../drizzle/schema";
import { requestBridgeRewind } from "./bridgeRewind";
import type { getDb } from "./db";
import { BRIDGE_RECEIPTS } from "./integrationHealth";
import { txAudit } from "./txOutbox";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Botão "reenviar" do painel de integrações (CRM-A25). O recibo de recusa (audit_logs, chave `<prefixo><id>`) é o que faz a ponte
 * parar de tentar. Reenviar NÃO apaga o recibo (a trilha é só de acrescentar): a chave dele é trocada por `resent:<id>:<chave
 * original>`, o evento volta a ficar sem recibo e a ponte dona recua o cursor para relê-lo. Se o outro sistema recusar de novo, nasce
 * um recibo novo e o painel mostra a nova recusa. A troca e a trilha do pedido (quem reenviou) acontecem na mesma transação.
 */
export async function resendRejectedReceipt(db: Db, input: { receiptId: number; actorUserId: number }) {
  const outcome = await db.transaction(async tx => {
    const [receipt] = await tx.select().from(auditLogs).where(eq(auditLogs.id, input.receiptId)).limit(1).for("update");
    if (!receipt || !receipt.action.endsWith("_rejected") || !receipt.idempotencyKey) throw new TRPCError({ code: "NOT_FOUND", message: "Recibo de recusa não encontrado." });
    const bridge = BRIDGE_RECEIPTS.find(candidate => receipt.idempotencyKey!.startsWith(candidate.receiptPrefix));
    if (!bridge) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Este recibo já foi reenviado ou não é de uma ponte." });
    const newKey = `resent:${receipt.id}:${receipt.idempotencyKey}`;
    if (newKey.length > 200) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Chave do recibo longa demais para reenviar." });

    // Primeiro evento a reler: financeiro = o próprio id do recibo; estado do contrato = o evento mais antigo do contrato.
    const suffix = receipt.idempotencyKey.slice(bridge.receiptPrefix.length);
    let rewindTo: number | null = null;
    if (bridge.key === "financial") {
      const id = Number(suffix);
      if (Number.isInteger(id) && id > 0) {
        const [exists] = await tx.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.id, id)).limit(1);
        if (exists) rewindTo = id;
      }
    } else {
      const contractId = suffix.split(":")[0] ?? "";
      const [first] = await tx.select({ id: sql<number | null>`MIN(${domainEvents.id})` }).from(domainEvents).where(and(eq(domainEvents.aggregateId, contractId), inArray(domainEvents.eventName, [...bridge.eventNames])));
      rewindTo = first?.id ? Number(first.id) : null;
    }
    if (rewindTo === null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "O evento deste recibo não existe mais; não há o que reenviar." });

    await tx.update(auditLogs).set({ idempotencyKey: newKey }).where(eq(auditLogs.id, receipt.id));
    await txAudit(tx, { actorUserId: input.actorUserId, entityType: "integration_event", entityId: receipt.entityId, action: "integration_resend_requested", summary: `Reenvio pedido para ${bridge.label} (recibo de recusa ${receipt.id}). A recusa antiga fica na trilha.`, idempotencyKey: `resend-request:${receipt.id}` });
    return { bridge: bridge.key, receiptPrefix: bridge.receiptPrefix, rewindTo };
  });
  // Só depois do commit: a ponte não pode reler antes de a chave nova existir.
  requestBridgeRewind(outcome.receiptPrefix, outcome.rewindTo);
  return { bridge: outcome.bridge, rewindTo: outcome.rewindTo };
}

/** Reenvios já pedidos (mais novos primeiro), para o painel mostrar que o pedido foi aceito. */
export function recentResends(db: Db) {
  return db.select({ id: auditLogs.id, entityId: auditLogs.entityId, summary: auditLogs.summary, createdAt: auditLogs.createdAt }).from(auditLogs).where(like(auditLogs.action, "integration_resend_requested")).orderBy(sql`${auditLogs.id} DESC`).limit(10);
}
