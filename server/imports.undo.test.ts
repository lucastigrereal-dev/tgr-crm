import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingRecords, contractDocuments, contracts, csvImportBatches, csvImportItems, customers, financialTransactions, installments, ownershipEntitlements, reservationWaitlist, reservations, resorts, tasks, unitMaintenanceBlocks, units } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { importsRouter } from "./routers/imports";

type Batch = { id: number; kind: "customers" | "contracts" | "units"; status: "completed" | "reverted" };
type Item = { entityType: "customer" | "contract" | "resort" | "unit"; entityId: number; action: "created" | "updated"; beforeSnapshot: string | null };

function makeDb(batch: Batch, items: Item[], contractDependencies: Array<{ id: number }> = [], options: { installments?: Array<{ id: number }>; documents?: Array<{ id: number }>; reservations?: Array<{ id: number }>; tasks?: Array<{ id: number }>; financial?: Array<{ id: number }>; billings?: Array<{ id: number }>; entitlements?: Array<{ id: number }>; maintenance?: Array<{ id: number }>; waitlist?: Array<{ id: number }>; units?: Array<{ id: number }> } = {}) {
  const deletes: unknown[] = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === csvImportBatches) return { orderBy: () => ({ limit: () => Object.assign(Promise.resolve([batch]), { for: async () => [batch] }) }) };
        return {
        where: () => {
          if (table === csvImportItems) return items;
          if (table === contracts) return contractDependencies;
          if (table === installments) return options.installments ?? [];
          if (table === contractDocuments) return options.documents ?? [];
          if (table === reservations) return options.reservations ?? [];
          if (table === tasks) return options.tasks ?? [];
          if (table === financialTransactions) return options.financial ?? [];
          if (table === billingRecords) return options.billings ?? [];
          if (table === ownershipEntitlements) return options.entitlements ?? [];
          if (table === unitMaintenanceBlocks) return options.maintenance ?? [];
          if (table === reservationWaitlist) return options.waitlist ?? [];
          if (table === units) return options.units ?? [];
          return [];
        },
      };
      },
    })),
    delete: vi.fn((table: unknown) => ({ where: vi.fn(() => { deletes.push(table); return Promise.resolve(); }) })),
    update: vi.fn((table: unknown) => ({ set: vi.fn((values: unknown) => ({ where: vi.fn(() => { updates.push({ table, values }); return Promise.resolve(); }) })) })),
  };
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === csvImportBatches) return { orderBy: () => ({ limit: () => [batch] }) };
        if (table === csvImportItems) return { where: () => items };
        throw new Error("Tabela de leitura não prevista no teste");
      },
    })),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
  };
  return { db, deletes, updates };
}

function adminCaller() {
  return importsRouter.createCaller({ user: { id: 9, role: "admin" } } as never);
}

describe("imports.undoLast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("remove associados criados no último lote e marca a reversão de forma auditável", async () => {
    const fixture = makeDb({ id: 81, kind: "customers", status: "completed" }, [
      { entityType: "customer", entityId: 101, action: "created", beforeSnapshot: null },
    ]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(adminCaller().undoLast({ confirm: true })).resolves.toEqual({ batchId: 81, revertedItems: 1, kind: "customers" });
    expect(fixture.deletes).toContain(customers);
    expect(fixture.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: csvImportBatches, values: expect.objectContaining({ status: "reverted", revertedByUserId: 9 }) }),
    ]));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "csv_import", 81, "reverted", expect.stringContaining("1 item"));
  });

  it("restaura o snapshot do associado atualizado em vez de apagá-lo", async () => {
    const snapshot = JSON.stringify({ fullName: "Ana Original", documentNumber: "12345678900", email: "ana@exemplo.com", status: "active", city: "Olímpia", state: "SP" });
    const fixture = makeDb({ id: 82, kind: "customers", status: "completed" }, [
      { entityType: "customer", entityId: 102, action: "updated", beforeSnapshot: snapshot },
    ]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await adminCaller().undoLast({ confirm: true });

    expect(fixture.deletes).not.toContain(customers);
    expect(fixture.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: customers, values: expect.objectContaining({ fullName: "Ana Original", documentNumber: "12345678900", status: "active", city: "Olímpia" }) }),
    ]));
  });

  it("bloqueia a reversão de associado que já ganhou contrato dependente", async () => {
    const fixture = makeDb(
      { id: 83, kind: "customers", status: "completed" },
      [{ entityType: "customer", entityId: 103, action: "created", beforeSnapshot: null }],
      [{ id: 501 }],
    );
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(adminCaller().undoLast({ confirm: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fixture.deletes).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  it("remove contrato importado e suas parcelas quando não há dependências operacionais", async () => {
    const fixture = makeDb(
      { id: 84, kind: "contracts", status: "completed" },
      [{ entityType: "contract", entityId: 701, action: "created", beforeSnapshot: null }],
      [],
      { installments: [{ id: 9001 }, { id: 9002 }] },
    );
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(adminCaller().undoLast({ confirm: true })).resolves.toEqual({ batchId: 84, revertedItems: 1, kind: "contracts" });

    expect(fixture.deletes).toEqual(expect.arrayContaining([installments, contracts]));
    expect(fixture.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: csvImportBatches, values: expect.objectContaining({ status: "reverted", revertedByUserId: 9 }) }),
    ]));
  });

  it("bloqueia contrato importado quando já existe qualquer dependência operacional", async () => {
    const fixture = makeDb(
      { id: 85, kind: "contracts", status: "completed" },
      [{ entityType: "contract", entityId: 702, action: "created", beforeSnapshot: null }],
      [],
      { installments: [{ id: 9003 }], documents: [{ id: 3001 }], reservations: [{ id: 4001 }], tasks: [{ id: 5001 }], financial: [{ id: 6001 }], billings: [{ id: 7001 }] },
    );
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(adminCaller().undoLast({ confirm: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fixture.deletes).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  it("remove unidade importada sem dependência operacional", async () => {
    const fixture = makeDb({ id: 86, kind: "units", status: "completed" }, [
      { entityType: "unit", entityId: 801, action: "created", beforeSnapshot: null },
    ]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(adminCaller().undoLast({ confirm: true })).resolves.toEqual({ batchId: 86, revertedItems: 1, kind: "units" });

    expect(fixture.deletes).toContain(units);
    expect(fixture.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: csvImportBatches, values: expect.objectContaining({ status: "reverted", revertedByUserId: 9 }) }),
    ]));
  });

  it("bloqueia reversão de unidade que já ganhou reserva", async () => {
    const fixture = makeDb(
      { id: 87, kind: "units", status: "completed" },
      [{ entityType: "unit", entityId: 802, action: "created", beforeSnapshot: null }],
      [],
      { reservations: [{ id: 4301 }] },
    );
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(adminCaller().undoLast({ confirm: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fixture.deletes).toEqual([]);
  });
});
