import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  contractSignatureDocuments,
  contractSignatureEnvelopes,
  contractSignatureSigners,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { getClicksignConfig } from "../clicksign";
import { reconcileContractSignature, startContractElectronicSignature } from "../eSignatureService";
import { router } from "../_core/trpc";
import { contractsProcedure } from "./access";

export const electronicSignaturesRouter = router({
  configStatus: contractsProcedure.query(() => {
    const config = getClicksignConfig();
    return {
      provider: "clicksign",
      configured: Boolean(config),
      environment: config?.baseUrl.includes("sandbox.clicksign.com") ? "sandbox" : config ? "custom_or_production" : "unconfigured",
    };
  }),

  listByContract: contractsProcedure.input(z.object({
    contractId: z.number().int().positive(),
    limit: z.number().int().min(1).max(50).default(20),
  })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    const envelopes = await db.select().from(contractSignatureEnvelopes)
      .where(eq(contractSignatureEnvelopes.contractId, input.contractId))
      .orderBy(desc(contractSignatureEnvelopes.createdAt))
      .limit(input.limit);
    if (!envelopes.length) return [];
    const result = [];
    for (const envelope of envelopes) {
      const [documents, signers] = await Promise.all([
        db.select().from(contractSignatureDocuments).where(eq(contractSignatureDocuments.envelopeId, envelope.id)).limit(20),
        db.select().from(contractSignatureSigners).where(eq(contractSignatureSigners.envelopeId, envelope.id)).limit(20),
      ]);
      result.push({ envelope, documents, signers });
    }
    return result;
  }),

  start: contractsProcedure.input(z.object({
    contractId: z.number().int().positive(),
    contractDocumentId: z.number().int().positive(),
  })).mutation(async ({ ctx, input }) => {
    return startContractElectronicSignature({ actorUserId: ctx.user.id, ...input });
  }),

  reconcile: contractsProcedure.input(z.object({
    envelopeId: z.number().int().positive(),
  })).mutation(async ({ ctx, input }) => {
    return reconcileContractSignature({ actorUserId: ctx.user.id, envelopeId: input.envelopeId });
  }),
});
