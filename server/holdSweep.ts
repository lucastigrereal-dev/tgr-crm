import { and, eq, inArray, lte } from "drizzle-orm";
import { commercialFractionHistory, commercialFractionHolds, commercialFractions } from "../drizzle/schema";
import type { getDb } from "./db";
import { txAudit, txEvent } from "./txOutbox";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type HoldSweepOutcome = { holds: number; fractions: number[] };

/**
 * Libera holds vencidos (CRM-PK-11). Serve ao botão do admin e ao job automático.
 * Trava na MESMA ordem de `inventory.createHold` (cota primeiro, depois o hold) para não dar deadlock com uma reserva em curso.
 * O hold fica como `expired` (histórico preservado); a cota só volta a `available` se ainda estiver `held`.
 * Cada cota liberada grava histórico, auditoria e o evento `commercial.fraction.status.changed` na mesma transação.
 */
export async function sweepExpiredHolds(db: Db, options: { actorUserId: number | null; now?: Date }): Promise<HoldSweepOutcome> {
  const now = options.now ?? new Date();
  return db.transaction(async tx => {
    const candidates = await tx.select({ id: commercialFractionHolds.id, fractionId: commercialFractionHolds.fractionId })
      .from(commercialFractionHolds)
      .where(and(eq(commercialFractionHolds.status, "active"), lte(commercialFractionHolds.expiresAt, now)));
    if (!candidates.length) return { holds: 0, fractions: [] };
    const fractionIds = Array.from(new Set(candidates.map(item => item.fractionId))).sort((a, b) => a - b);
    const lockedFractions = await tx.select().from(commercialFractions).where(inArray(commercialFractions.id, fractionIds)).orderBy(commercialFractions.id).for("update");
    const expired = await tx.select().from(commercialFractionHolds)
      .where(and(inArray(commercialFractionHolds.id, candidates.map(item => item.id)), eq(commercialFractionHolds.status, "active"), lte(commercialFractionHolds.expiresAt, now)))
      .for("update");
    if (!expired.length) return { holds: 0, fractions: [] };
    await tx.update(commercialFractionHolds).set({ status: "expired", activeKey: null, releasedAt: now, releaseReason: "TTL expirado" })
      .where(inArray(commercialFractionHolds.id, expired.map(item => item.id)));
    const expiredFractionIds = new Set(expired.map(item => item.fractionId));
    const released = lockedFractions.filter(item => item.status === "held" && expiredFractionIds.has(item.id)).map(item => item.id);
    if (released.length) {
      await tx.update(commercialFractions).set({ status: "available", currentProposalId: null, heldUntil: null }).where(and(inArray(commercialFractions.id, released), eq(commercialFractions.status, "held")));
      await tx.insert(commercialFractionHistory).values(released.map(fractionId => ({
        fractionId, fromStatus: "held" as const, toStatus: "available" as const,
        proposalId: expired.find(item => item.fractionId === fractionId)?.proposalId ?? null,
        actorUserId: options.actorUserId, reason: "Sweep de hold expirado",
      })));
      for (const fractionId of released) {
        const hold = expired.find(item => item.fractionId === fractionId);
        await txEvent(tx, { eventName: "commercial.fraction.status.changed", aggregateType: "commercial_fraction", aggregateId: fractionId, actorUserId: options.actorUserId, payload: { fractionId, status: "available", holdId: hold?.id ?? null, reason: "TTL expirado" } });
      }
    }
    await txAudit(tx, { actorUserId: options.actorUserId, entityType: "commercial_inventory", entityId: "expired_holds", action: "swept", summary: `${expired.length} holds expirados; ${released.length} cotas liberadas.` });
    return { holds: expired.length, fractions: released };
  });
}
