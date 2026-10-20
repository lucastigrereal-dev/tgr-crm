import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { captureSheetSettings, saleValidatorGrants } from "../drizzle/schema";
import { getDb } from "./db";
import { assertCapability } from "./routers/access";
import type { Capability } from "./permissions";

/** Interruptor de segregação (padrão DESLIGADO): ligado, quem confere o comprovante/documentação não valida a mesma venda. Só admin muda, com trilha. */
export const SEGREGATION_KEY = "sale_validation_segregation";

type Actor = { id: number; role: string };
type Reader = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function hasActiveGrant(db: Pick<Reader, "select">, userId: number, now = new Date()) {
  const [row] = await db.select({ id: saleValidatorGrants.id }).from(saleValidatorGrants).where(and(
    eq(saleValidatorGrants.userId, userId), isNull(saleValidatorGrants.revokedAt), lte(saleValidatorGrants.validFrom, now),
    or(isNull(saleValidatorGrants.validUntil), gt(saleValidatorGrants.validUntil, now)),
  )).limit(1);
  return Boolean(row);
}

export async function isSaleValidatorAuthorized(actor: Actor, db?: Reader | null) {
  if (actor.role === "admin") return true;
  if (actor.role !== "finance") return false;
  const reader = db ?? await getDb();
  return reader ? hasActiveGrant(reader, actor.id) : false;
}

/** Capacidade do papel (matriz) E, para o financeiro, concessão vigente. Admin sempre passa. */
export async function assertSaleValidator(actor: Actor, capability: Capability, message: string) {
  assertCapability(actor.role as never, capability, message);
  if (!(await isSaleValidatorAuthorized(actor))) throw new TRPCError({ code: "FORBIDDEN", message: "Seu usuário não tem a concessão de administrativo autorizado para validar vendas. Peça à administração." });
}

export async function isSegregationEnabled(db: Pick<Reader, "select">) {
  const [row] = await db.select().from(captureSheetSettings).where(eq(captureSheetSettings.key, SEGREGATION_KEY)).limit(1);
  return row?.value === "1";
}
