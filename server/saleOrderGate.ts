import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { contracts, saleValidations } from "../drizzle/schema";
import type { getDb } from "./db";

/**
 * CRM-B1: ordem da formalização. Proposta -> administrativo confere COMPROVANTE e DOCUMENTAÇÃO -> só então gera o contrato (documento de contrato,
 * assinatura eletrônica) -> assinatura -> validação oficial. Desligado por padrão (SALE_ORDER_GATE_ENABLED); SALE_ORDER_GATE_SINCE (ISO) isenta
 * contratos criados antes (grandfathering do piloto). O comprovante conferido é sale_validations.paymentConfirmed*; a documentação, documentsConferred*.
 */
export const isSaleOrderGateEnabled = () => process.env.SALE_ORDER_GATE_ENABLED === "true";
type Db = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

export function saleOrderGateExempt(contractCreatedAt: Date, since = process.env.SALE_ORDER_GATE_SINCE) {
  if (!since) return false;
  const cutoff = new Date(since);
  return !Number.isNaN(cutoff.getTime()) && contractCreatedAt.getTime() < cutoff.getTime();
}

export async function saleOrderGateState(db: Db, contractId: number) {
  const contract = (await db.select({ createdAt: contracts.createdAt }).from(contracts).where(eq(contracts.id, contractId)).limit(1))[0];
  const validation = (await db.select({ paymentConfirmedAt: saleValidations.paymentConfirmedAt, documentsConferredAt: saleValidations.documentsConferredAt }).from(saleValidations).where(eq(saleValidations.contractId, contractId)).limit(1))[0];
  const receiptConferred = Boolean(validation?.paymentConfirmedAt);
  const documentsConferred = Boolean(validation?.documentsConferredAt);
  const enabled = isSaleOrderGateEnabled();
  const exempt = Boolean(contract && saleOrderGateExempt(contract.createdAt));
  return { enabled, exempt, receiptConferred, documentsConferred, generationAllowed: !enabled || exempt || (receiptConferred && documentsConferred), receiptConferredAt: validation?.paymentConfirmedAt ?? null, documentsConferredAt: validation?.documentsConferredAt ?? null };
}

/** Recusa (PRECONDITION_FAILED, SALE_ORDER_GATE) gerar contrato ou iniciar assinatura antes da conferência do administrativo. */
export async function assertContractGenerationAllowed(db: Db, contractId: number) {
  const state = await saleOrderGateState(db, contractId);
  if (state.generationAllowed) return state;
  const missing = [!state.receiptConferred ? "comprovante" : null, !state.documentsConferred ? "documentação" : null].filter(Boolean).join(" e ");
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: `SALE_ORDER_GATE: o administrativo precisa conferir ${missing} antes de gerar o contrato ou iniciar a assinatura.` });
}

/** Contratos pré-validação: o instante do contrato (documento de contrato ou envelope) não pode ser anterior às conferências (tolerância de 1 s, o MySQL arredonda). */
export function conferralsBeforeGeneration(input: { contractGeneratedAt: Date; receiptConferredAt: Date; documentsConferredAt: Date }) {
  const latestConferral = Math.max(input.receiptConferredAt.getTime(), input.documentsConferredAt.getTime());
  return Math.floor(input.contractGeneratedAt.getTime() / 1000) >= Math.floor(latestConferral / 1000) - 1;
}
