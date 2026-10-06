import { and, asc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { policyRegistry, resorts } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, financeProcedure } from "./access";
import { affectedRows, isDuplicateKeyError } from "../mysqlErrors";
import { checkPolicyTransition, OPEN_POLICY_TYPES, POLICY_STATUSES } from "../../shared/policyRegistry";

// WP11 (PRD v4 §13): só status/vigência/aprovação de política aberta. Nenhum valor, nenhum motor lê daqui.
const resortInput = z.object({ resortId: z.number().int().positive() });
const SEED_VERSION = "piloto-v1";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  return db;
}

async function requireResort(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, resortId: number) {
  const [resort] = await db.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, resortId)).limit(1);
  if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
}

export const policyRegistryRouter = router({
  list: financeProcedure.input(resortInput).query(async ({ input }) => {
    const db = await requireDb();
    return db.select().from(policyRegistry).where(eq(policyRegistry.resortId, input.resortId))
      .orderBy(asc(policyRegistry.policyType), asc(policyRegistry.createdAt)).limit(200);
  }),

  /** Cria os 8 tipos abertos do PRD §13 como UNAPPROVED (idempotente: o que já existe fica como está). */
  seedOpen: adminProcedure.input(resortInput).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    await requireResort(db, input.resortId);
    let created = 0;
    for (const policyType of OPEN_POLICY_TYPES) {
      try {
        const [row] = await db.insert(policyRegistry).values({ resortId: input.resortId, policyType, version: SEED_VERSION, status: "UNAPPROVED" }).$returningId();
        if (row?.id) {
          created += 1;
          await recordAudit(ctx.user.id, "policy_registry", row.id, "created", `Política aberta ${policyType} ${SEED_VERSION} registrada como UNAPPROVED (NÃO APROVADO).`);
        }
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
    return { created, total: OPEN_POLICY_TYPES.length };
  }),

  create: adminProcedure.input(resortInput.extend({
    policyType: z.enum(OPEN_POLICY_TYPES),
    version: z.string().trim().min(2).max(80),
    validFrom: z.string().date().optional(),
    validTo: z.string().date().optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    await requireResort(db, input.resortId);
    if (input.validFrom && input.validTo && input.validTo < input.validFrom) throw new TRPCError({ code: "BAD_REQUEST", message: "Fim da vigência antes do início." });
    try {
      const [row] = await db.insert(policyRegistry).values({ resortId: input.resortId, policyType: input.policyType, version: input.version, status: "DRAFT", validFrom: input.validFrom ? new Date(input.validFrom) : null, validTo: input.validTo ? new Date(input.validTo) : null }).$returningId();
      if (!row?.id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar a política." });
      await recordAudit(ctx.user.id, "policy_registry", row.id, "created", `Política ${input.policyType} ${input.version} registrada como DRAFT.`);
      return { id: row.id };
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new TRPCError({ code: "CONFLICT", message: "Já existe essa versão para o empreendimento e tipo de política." });
      throw error;
    }
  }),

  transition: adminProcedure.input(z.object({
    id: z.number().int().positive(),
    to: z.enum(POLICY_STATUSES),
    approver: z.string().trim().max(160).optional(),
    receiptRef: z.string().trim().max(255).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [current] = await db.select().from(policyRegistry).where(eq(policyRegistry.id, input.id)).limit(1);
    if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Política não encontrada." });
    const check = checkPolicyTransition(current.status, input.to, input);
    if (!check.ok) throw new TRPCError({ code: check.code === "INVALID_TRANSITION" ? "CONFLICT" : "BAD_REQUEST", message: check.message });
    const approval = input.to === "APPROVED" ? { approver: input.approver!.trim(), receiptRef: input.receiptRef!.trim() } : {};
    // Compare-and-set no status lido: duas transições concorrentes não passam as duas.
    const result = await db.update(policyRegistry).set({ status: input.to, ...approval })
      .where(and(eq(policyRegistry.id, input.id), eq(policyRegistry.status, current.status)));
    // Falha fechada: só segue se exatamente 1 linha mudou (null = formato desconhecido do driver também recusa).
    if (affectedRows(result) !== 1) throw new TRPCError({ code: "CONFLICT", message: "A política mudou de status em outra operação. Atualize e tente de novo." });
    await recordAudit(ctx.user.id, "policy_registry", input.id, "status_changed",
      `Política ${current.policyType} ${current.version}: ${current.status} → ${input.to}` + (input.to === "APPROVED" ? ` (aprovador: ${approval.approver}; recibo: ${approval.receiptRef})` : "") + ".");
    return { id: input.id, status: input.to };
  }),
});
