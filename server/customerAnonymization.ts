import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { customers } from "../drizzle/schema";
import type { getDb } from "./db";

/**
 * Guarda única da anonimização (LGPD art. 18, CRM-A18): cliente com `customers.anonymizedAt` não recebe mais dado pessoal por nenhum
 * caminho de escrita (cadastro, contatos, interações, documentos, captação, importação CSV). Sem esta guarda, uma edição comum
 * desfaria a anonimização. Dentro de transação, passe `lock: true`: a leitura trava a linha e serializa com o pedido de exclusão.
 */
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const ANONYMIZED_CUSTOMER_MESSAGE = "Cliente anonimizado a pedido do titular: não aceita novos dados pessoais.";

export const anonymizedCustomerError = () => new TRPCError({ code: "PRECONDITION_FAILED", message: ANONYMIZED_CUSTOMER_MESSAGE });

export async function assertCustomerNotAnonymized(executor: Db | Tx, customerId: number, options: { lock?: boolean } = {}) {
  const query = executor.select({ anonymizedAt: customers.anonymizedAt }).from(customers).where(eq(customers.id, customerId)).limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  if (row?.anonymizedAt) throw anonymizedCustomerError();
}
