// PKG-FIN-03: o Financial só conhecia a parcela quando ela era PAGA; sem o "a receber" cadastrado antes não existe atraso.
// `installment.scheduled` avisa cada parcela em aberto (id, contrato, associado, nº, vencimento, valor) dentro da MESMA
// transação que criou ou reajustou a parcela. A chave de idempotência inclui vencimento e valor: repetir o mesmo estado
// não duplica; mudar data ou valor gera um evento novo, que o Financial aplica enquanto a parcela estiver pendente.
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { contracts, installments } from "../drizzle/schema";
import { txEvent, type Tx } from "./txOutbox";

const isoDate = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

/** `transition` identifica a mudança que gerou o aviso (ex.: id do reajuste): voltar a um valor antigo (100 -> 110 -> 100) não colide com o aviso original. */
export const installmentScheduledKey = (installmentId: number, dueDate: string, amount: string, transition?: string) => `installment-scheduled:${installmentId}:${dueDate}:${amount}${transition ? `:${transition}` : ""}`;

/** Emite 1 evento por parcela aberta ou vencida do contrato (ou só das `onlyIds`). Parcela paga ou cancelada, e contrato cancelado ou encerrado (ex.: importação CSV com status livre), não são reagendados. */
export async function recordInstallmentsScheduled(tx: Tx, input: { contractId: number; actorUserId: number | null; onlyIds?: number[]; transition?: string }) {
  if (input.onlyIds && input.onlyIds.length === 0) return 0;
  const rows = await tx.select({ id: installments.id, sequence: installments.sequence, dueDate: installments.dueDate, amount: installments.amount, paidAmount: installments.paidAmount, customerId: contracts.customerId })
    .from(installments).innerJoin(contracts, eq(contracts.id, installments.contractId))
    .where(and(eq(installments.contractId, input.contractId), inArray(installments.status, ["open", "overdue"]), notInArray(contracts.status, ["cancelled", "closed"]), ...(input.onlyIds ? [inArray(installments.id, input.onlyIds)] : [])))
    .orderBy(asc(installments.sequence));
  let emitted = 0;
  for (const row of rows) {
    const dueDate = isoDate(row.dueDate);
    // "A receber" é o saldo em aberto: parcela com recebimento parcial (entrada do Sales) anuncia o que falta, não o valor cheio.
    const amount = (Number(row.amount) - Number(row.paidAmount ?? 0)).toFixed(2);
    if (Number(amount) <= 0) continue;
    await txEvent(tx, {
      eventName: "installment.scheduled", aggregateType: "installment", aggregateId: row.id, actorUserId: input.actorUserId,
      payload: { installmentId: row.id, contractId: input.contractId, customerId: row.customerId, sequence: row.sequence, dueDate, amount },
      idempotencyKey: installmentScheduledKey(row.id, dueDate, amount, input.transition),
    });
    emitted += 1;
  }
  return emitted;
}
