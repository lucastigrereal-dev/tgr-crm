import { beforeEach, describe, expect, it, vi } from "vitest";
import { contractCancellationRequests, contracts, installments, opportunities, proposals, revenueQualityLedger, salesCommissions, unitMaintenanceBlocks } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";
import { ownershipRouter } from "./routers/ownership";
import { salesRouter } from "./routers/sales";

function makeDb() {
  const installment = { id: 91, contractId: 61, sequence: 2, totalAmount: "1000.00", amount: "1000.00", status: "open", dueDate: new Date("2026-09-10T12:00:00Z") };
  const queryRows = (value: unknown[]) => {
    const chain = {
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      for: async () => value,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(value).then(resolve, reject),
    };
    return chain;
  };
  const tx = {
    select: vi.fn(() => ({ from: (table: unknown) => table === unitMaintenanceBlocks ? queryRows([]) : queryRows([{ id: 51 }]) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 901 }] })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
  };
  let id = 300;
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: id++ }], onDuplicateKeyUpdate: async () => undefined })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === unitMaintenanceBlocks) return queryRows([]);
        if (table === contracts) return queryRows([{ id: 61, totalAmount: "1000.00", status: "active" }]);
        if (table === opportunities) return queryRows([{ id: 301, stage: "qualified" }]);
        if (table === proposals) return queryRows([]);
        if (table === installments) return queryRows([installment]);
        if (table === salesCommissions || table === contractCancellationRequests) return queryRows([]);
        if (table === revenueQualityLedger) return queryRows([]);
        return queryRows([installment]);
      },
    })),
  };
}

const adminContext = { user: { id: 71, role: "admin" } } as never;
const serviceContext = { user: { id: 72, role: "service" } } as never;

describe("emissores catalogados de comercial, financeiro e ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getDb.mockResolvedValue(makeDb());
  });

  it("emite os fatos comerciais com agregado, ator e payload", async () => {
    const caller = salesRouter.createCaller(adminContext);
    await caller.createPlaybook({ name: "Qualificação do tour", stage: "qualified", guidance: "Validar perfil, disponibilidade e intenção real de compra.", checklist: "Confirmar perfil\nRegistrar objeção" });
    await caller.createOpportunity({ customerId: 10, title: "Tour família", expectedAmount: 12000, stage: "qualified" });
    await caller.createProposal({ opportunityId: 301, reference: "PROP-301", productDescription: "Cota anual", totalAmount: 12000, downPaymentAmount: 0, installmentCount: 1, status: "sent" });

    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "sales.playbook.created", aggregateType: "sales_playbook", actorUserId: 71, payload: { stage: "qualified", name: "Qualificação do tour" } }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "opportunity.created", aggregateType: "opportunity", actorUserId: 71, payload: expect.objectContaining({ sellerId: 71, stage: "qualified", expectedAmount: 12000 }) }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "proposal.created", aggregateType: "proposal", actorUserId: 71, payload: expect.objectContaining({ opportunityId: 301, status: "sent", totalAmount: 12000 }) }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(71, "proposal", expect.any(Number), "created", expect.stringContaining("PROP-301"));
  });

  it("emite eventos financeiros para acordo, baixa, lançamento e repasse", async () => {
    const caller = financeRouter.createCaller(adminContext);
    await caller.createRenegotiation({ installmentId: 91, proposedAmount: 900, proposedDueDate: "2026-10-10" });
    await caller.markInstallmentPaid({ id: 91 });
    await caller.createEntry({ type: "income", category: "Taxa", description: "Taxa operacional", amount: 125, status: "paid" });
    await caller.createTransfer({ beneficiaryName: "Parceiro Operacional", amount: 250, dueDate: "2026-09-20" });

    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "installment.renegotiation.proposed", aggregateType: "installment_renegotiation", actorUserId: 71, payload: { installmentId: 91, proposedAmount: 900 } }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "installment.paid", aggregateType: "installment", aggregateId: 91, actorUserId: 71, payload: expect.objectContaining({ contractId: 61, sequence: 2 }) }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "financial.entry.created", aggregateType: "financial_transaction", actorUserId: 71, payload: expect.objectContaining({ category: "Taxa", amount: 125 }) }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "financial.transfer.created", aggregateType: "financial_transfer", actorUserId: 71, payload: expect.objectContaining({ beneficiaryName: "Parceiro Operacional", amount: 250 }) }));
  });

  it("emite e audita direito de uso e bloqueio operacional de unidade", async () => {
    await ownershipRouter.createCaller(adminContext).createEntitlement({ contractId: 61, entitlementType: "fixed_week", fixedWeek: 12, annualPoints: 0, priorityLevel: 2 });
    await ownershipRouter.createCaller(serviceContext).createMaintenanceBlock({ unitId: 51, startsAt: "2026-10-10", endsAt: "2026-10-12", reason: "Manutenção preventiva" });

    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "ownership.entitlement.created", aggregateType: "ownership_entitlement", actorUserId: 71, payload: { contractId: 61, entitlementType: "fixed_week" } }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "unit.maintenance.blocked", aggregateType: "unit_maintenance_block", actorUserId: 72, payload: expect.objectContaining({ unitId: 51, reason: "Manutenção preventiva" }) }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(72, "unit_maintenance_block", expect.any(Number), "created", expect.stringContaining("Manutenção preventiva"));
  });
});
